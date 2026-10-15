import test from "node:test";
import assert from "node:assert/strict";
import { createIssueStore } from "../src/domain/store.mjs";
import { createTrace } from "../src/trace.mjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function setup() {
  const trace = createTrace();
  const store = await createIssueStore({ trace, config: { mode: "fixture" } });
  store.addSources([{ id: "source-1", title: "Fixture evidence", url: "https://example.org/evidence", text: "A synthetic source.", evidenceLevel: "article" }]);
  const slot = store.reserveStory({ prompt: "Write a grounded fixture." });
  const job = store.startJob({ slotId: slot.slotId, prompt: slot.prompt });
  return { store, slot, job };
}

test("a broker selection replaces saved defaults without changing the newspaper", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "session2-model-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "issue.json");
  const original = await createIssueStore({ config: { mode: "fixture", model: "old-model" } });
  original.setTitle("Preserve this edition");
  original.applyInferenceSelection({ model: "old-model", profileId: "old-profile" });
  await writeFile(file, JSON.stringify(original.snapshot()));
  const store = await createIssueStore({ file, config: { mode: "development", model: "starter-default" } });
  const before = store.snapshot();
  assert.equal(before.settings.model, null);
  assert.equal(before.inferenceSelection, undefined);
  store.applyInferenceSelection({ mode: "development", model: "selected-model", profileId: "selected-profile" });
  const after = store.snapshot();
  assert.deepEqual(after.issue, before.issue);
  assert.equal(after.settings.model, "selected-model");
  assert.equal(after.inferenceSelection.model, "selected-model");
  store.newNewspaper();
  assert.equal(store.snapshot().settings.model, "selected-model");
  await store.flush();
});

test("partial progress patches retain the real job status and phase in execution", async () => {
  const trace = createTrace();
  const store = await createIssueStore({ trace });
  const job = store.startBriefing({ prompt: "Explain the harness." });
  store.updateJob(job.id, { status: "running", phase: "generating", turn: 1 });
  store.updateJob(job.id, { partialText: "The harness" });
  const progress = trace.entries.at(-1);
  assert.equal(progress.status, "running");
  assert.equal(progress.phase, "generating");
  assert.equal(progress.turn, 1);
  assert.equal(store.snapshot().briefings[0].partialText, "The harness");
  await trace.close();
});

test("a moved pending slot receives its draft at its new location", async () => {
  const { store, slot, job } = await setup();
  store.moveStory(slot.id, { x: 105, y: 150, width: 80, height: 90 });
  const result = store.completeStory({
    slotId: slot.slotId, requestId: job.id, baseContentVersion: 0,
    headline: "A fixture headline", body: "A short supported draft.", sourceIds: ["source-1"],
  });
  assert.equal(result.applied, true);
  assert.equal(store.getStory(slot.id).frame.x, 105);
});

test("manual copy remains authoritative when research returns late", async () => {
  const { store, slot, job } = await setup();
  store.editStory(slot.id, { body: "My own edited copy." });
  const result = store.completeStory({
    slotId: slot.slotId, requestId: job.id, baseContentVersion: 0,
    headline: "A suggested headline", body: "A generated alternate.", sourceIds: ["source-1"],
  });
  assert.equal(result.alternate, true);
  assert.equal(store.getStory(slot.id).body, "My own edited copy.");
  assert.equal(store.getStory(slot.id).alternateDraft.body, "A generated alternate.");
});

test("unchanged editor saves do not claim ownership of a pending draft", async () => {
  const { store, slot, job } = await setup();
  store.editStory(slot.id, { body: "" });
  store.editStory(slot.id, { body: "" });
  assert.equal(store.getStory(slot.id).contentVersion, 0);
  const result = store.completeStory({
    slotId: slot.slotId, requestId: job.id, baseContentVersion: 0,
    headline: "The researched draft", body: "Supported copy.", sourceIds: ["source-1"],
  });
  assert.equal(result.applied, true);
  assert.equal(store.getStory(slot.id).headline, "The researched draft");
});

test("deleted slots cannot be recreated by late drafts", async () => {
  const { store, slot, job } = await setup();
  store.deleteStory(slot.id);
  assert.equal(store.completeStory({
    slotId: slot.slotId, requestId: job.id, baseContentVersion: 0,
    headline: "Late", body: "Late copy.", sourceIds: ["source-1"],
  }).applied, false);
  assert.equal(store.snapshot().issue.stories.length, 0);
});

test("reading-list writes require a current explicit approval", async () => {
  const { store } = await setup();
  const proposal = store.saveLinks(["source-1"]).proposal;
  assert.equal(store.snapshot().preferences.readingList.length, 0);
  store.approve(proposal.id, false);
  assert.equal(store.snapshot().preferences.readingList.length, 0);
  const approved = store.saveLinks(["source-1"]).proposal;
  store.approve(approved.id, true);
  assert.equal(store.snapshot().preferences.readingList[0].id, "source-1");
});

test("activity advances the notification stream without invalidating issue edits or undo", async () => {
  const { store } = await setup();
  store.setTitle("An edited issue");
  const before = store.snapshot();
  let notified;
  const unsubscribe = store.subscribe((state) => { notified = state; });
  store.updateActivity({ editorial: { status: "loading", model: "general-model", startedAt: "fixture-time" } });
  assert.equal(notified.editorial.status, "loading");
  assert.equal(notified.issue.revision, before.issue.revision);
  assert.ok(notified.streamRevision > before.streamRevision);
  assert.throws(() => store.updateActivity({ issue: { revision: 0 } }), /non-domain/u);
  store.undo();
  assert.equal(store.snapshot().issue.title, "The Agentic Times");
  assert.equal(store.snapshot().editorial.status, "loading");
  unsubscribe();
});

test("new archive issue IDs and the tools default yield to the saved issue and stage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "session2-domain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "issue.json");
  const store = await createIssueStore({ trace: createTrace(), file, config: { mode: "fixture", issueId: "archive-bound-issue" } });
  assert.equal(store.snapshot().issue.id, "archive-bound-issue");
  assert.equal(store.snapshot().settings.stage, "tools");
  store.setStage("final");
  store.updateActivity({ editorial: { status: "complete", elapsedMs: 12 } });
  const job = store.startBriefing({ prompt: "Keep this partial briefing" });
  store.updateJob(job.id, { status: "researching", partialText: "Partial answer" });
  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.trace, undefined);
  assert.equal(saved.execution, undefined);
  assert.equal(saved.streamRevision, undefined);
  const restored = await createIssueStore({ trace: createTrace(), file, config: { mode: "fixture", issueId: "replacement-id" } });
  assert.equal(restored.snapshot().issue.id, "archive-bound-issue");
  assert.equal(restored.snapshot().settings.stage, "final");
  assert.equal(restored.snapshot().editorial.elapsedMs, 12);
  assert.equal(restored.snapshot().briefings[0].status, "interrupted");
  assert.equal(restored.snapshot().briefings[0].partialText, "Partial answer");
});

test("snapshots carry only bounded trace summaries and the separate capture summary", async () => {
  const entries = Array.from({ length: 80 }, (_, index) => ({
    id: String(index), sequence: index + 1, kind: "model.request",
    payload: { large: "x".repeat(10000) },
  }));
  const fallback = await createIssueStore({ trace: { entries } });
  const state = fallback.snapshot();
  assert.equal(state.trace.length, 50);
  assert.equal(state.trace[0].sequence, 31);
  assert.equal(state.trace[0].payload, undefined);
  assert.equal(state.execution.totalRecords, 80);
  assert.equal(state.execution.requestCount, 80);
  const summary = { totalRecords: 80, teachingRecords: 2, latestSequence: 80,
    requestCount: 6, reportedCostUsd: 0.03, capture: { status: "partial", droppedRecords: 1, errors: ["fixture"] } };
  const archived = await createIssueStore({ trace: {
    recent(args) {
      assert.deepEqual(args, { limit: 50, view: "teaching" });
      return [{ id: "summary-1", sequence: 80, kind: "agent" }];
    },
    summary: () => summary,
    get entries() { throw new Error("Full archive histories must not enter snapshots."); },
  } });
  assert.deepEqual(archived.snapshot().execution, summary);
  assert.deepEqual(archived.snapshot().trace, [{ id: "summary-1", sequence: 80, kind: "agent" }]);
});

test("empty client UUID blocks persist and retries preserve manual copy, locks and jobs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "session2-empty-block-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "issue.json");
  const store = await createIssueStore({ trace: createTrace(), file });
  const slotId = randomUUID();
  const slot = store.reserveStory({ slotId, frame: { x: 12, y: 44, width: 84, height: 78 } });
  assert.equal(slot.id, slotId);
  assert.equal(slot.status, "draft");
  assert.equal(slot.headline, "");
  assert.equal(slot.body, "");
  assert.deepEqual(store.snapshot().jobs, []);
  store.editStory(slotId, { headline: "", body: "Manually written copy." });
  const job = store.startJob({ slotId, prompt: "An explicit request" });
  store.lockStory(slotId, true);
  const before = store.snapshot();
  store.reserveStory({ slotId, prompt: "Must not reset", frame: { x: 110, y: 44, width: 90, height: 100 } });
  assert.deepEqual(store.snapshot().issue, before.issue);
  assert.deepEqual(store.snapshot().jobs, before.jobs);
  assert.equal(store.getStory(slotId).requestId, job.id);
  await store.flush();
  const restored = await createIssueStore({ trace: createTrace(), file });
  assert.equal(restored.getStory(slotId).id, slotId);
  assert.equal(restored.getStory(slotId).body, "Manually written copy.");
  assert.equal(restored.getStory(slotId).locked, true);
});

test("manual edits and applied drafts clear old research notes and invalidate versioned typography", async () => {
  const { store, slot, job } = await setup();
  store.update((issue) => {
    const story = issue.stories[0];
    story.typography = { contentVersion: 0, styles: { s0: "large_bold" } };
    story.researchNote = "Earlier research failed.";
  }, { history: false });
  store.editStory(slot.slotId, { headline: "" });
  assert.equal(store.getStory(slot.slotId).typography.contentVersion, 0);
  store.moveStory(slot.slotId, { ...slot.frame, x: 100 });
  assert.equal(store.getStory(slot.slotId).typography.contentVersion, 0);
  store.editStory(slot.slotId, { headline: "Manual headline", body: "Keep this sentence." });
  const manual = store.getStory(slot.slotId);
  assert.equal(manual.typography, undefined);
  assert.equal(manual.researchNote, undefined);
  assert.equal(manual.contentVersion, 1);
  store.update((issue) => {
    issue.stories[0].typography = { contentVersion: 1, styles: { s0: "medium_italic" } };
  }, { history: false });
  const alternate = store.completeStory({
    slotId: slot.slotId, requestId: job.id, baseContentVersion: 0,
    headline: "Late copy", body: "Generated alternative.", sourceIds: ["source-1"],
  });
  assert.equal(alternate.alternate, true);
  assert.equal(store.getStory(slot.slotId).body, manual.body);
  assert.equal(store.getStory(slot.slotId).typography.contentVersion, 1);
  const newer = store.startJob({ slotId: slot.slotId, prompt: "Replace explicitly" });
  store.update((issue) => { issue.stories[0].researchNote = "A retained diagnostic."; }, { history: false });
  const applied = store.completeStory({
    slotId: slot.slotId, requestId: newer.id, baseContentVersion: 1,
    headline: "New supported draft", body: "New source-backed copy.", sourceIds: ["source-1"],
  });
  assert.equal(applied.applied, true);
  assert.equal(store.getStory(slot.slotId).typography, undefined);
  assert.equal(store.getStory(slot.slotId).researchNote, undefined);
});

test("legacy saved source cards remain loadable and locked copy cannot be replaced", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "session2-legacy-card-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "issue.json");
  const store = await createIssueStore({ trace: createTrace(), file });
  const slot = store.reserveStory();
  store.update((issue) => {
    Object.assign(issue.stories[0], {
      kind: "source-card", headline: "Saved source card", body: "Retain this older excerpt.",
      contentVersion: 1, sourceLineage: [{ id: "older-source", evidenceLevel: "metadata" }],
    });
  });
  const job = store.startJob({ slotId: slot.slotId, prompt: "Explicit generation" });
  store.lockStory(slot.slotId, true);
  assert.throws(() => store.editStory(slot.slotId, { body: "Overwrite" }), /Unlock/);
  const result = store.completeStory({
    slotId: slot.slotId, requestId: job.id, baseContentVersion: 1,
    headline: "Generated", body: "An alternate.", sourceIds: [],
  });
  assert.equal(result.alternate, true);
  await store.flush();
  const restored = await createIssueStore({ trace: createTrace(), file });
  assert.equal(restored.getStory(slot.slotId).kind, "source-card");
  assert.equal(restored.getStory(slot.slotId).body, "Retain this older excerpt.");
  assert.equal(restored.getStory(slot.slotId).sourceLineage[0].id, "older-source");
});

test("layout plans validate completely before one atomic, undoable frame update", async () => {
  const store = await createIssueStore({ trace: createTrace() });
  const a = store.reserveStory({ frame: { x: 12, y: 46, width: 84, height: 78 } });
  const b = store.reserveStory({ frame: { x: 110, y: 46, width: 84, height: 78 } });
  store.editStory(a.slotId, { body: "Manual copy A." });
  store.editStory(b.slotId, { body: "Manual copy B." });
  store.startJob({ slotId: a.slotId, prompt: "An independent pending writer" });
  store.lockStory(b.slotId, true);
  store.update((_issue, state) => { state.settings.layoutCleanup = "offer_tidy"; }, { history: false });
  const before = store.snapshot();
  const result = store.applyLayout({
    baseRevision: before.issue.revision,
    frames: [
      { slotId: a.slotId, frame: { ...a.frame, height: 50 } },
      { slotId: b.slotId, frame: b.frame },
    ],
  });
  assert.equal(result.issue.revision, before.issue.revision + 1);
  assert.deepEqual(result.jobs, before.jobs);
  assert.equal(result.settings.layoutCleanup, undefined);
  assert.equal(result.issue.stories[0].frame.height, 50);
  assert.deepEqual(result.issue.stories[1], before.issue.stories[1]);
  for (const [index, story] of result.issue.stories.entries()) {
    assert.equal(story.body, before.issue.stories[index].body);
    assert.equal(story.contentVersion, before.issue.stories[index].contentVersion);
    assert.equal(story.requestId, before.issue.stories[index].requestId);
  }
  store.undo();
  assert.deepEqual(store.snapshot().issue.stories, before.issue.stories);
  assert.equal(store.snapshot().issue.revision, before.issue.revision + 2);
});

test("stale, duplicate, unknown, out-of-bounds, locked and overlapping layouts make no partial changes", async () => {
  const store = await createIssueStore({ trace: createTrace() });
  const a = store.reserveStory({ frame: { x: 12, y: 46, width: 84, height: 78 } });
  const b = store.reserveStory({ frame: { x: 110, y: 46, width: 84, height: 78 } });
  store.lockStory(b.slotId, true);
  store.setTitle("Last real edit");
  const before = store.snapshot();
  const valid = { slotId: a.slotId, frame: { ...a.frame, height: 50 } };
  for (const [patch, code] of [
    [{ baseRevision: before.issue.revision - 1, frames: [valid] }, "STALE_LAYOUT"],
    [{ frames: [valid, valid] }, "INVALID_LAYOUT"],
    [{ frames: [valid, { slotId: randomUUID(), frame: a.frame }] }, "UNKNOWN_SLOT"],
    [{ frames: [valid, { slotId: b.slotId, frame: { ...b.frame, x: 290 } }] }, "FRAME_BOUNDS"],
    [{ frames: [valid, { slotId: b.slotId, frame: { ...b.frame, height: 50 } }] }, "STORY_LOCKED"],
    [{ frames: [{ slotId: a.slotId, frame: { ...a.frame, x: 100 } }] }, "LAYOUT_OVERLAP"],
  ]) {
    assert.throws(() => store.applyLayout({ baseRevision: before.issue.revision, ...patch }), { code });
    assert.deepEqual(store.snapshot().issue, before.issue);
    assert.deepEqual(store.snapshot().settings, before.settings);
  }
  store.undo();
  assert.equal(store.snapshot().issue.title, "The Agentic Times");
});
