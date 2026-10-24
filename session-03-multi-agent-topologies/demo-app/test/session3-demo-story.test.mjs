import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.mjs";
import { seededStory } from "../src/fact-check/archive.mjs";
import { buildEditorialInput } from "../src/editorial.mjs";

// "Load demo story" places the bundled library-system story on the page so a live
// demo can fact-check it. Fixture mode only; no model or source calls.

async function appFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "session3-demo-story-"));
  const application = await createApplication({
    mode: "fixture",
    fixture: true,
    stateFile: null,
    exportsDirectory: join(directory, "exports"),
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
  return { ...application, tool };
}

test("load_demo_story places the bundled story as ready, fixed, editable copy", async (t) => {
  const app = await appFixture(t);
  const { slotId, created } = await app.tool("load_demo_story");
  assert.equal(created, true);
  const story = app.store.getStory(slotId);
  const expected = seededStory();
  assert.equal(story.headline, expected.headline);
  assert.equal(story.body, expected.body);
  assert.equal(story.status, "ready", "long archive copy is not marked overflowing");
  assert.equal(story.fixedCopy, true);
  assert.equal(story.locked, false);
  assert.deepEqual(story.frame, { x: 12, y: 44, width: 273, height: 350 }, "an empty page gets a full-page frame");
});

test("a second load on a full page is refused and leaves the first story alone", async (t) => {
  const app = await appFixture(t);
  await app.tool("load_demo_story");
  const response = await app.mcp.callTool("load_demo_story", {});
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /page is full/i);
  assert.equal(app.store.snapshot().issue.stories.length, 1);
});
test("copy fitting never rewrites the loaded story", async (t) => {
  const app = await appFixture(t);
  const { slotId } = await app.tool("load_demo_story");
  const story = app.store.getStory(slotId);
  const fit = app.agent.reportRenderedFit({
    issueId: app.store.snapshot().issue.id,
    slotId,
    contentVersion: story.contentVersion,
    overflow: true,
    requiredHeight: 9999,
  });
  assert.equal(fit.accepted, false);
  assert.equal(app.store.getStory(slotId).body, seededStory().body);
});

test("the loaded story can be fact-checked by the single agent", async (t) => {
  const app = await appFixture(t);
  const { slotId } = await app.tool("load_demo_story");
  const { runId } = await app.tool("request_fact_check", {
    slotId,
    contentVersion: app.store.getStory(slotId).contentVersion,
    topology: "single",
  });
  const deadline = Date.now() + 60_000;
  let run;
  while (Date.now() < deadline) {
    run = app.store.snapshot().autoResearchRuns.find((entry) => entry.id === runId);
    if (run && !["queued", "running"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(run?.status, "completed", JSON.stringify(run?.stopReason ?? run));
  assert.ok((run.verdicts ?? []).length > 0, "the run returned verdicts");
  assert.notEqual(app.store.getStory(slotId).body, seededStory().body, "the corrected copy was applied");
});

test("the editorial review leaves the loaded story out, so no decision request is sent for it", async (t) => {
  const app = await appFixture(t);
  await app.tool("load_demo_story");
  assert.equal(Object.keys(buildEditorialInput(app.store.snapshot()).items).length, 0);
  await app.tool("editorialize_board", { reason: "editor_requested_review" });
  assert.notEqual(app.store.snapshot().editorial?.status, "failed", "no editorial request is attempted");
});

test("ordinary stories beside the loaded story are still reviewed", async (t) => {
  const app = await appFixture(t);
  const written = app.store.reserveStory();
  app.store.editStory(written.slotId, { headline: "Branch hours", body: "The Juniper branch opens at nine." });
  await app.tool("load_demo_story");
  assert.equal(app.store.snapshot().issue.stories.length, 2);
  assert.deepEqual(Object.keys(buildEditorialInput(app.store.snapshot()).items), [written.slotId]);
});
test("the loaded story carries its planted errors, and a run records which were caught", async (t) => {
  const app = await appFixture(t);
  const { slotId } = await app.tool("load_demo_story");
  const story = app.store.getStory(slotId);
  const wrong = seededStory().plantedClaims;
  assert.ok(wrong.length > 0);
  assert.deepEqual(story.plantedClaims.map((claim) => claim.id), wrong.map((claim) => claim.id));
  for (const claim of story.plantedClaims) assert.ok(story.body.includes(claim.text), claim.id);
  assert.equal(story.plantedResult, null);
  const { runId } = await app.tool("request_fact_check", { slotId, contentVersion: story.contentVersion, topology: "graph" });
  const deadline = Date.now() + 120_000;
  let run;
  while (Date.now() < deadline) {
    run = app.store.snapshot().autoResearchRuns.find((entry) => entry.id === runId);
    if (run && !["queued", "running"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(run?.status, "completed");
  const after = app.store.getStory(slotId);
  assert.equal(after.plantedResult.topology, "graph");
  assert.equal(after.plantedResult.claims.length, wrong.length);
  for (const claim of after.plantedResult.claims) {
    assert.ok(["caught", "missed"].includes(claim.status));
    assert.ok(after.body.includes(claim.text), `${claim.id} ${claim.status} text is findable in the body`);
  }
  assert.ok(after.plantedResult.claims.some((claim) => claim.status === "caught"));
});