import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.mjs";
import { answerKey } from "../src/fact-check/archive.mjs";
import { retryableTurnError } from "../src/topologies.mjs";

// A provider-side failure on one call ("The provider reported a failed completion") must
// cost that call a retry, not stop the whole fact-check. Fixture mode only; the failure is
// a synthetic broker refusal injected through the fixtureChat seam.

const CLAIMS = answerKey().length;

function brokerFailure(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message, retryable: false, details: { providerError: { code: 502 } } } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function appFixture(t, failOn) {
  const directory = await mkdtemp(join(tmpdir(), "session3-provider-failure-"));
  let calls = 0;
  const application = await createApplication({
    mode: "fixture",
    fixture: true,
    stateFile: null,
    exportsDirectory: join(directory, "exports"),
    fixtureChat: () => {
      calls++;
      return failOn(calls) ?? undefined;
    },
  });
  t.after(async () => {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  application.store.setStage("research");
  const tool = async (name, args = {}) => {
    const response = await application.mcp.callTool(name, args);
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    return response.structuredContent;
  };
  return { ...application, tool, calls: () => calls };
}

async function runTopology(app, topology) {
  const { slotId } = await app.tool("load_demo_story");
  const { runId } = await app.tool("request_fact_check", {
    slotId,
    contentVersion: app.store.getStory(slotId).contentVersion,
    topology,
  });
  const deadline = Date.now() + 120_000;
  let run;
  while (Date.now() < deadline) {
    run = app.store.snapshot().autoResearchRuns.find((entry) => entry.id === runId);
    if (run && !["queued", "running"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return run;
}

test("provider failures are retryable turns; allowance and permanent refusals are not", () => {
  assert.equal(retryableTurnError({ code: "UPSTREAM_UNCERTAIN" }), true);
  assert.equal(retryableTurnError({ code: "UPSTREAM_FAILED" }), true);
  assert.equal(retryableTurnError({ code: "UPSTREAM_FAILED", permanent: true }), false);
  assert.equal(retryableTurnError({ code: "ALLOWANCE_EXHAUSTED", permanent: true }), false);
  assert.equal(retryableTurnError({ code: "TURN_LIMIT" }), false);
  // Mid-stream provider failure, as the SDK stream path reports it.
  assert.equal(retryableTurnError({ code: "INFERENCE_FAILED", message: "The provider reported a failed completion" }), true);
  assert.equal(retryableTurnError({ code: "INFERENCE_FAILED", message: "The provider stream exceeds its byte limit" }), false);
  assert.equal(retryableTurnError({ code: "SUPERSEDED" }), false);
});

test("one failed provider completion in the graph is retried and the run finishes", async (t) => {
  const app = await appFixture(t, (n) =>
    n === 5 ? brokerFailure(502, "UPSTREAM_UNCERTAIN", "The provider reported a failed completion") : null);
  const run = await runTopology(app, "graph");
  assert.equal(run?.status, "completed", JSON.stringify(run?.stopReason ?? run));
  assert.equal(run.verdicts.length, CLAIMS, "every claim still got a verdict");
});

test("one failed provider completion in the single agent is retried and the run finishes", async (t) => {
  const app = await appFixture(t, (n) =>
    n === 2 ? brokerFailure(502, "UPSTREAM_UNCERTAIN", "The provider reported a failed completion") : null);
  const run = await runTopology(app, "single");
  assert.equal(run?.status, "completed", JSON.stringify(run?.stopReason ?? run));
  assert.ok(run.verdicts.length > 0);
});

test("an exhausted allowance still stops the run", async (t) => {
  const app = await appFixture(t, (n) =>
    n >= 3 ? brokerFailure(402, "ALLOWANCE_EXHAUSTED", "The allowance is exhausted") : null);
  const run = await runTopology(app, "graph");
  assert.notEqual(run?.status, "completed");
  assert.ok(app.calls() < 12, `stopped promptly instead of retrying (${app.calls()} calls)`);
});
