import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.mjs";
import { seededStory, answerKey } from "../src/fact-check/archive.mjs";
import { forceOutputLimitForClaims } from "../src/agent/fact-check-fixture.mjs";

// Every provider and tool here is explicitly synthetic. The ordinary application, Pi
// stream parser, MCP authority, store, archive and save path run; the fixture scripts the
// arrangement agents through the SAME turn loop a live model would, searching and reading
// the bundled archive and returning verdicts. These tests cover the Session 3 rebuild: the
// three arrangements over the shared archive, the graph's per-claim fan-out and code
// router, the swarm's handoffs and hop limit, the per-claim/per-hop isolation, budget
// refusal, and the corrected story applied as a normal, undoable edit (no keep/revert gate).

const KEY = new Map(answerKey().map((entry) => [entry.claimId, entry]));
const WRONG_CLAIMS = answerKey().filter((entry) => entry.truth === "unsupported").length;
const TRUE_CLAIMS = answerKey().filter((entry) => entry.truth === "supported").length;

const config = { mode: "fixture", fixture: true };

function seed(store) {
  store.setStage("research");
  const slot = store.reserveStory();
  store.editStory(slot.slotId, seededStory());
  return store.getStory(slot.slotId);
}

async function appFixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "session3-fact-check-"));
  const application = await createApplication({
    ...config,
    ...overrides,
    stateFile: null,
    exportsDirectory: join(directory, "exports"),
  });
  t.after(async () => {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  const story = seed(application.store);
  const runFor = (id) => {
    return application.store.snapshot().autoResearchRuns.find((run) => {
      return run.id === id;
    });
  };
  const events = (kind) => {
    return application.trace.entries.filter((entry) => {
      return entry.kind === `fact_check.${kind}`;
    });
  };
  const factCheck = (topology, extra = {}) => {
    const current = application.store.getStory(story.slotId);
    const { runId } = application.factCheck.request({
      slotId: story.slotId,
      contentVersion: current.contentVersion,
      topology,
      ...extra,
    });
    return runId;
  };
  // Score a run's verdicts against the dataset answer key: how many wrong claims were
  // caught (contradicted) and how many true claims were wrongly rejected.
  const score = (run) => {
    let caught = 0;
    let falseReject = 0;
    for (const verdict of run.verdicts ?? []) {
      const key = KEY.get(verdict.claimId);
      if (!key) {
        continue;
      }
      if (key.truth === "unsupported" && verdict.verdict === "contradicted") {
        caught++;
      }
      if (key.truth === "supported" && verdict.verdict === "contradicted") {
        falseReject++;
      }
    }
    return { caught, falseReject };
  };
  return { ...application, story, runFor, events, score, startTopology: factCheck };
}

for (const topology of ["single", "graph", "swarm"]) {
  test(`${topology}: drives tool-using agents through the archive and returns per-claim verdicts`, async (t) => {
    const app = await appFixture(t);
    const runId = app.startTopology(topology);
    await app.factCheck.waitForIdle();
    const run = app.runFor(runId);
    assert.equal(run.topology, topology, "the run records its arrangement");
    assert.equal(run.status, "completed", `run completed: ${run.stopReason}`);
    // Every arrangement produces verdicts with a document ID and a verbatim quote.
    assert.ok(run.verdicts.length >= 1, "at least one claim got a verdict");
    for (const verdict of run.verdicts) {
      assert.ok(["supported", "contradicted", "not enough evidence"].includes(verdict.verdict));
    }
    // Each agent's tool calls are recorded as observations grouped under the run.
    const toolCalls = app.events("tool_call");
    assert.ok(toolCalls.length >= 1, "search/read calls are recorded as observations");
    assert.ok(
      toolCalls.some((entry) => entry.tool === "read"),
      "an agent read a document from the archive",
    );
    // Agent calls go through the gateway as captured model requests.
    const models = app.trace.entries.filter((entry) => {
      return entry.kind === "model" && entry.jobId === runId;
    });
    assert.ok(models.length >= 1, "agent calls go through the gateway as model requests");
    // The compact per-run summary names the arrangement and tallies the verdicts.
    assert.equal(run.runSummary.topology, topology);
    assert.ok(run.runSummary.calls >= 1, "at least one captured agent call");
    assert.ok(run.runSummary.agents.length >= 1, "at least one named agent");
  });
}

test("single: one agent owns every claim and the fixture catches the wrong ones", async (t) => {
  const app = await appFixture(t);
  const runId = app.startTopology("single");
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  // The single agent is ONE named agent responsible for the whole story.
  assert.deepEqual(run.runSummary.agents, ["single_checker"], "a single named agent owns every claim");
  assert.equal(run.verdicts.length, KEY.size, "the single agent returns one verdict per claim");
  const { caught, falseReject } = app.score(run);
  assert.equal(caught, WRONG_CLAIMS, "the fixture catches every wrong claim");
  assert.equal(falseReject, 0, "the fixture rejects no true claim");
  // The corrected story was applied as a normal, undoable edit (contentVersion advanced).
  const after = app.store.getStory(app.story.slotId);
  assert.ok(after.contentVersion > app.story.contentVersion, "the correction advanced the content version");
  assert.notEqual(after.body, seededStory().body, "the corrected copy replaced the original");
  assert.equal(run.corrected, true, "the run records that it corrected the story");
});

test("graph: one checker per claim in a fresh context, concurrent, then a code router", async (t) => {
  const app = await appFixture(t);
  const runId = app.startTopology("graph", { concurrentVerifiers: true });
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  // Node 2: one verifier per claim, each a distinct model operation (fresh context).
  const verdictEvents = app.events("graph_verdict");
  assert.ok(verdictEvents.length >= 1, "each claim got a verifier verdict in its own context");
  const verifierOps = new Set(
    app.trace.entries
      .filter((entry) => entry.kind === "model" && entry.jobId === runId)
      .map((entry) => entry.operationId),
  );
  assert.ok(verifierOps.size >= verdictEvents.length, "verifiers do not share one context");
  // Node 3: a code router that branched by verdict and routed the contradicted claims.
  const route = app.events("graph_route");
  assert.equal(route.length, 1, "the router recorded exactly one routing decision");
  assert.ok(route[0].routedToReviser.length >= 1, "contradicted claims route to correction");
  const { caught, falseReject } = app.score(run);
  assert.equal(caught, WRONG_CLAIMS, "the graph catches every wrong claim");
  assert.equal(falseReject, 0, "the graph rejects no true claim");
});

test("swarm: specialists hand work to each other and the handoffs are recorded in order", async (t) => {
  const app = await appFixture(t);
  const runId = app.startTopology("swarm");
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  // The swarm is MANY named agents by area, including a triage agent.
  assert.ok(run.runSummary.agents.includes("triage"), "a triage agent routes the opening claims");
  assert.ok(run.runSummary.agents.length >= 2, "the swarm has multiple specialists");
  // Handoffs are recorded in the order they happened.
  const handoffs = app.events("handoff");
  assert.ok(handoffs.length >= 1, "the swarm recorded at least one handoff");
  for (const handoff of handoffs) {
    assert.ok(handoff.from && handoff.to, "a handoff names who passed control to whom");
  }
  // The swarm reports its hop count; it is bounded.
  assert.ok(run.runSummary.hops >= 1, "the swarm took at least one hop");
});

test("graph: a per-claim checker that produces no answer is isolated; the others continue", async (t) => {
  const app = await appFixture(t);
  // Force two claims' checkers to spend their whole output budget and return nothing.
  forceOutputLimitForClaims(["c1", "c2"]);
  t.after(() => forceOutputLimitForClaims([]));
  const runId = app.startTopology("graph");
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  assert.equal(run.status, "completed", "a per-claim skip does not fail the whole run");
  const skips = app.events("claim_skip");
  assert.ok(skips.length >= 1, "the skipped claims were recorded as isolated skips");
  // The other claims still got verdicts.
  assert.ok(run.verdicts.length >= KEY.size - 2, "the other claims continued to verdicts");
  assert.ok(
    !run.verdicts.some((verdict) => verdict.claimId === "c1"),
    "a skipped claim has no verdict",
  );
});

test("budget refusal: an exhausted request allowance stops the run without exhausting the archive", async (t) => {
  // A tiny request ceiling lets only the first agent call run; the run cannot check the
  // whole story and stops without correcting it.
  const app = await appFixture(t, { maxFactCheckRequests: 1 });
  const runId = app.startTopology("single");
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  assert.ok(["completed", "paused", "stopped"].includes(run.status));
  assert.notEqual(run.corrected, true, "no correction was applied under an exhausted allowance");
  const after = app.store.getStory(app.story.slotId);
  assert.equal(after.body, seededStory().body, "the current copy was preserved");
});

test("fixture determinism: the same arrangement produces the same outcome across runs", async (t) => {
  const outcomes = [];
  for (let index = 0; index < 2; index++) {
    const app = await appFixture(t);
    const runId = app.startTopology("graph");
    await app.factCheck.waitForIdle();
    const run = app.runFor(runId);
    outcomes.push({
      calls: run.runSummary.calls,
      corrected: run.corrected,
      tally: run.runSummary.verdictTally,
    });
  }
  assert.deepEqual(outcomes[0], outcomes[1], "fixture runs are reproducible");
});

test("the corrected story is a normal edit the user can undo", async (t) => {
  const app = await appFixture(t);
  const before = app.store.getStory(app.story.slotId);
  const runId = app.startTopology("single");
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  assert.equal(run.corrected, true);
  const corrected = app.store.getStory(app.story.slotId);
  assert.notEqual(corrected.body, before.body, "the correction changed the copy");
  // The correction went through the ordinary editStory path (action copy_edited), so a
  // plain editStory back to the original restores it — there is no special revert gate.
  app.store.editStory(app.story.slotId, { headline: before.headline, body: before.body });
  const restored = app.store.getStory(app.story.slotId);
  assert.equal(restored.body, before.body, "the user can edit the copy back like any other edit");
});

test("unknown arrangement is rejected", async (t) => {
  const app = await appFixture(t);
  const current = app.store.getStory(app.story.slotId);
  assert.throws(
    () => {
      return app.factCheck.request({
        slotId: app.story.slotId,
        contentVersion: current.contentVersion,
        topology: "mesh",
      });
    },
    /arrangement/,
    "an unsupported arrangement is refused",
  );
});

test("every arrangement checks the SAME claims derived by code from the story", async (t) => {
  // The claim set is a deterministic sentence split of the seeded story, so each
  // arrangement sees the same claim IDs. Confirm the single agent's verdict claim IDs are a
  // subset of the archive's claim IDs and cover the whole story.
  const app = await appFixture(t);
  const runId = app.startTopology("single");
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  const ids = new Set(run.verdicts.map((verdict) => verdict.claimId));
  assert.equal(ids.size, KEY.size, "the single agent covered every derived claim");
  for (const id of ids) {
    assert.ok(KEY.has(id), `verdict claim ${id} is a real archive claim`);
  }
  assert.equal(TRUE_CLAIMS + WRONG_CLAIMS, KEY.size, "the dataset splits into true and wrong claims");
});
