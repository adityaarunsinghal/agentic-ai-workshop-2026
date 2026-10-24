import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.mjs";
import { seededStory } from "../src/fact-check/archive.mjs";

// A recorded run applies its corrections to the demo story. The next recorded run must still
// match its recording, so the harness restores the original demo copy before replaying. This
// is the single-then-graph sequence a presenter runs without resetting the newspaper.
test("demo mode: a graph replay after a single replay matches its recording", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "session3-demo-rerun-"));
  const app = await createApplication({
    mode: "fixture",
    fixture: true,
    stateFile: null,
    demoReplayPacing: false,
    exportsDirectory: join(directory, "exports"),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  app.store.setStage("research");
  app.store.setDemoMode(true);
  const story = app.store.placeFixedStory(seededStory());
  const runOnce = async (topology) => {
    const current = app.store.getStory(story.slotId);
    const { runId } = app.factCheck.request({
      slotId: story.slotId,
      contentVersion: current.contentVersion,
      topology,
    });
    await app.factCheck.waitForIdle();
    return app.store.snapshot().autoResearchRuns.find((run) => run.id === runId);
  };
  const single = await runOnce("single");
  assert.equal(single.status, "completed", single.stopReason);
  assert.notEqual(app.store.getStory(story.slotId).body, seededStory().body, "single applied corrections");
  const graph = await runOnce("graph");
  assert.equal(graph.status, "completed", graph.stopReason);
  assert.equal(graph.verdicts.length, 160);
  assert.equal(typeof graph.recordedCostUsd, "number", "the recorded live cost is shown for the replay");
  assert.ok(graph.endedAt, "a settled run carries its end time so the board clock stops");
});
