import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.mjs";
import { answerKey, seededStory } from "../src/fact-check/archive.mjs";
import { hasRecording } from "../src/fact-check/demo-replay.mjs";

// The Session 3 demo toggle. With demo mode on, a fact-check on the bundled demo story runs
// the SAME harness and topology code but answers every model call from the recorded GPT-6
// Luna run for that arrangement: no broker request, no reservation, zero cost. These tests
// pin the three recorded runs to their exact scores and prove the gateway is never called.
// Demo mode off is ordinary real execution; the existing session3-fact-check suite covers it.

const KEY = new Map(answerKey().map((entry) => [entry.claimId, entry]));

// The recorded scores, from the live runs the recording was built from.
const EXPECTED = {
  single: { caught: 33, falseReject: 5, verdicts: 160 },
  graph: { caught: 78, falseReject: 0, verdicts: 160 },
  swarm: { caught: 0, falseReject: 0, verdicts: 40 },
};

async function demoApp(t) {
  const directory = await mkdtemp(join(tmpdir(), "session3-demo-replay-"));
  // mode "development" would need a broker; "fixture" gives an offline gateway whose ready()
  // and completeText both resolve without a network. The replay never calls completeText, so
  // the spy below must stay at zero; the fixture gateway only backstops gateway.ready().
  const application = await createApplication({
    mode: "fixture",
    fixture: true,
    stateFile: null,
    // Tests run the replay at full speed; the per-call pacing delays are a demo UX feature,
    // not part of the scores or the zero-call guarantee being asserted here.
    demoReplayPacing: false,
    exportsDirectory: join(directory, "exports"),
  });
  t.after(async () => {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });

  // Count any call that reaches the real gateway's model boundary. A replayed run must leave
  // this at zero: every fact_check call is answered from the recording instead.
  let gatewayCalls = 0;
  const realCompleteText = application.gateway.completeText.bind(application.gateway);
  application.gateway.completeText = (...args) => {
    gatewayCalls++;
    return realCompleteText(...args);
  };

  application.store.setStage("research");
  const placed = application.store.setDemoMode(true);
  // setDemoMode persists the flag; the MCP tool places the story. Place it directly here.
  const demo = application.store.snapshot().issue.stories.find((story) => {
    return story.fixedCopy && (story.plantedClaims?.length ?? 0) > 0;
  });
  const story = demo ?? application.store.placeFixedStory(seededStory());

  const runFor = (id) => {
    return application.store.snapshot().autoResearchRuns.find((run) => run.id === id);
  };
  const score = (run) => {
    let caught = 0;
    let falseReject = 0;
    for (const verdict of run.verdicts ?? []) {
      const key = KEY.get(verdict.claimId);
      if (!key) continue;
      if (key.truth === "unsupported" && verdict.verdict === "contradicted") caught++;
      if (key.truth === "supported" && verdict.verdict === "contradicted") falseReject++;
    }
    return { caught, falseReject };
  };
  const startTopology = (topology) => {
    application.store.setTopology(topology);
    const current = application.store.getStory(story.slotId);
    const { runId } = application.factCheck.request({
      slotId: story.slotId,
      contentVersion: current.contentVersion,
      topology,
    });
    return runId;
  };
  return {
    ...application,
    story,
    placed,
    runFor,
    score,
    startTopology,
    gatewayCalls: () => gatewayCalls,
  };
}

function placeDemoStory(store) {
  // The MCP load_demo_story / set_demo_mode tools place the bundled story; the store test
  // shim mirrors that by placing it through the same path.
  const { seededStory } = require("../src/fact-check/archive.mjs");
  return store.placeFixedStory(seededStory());
}

test("every topology has a bundled recording", () => {
  for (const topology of ["single", "graph", "swarm"]) {
    assert.ok(hasRecording(topology), `${topology} recording is bundled`);
  }
});

for (const topology of ["single", "graph", "swarm"]) {
  test(`demo mode on: ${topology} replays to the recorded score with zero gateway calls`, async (t) => {
    const app = await demoApp(t);
    assert.equal(app.store.snapshot().settings.demoMode, true, "demo mode is on");

    const runId = app.startTopology(topology);
    await app.factCheck.waitForIdle();
    const run = app.runFor(runId);

    assert.equal(run.status, "completed", `run completed: ${run.stopReason}`);
    assert.equal(run.topology, topology, "the run records its arrangement");

    const expected = EXPECTED[topology];
    assert.equal(run.verdicts.length, expected.verdicts, `${topology} verdict count`);

    const { caught, falseReject } = app.score(run);
    assert.equal(caught, expected.caught, `${topology}: wrong claims caught`);
    assert.equal(falseReject, expected.falseReject, `${topology}: true claims wrongly flagged`);

    // The whole point: no broker request reached the real gateway.
    assert.equal(app.gatewayCalls(), 0, "a replayed run makes zero gateway calls");

    // The run still went through the real harness: each replayed reply is accounted as a
    // captured agent call in the per-run summary, tool observations were recorded, and the
    // summary names the arrangement. (Replay does not create gateway "model" trace spans;
    // those come from the live provider path, which a recorded run deliberately skips.)
    assert.ok(run.runSummary.calls >= 1, "replayed calls are accounted in the run summary");
    assert.equal(run.runSummary.topology, topology, "the summary names the arrangement");
    const toolCalls = app.trace.entries.filter((entry) => {
      return entry.kind === "fact_check.tool_call" && entry.jobId === runId;
    });
    assert.ok(toolCalls.length >= 1, "the replayed agents ran search/read tools against the archive");
  });
}

test("demo mode on: the run is labelled as a recorded run", async (t) => {
  const app = await demoApp(t);
  const runId = app.startTopology("swarm");
  await app.factCheck.waitForIdle();
  const stop = app.trace.entries.find((entry) => {
    return entry.kind === "fact_check.stop" && entry.jobId === runId;
  });
  // The run span carries the recorded label so the Execution view can mark it.
  const runSpan = app.trace.entries.find((entry) => {
    return entry.kind === "fact_check.run" && entry.jobId === runId;
  });
  assert.ok(runSpan, "the run span exists");
  assert.equal(runSpan.recorded, true, "the run span is flagged recorded");
  assert.match(runSpan.recordedLabel ?? "", /Recorded run on GPT-6 Luna/);
  assert.ok(stop, "the run stopped");
});

test("demo mode off: a demo story runs through the live gateway, not the recording", async (t) => {
  const app = await demoApp(t);
  // Turn the toggle back off; the demo story stays placed but execution is real again.
  app.store.setDemoMode(false);
  assert.equal(app.store.snapshot().settings.demoMode, false, "demo mode is off");

  const runId = app.startTopology("single");
  await app.factCheck.waitForIdle();
  const run = app.runFor(runId);
  assert.equal(run.status, "completed", `run completed: ${run.stopReason}`);
  // With demo mode off, the live (fixture) gateway is used, so completeText is called.
  assert.ok(app.gatewayCalls() >= 1, "real execution calls the gateway");
});
