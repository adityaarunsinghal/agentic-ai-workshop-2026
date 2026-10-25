import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.mjs";
import { seededStory, answerKey } from "../src/fact-check/archive.mjs";
import { deriveClaimBoard } from "../ui/src/shared/claim-board.mjs";

// Session 3 claim board: the per-claim status the Execution view reads. The harness carries a
// claims array on each fact-check run (one entry per claim, state waiting | checking |
// supported | contradicted | needs_evidence, plus a planted marker for the demo story) and
// pushes it to the snapshot as autoResearchRuns[].claims in real time. These tests pin the
// state machine for each arrangement, in fixture (real code path) and demo-mode replay, and
// check the board's derivation for the UI. They never touch the recording directly.

const KEY = new Map(answerKey().map((entry) => [entry.claimId, entry]));
const TERMINAL = new Set(["supported", "contradicted", "needs_evidence"]);
const VERDICT_STATE = {
  supported: "supported",
  contradicted: "contradicted",
  "not enough evidence": "needs_evidence",
};

function seed(store) {
  store.setStage("research");
  const slot = store.reserveStory();
  store.editStory(slot.slotId, seededStory());
  return store.getStory(slot.slotId);
}

async function appFixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "session3-claim-board-"));
  const application = await createApplication({
    mode: "fixture",
    fixture: true,
    stateFile: null,
    exportsDirectory: join(directory, "exports"),
    ...overrides,
  });
  t.after(async () => {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  const story = seed(application.store);
  const runFor = (id) =>
    application.store.snapshot().autoResearchRuns.find((run) => run.id === id);
  const startTopology = (topology, extra = {}) => {
    const current = application.store.getStory(story.slotId);
    const { runId } = application.factCheck.request({
      slotId: story.slotId,
      contentVersion: current.contentVersion,
      topology,
      ...extra,
    });
    return runId;
  };
  return { ...application, story, runFor, startTopology };
}

// Capture EVERY board the harness pushes to the store, via a subscription rather than time
// sampling. A fixture run settles fast, so a timer-based poller can miss intermediate states;
// a subscription sees each distinct board the harness emits. Returns the peak checking count
// and whether any board was ever observed with a claim checking.
function watchBoard(app) {
  let peakChecking = 0;
  let sawChecking = false;
  let pushes = 0;
  const unsubscribe = app.store.subscribe(() => {
    const run = app.store.snapshot().autoResearchRuns[0];
    const claims = run?.claims ?? [];
    if (!claims.length) {
      return;
    }
    const checking = claims.filter((claim) => claim.state === "checking").length;
    peakChecking = Math.max(peakChecking, checking);
    if (checking > 0) {
      sawChecking = true;
    }
    pushes++;
  });
  return { stop: () => unsubscribe?.(), result: () => ({ peakChecking, sawChecking, pushes }) };
}


function assertTerminalMatchesVerdicts(run, { label }) {
  const board = new Map((run.claims ?? []).map((claim) => [claim.id, claim.state]));
  const verdictById = new Map(run.verdicts.map((entry) => [entry.claimId, entry.verdict]));
  for (const [claimId, verdict] of verdictById) {
    assert.equal(
      board.get(claimId),
      VERDICT_STATE[verdict],
      `${label}: claim ${claimId} board state matches its verdict`,
    );
  }
  // Every claim that got a verdict is terminal on the board; no board claim is left checking
  // once the run has settled.
  for (const claim of run.claims ?? []) {
    if (verdictById.has(claim.id)) {
      assert.ok(TERMINAL.has(claim.state), `${label}: settled claim ${claim.id} is terminal`);
    }
    assert.notEqual(claim.state, "checking", `${label}: no claim is left checking after the run`);
  }
}

for (const topology of ["single", "graph", "swarm"]) {
  test(`fixture ${topology}: the board starts every claim waiting with the story order`, async (t) => {
    const app = await appFixture(t);
    const runId = app.startTopology(topology, topology === "graph" ? { concurrentVerifiers: true } : {});
    // The claim set is derived inside execute(), which runs a microtask after request()
    // returns, so poll briefly for the board to appear; it is waiting until a checker starts.
    let first = app.runFor(runId);
    for (let i = 0; i < 200 && !Array.isArray(first?.claims); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      first = app.runFor(runId);
    }
    assert.ok(Array.isArray(first.claims), "the board is on the run shortly after it starts");
    assert.equal(first.claims.length, KEY.size, "one board cell per claim");
    assert.deepEqual(
      first.claims.map((claim) => claim.id),
      [...KEY.keys()],
      "the board is in story (claim) order",
    );
    await app.factCheck.waitForIdle();
    const run = app.runFor(runId);
    assertTerminalMatchesVerdicts(run, { label: `fixture ${topology}` });
  });
}

test("fixture graph: claims are observed checking mid-run, then all settle", async (t) => {
  const app = await appFixture(t);
  const watch = watchBoard(app);
  const runId = app.startTopology("graph", { concurrentVerifiers: true });
  await app.factCheck.waitForIdle();
  watch.stop();
  const sampled = watch.result();
  assert.ok(sampled.sawChecking, "the graph pushed a board with claims checking while it ran");
  assert.ok(sampled.peakChecking >= 1, `at least one checker was in flight (peak ${sampled.peakChecking})`);
  const run = app.runFor(runId);
  assertTerminalMatchesVerdicts(run, { label: "fixture graph" });
});

test("fixture single: every claim is checking until the verdicts land together", async (t) => {
  const app = await appFixture(t);
  const watch = watchBoard(app);
  const runId = app.startTopology("single");
  // Single marks all claims checking at loop start and settles them together on its final
  // turn, so the harness pushes a board with the whole set checking before any verdict lands.
  await app.factCheck.waitForIdle();
  watch.stop();
  const sampled = watch.result();
  assert.equal(sampled.peakChecking, KEY.size, `single marked all ${KEY.size} claims checking (peak ${sampled.peakChecking})`);
  const run = app.runFor(runId);
  assertTerminalMatchesVerdicts(run, { label: "fixture single" });
});

// Demo-mode replay, unpaced: the board must behave the same through the recorded path.
async function demoApp(t) {
  const directory = await mkdtemp(join(tmpdir(), "session3-claim-board-demo-"));
  const application = await createApplication({
    mode: "fixture",
    fixture: true,
    stateFile: null,
    demoReplayPacing: false,
    exportsDirectory: join(directory, "exports"),
  });
  t.after(async () => {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  application.store.setStage("research");
  application.store.setDemoMode(true);
  const demo = application.store.snapshot().issue.stories.find(
    (story) => story.fixedCopy && (story.plantedClaims?.length ?? 0) > 0,
  );
  const story = demo ?? application.store.placeFixedStory(seededStory());
  const runFor = (id) =>
    application.store.snapshot().autoResearchRuns.find((run) => run.id === id);
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
  return { ...application, story, runFor, startTopology };
}

for (const topology of ["single", "graph", "swarm"]) {
  test(`demo replay ${topology}: the board settles to the recorded verdicts`, async (t) => {
    const app = await demoApp(t);
    const runId = app.startTopology(topology);
    await app.factCheck.waitForIdle();
    const run = app.runFor(runId);
    assert.equal(run.status, "completed", `run completed: ${run.stopReason}`);
    assertTerminalMatchesVerdicts(run, { label: `demo ${topology}` });
    // Demo-story runs mark planted claims on the board, consistent with the editor's planted
    // highlighting. The planted count equals the story's planted-claim count.
    const planted = run.claims.filter((claim) => claim.planted).length;
    assert.equal(planted, app.story.plantedClaims.length, `${topology}: planted claims marked on the board`);
  });
}

test("deriveClaimBoard: joins the run board to story text and tallies caught vs missed", async (t) => {
  const app = await demoApp(t);
  const runId = app.startTopology("graph");
  await app.factCheck.waitForIdle();
  const snapshot = app.store.snapshot();
  const board = deriveClaimBoard({
    autoResearchRuns: snapshot.autoResearchRuns,
    stories: snapshot.issue.stories,
    taskId: runId,
    demoMode: true,
  });
  assert.ok(board, "a board is derived for a fact-check run in scope");
  assert.equal(board.total, KEY.size, "the board has one cell per claim");
  assert.equal(board.terminal, board.cells.filter((cell) => TERMINAL.has(cell.state)).length, "terminal count matches");
  // Graph caught 78 of the 80 planted errors in the recording; the board's caught tally is the
  // planted-and-contradicted count and must not exceed the planted set.
  assert.ok(board.caught > 0, "the board counts caught planted errors");
  assert.ok(board.caught + board.missed <= board.planted, "caught plus missed stays within the planted set");
  assert.equal(board.demoMode, true, "demo mode is reflected once planted claims exist");
});

test("deriveClaimBoard: no board when there is no fact-check run", () => {
  assert.equal(deriveClaimBoard({ autoResearchRuns: [], stories: [] }), null);
  assert.equal(
    deriveClaimBoard({ autoResearchRuns: [{ id: "x", status: "running" }], stories: [] }),
    null,
    "a run without a claims array yields no board",
  );
});
