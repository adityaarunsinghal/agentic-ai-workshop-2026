import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssueStore } from "../src/domain/store.mjs";
import { createTrace } from "../src/trace.mjs";
import { createMcpServer } from "../src/mcp/server.mjs";
import { connectMcp } from "../src/mcp/client.mjs";
import { boundFrame, retainFramePrecision, sameFrame, sameFrameSize } from "../ui/src/shared/geometry.mjs";
import { briefingViews, savedExecutionResult } from "../ui/src/shared/briefings.mjs";

const frame = { x: 12, y: 44, width: 86, height: 104 };
const jitter = { x: 12.01, y: 44.02, width: 85.99, height: 103.98 };

test("subpixel equality rejects malformed values and preserves meaningful fractional changes", () => {
  assert.equal(sameFrame(frame, jitter), true);
  assert.equal(sameFrameSize(frame, jitter), true);
  assert.deepEqual(retainFramePrecision(frame, boundFrame(jitter)), frame);
  for (const key of ["x", "y", "width", "height"]) {
    assert.equal(sameFrame(frame, { ...frame, [key]: frame[key] + 0.03 }), false, key);
    for (const value of [NaN, Infinity, null, undefined, String(frame[key])])
      assert.equal(sameFrame(frame, { ...frame, [key]: value }), false, `${key}: ${value}`);
  }
  assert.equal(sameFrame({}, {}), false);
  assert.deepEqual(retainFramePrecision(frame, { ...jitter, x: 199.01, y: 300.02 }),
    { ...frame, x: 199, y: 300 }, "restoring size cannot push a moved frame beyond the content edge");
});

async function persistentStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "session2-geometry-history-"));
  const file = join(directory, "issue.json");
  const trace = createTrace();
  const store = await createIssueStore({ trace, file });
  t.after(async () => {
    await store.flush();
    await trace.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, trace, file };
}

test("seven exact/noisy moves preserve saved bytes, revisions, copy, writer lease and undo", async (t) => {
  const { store, trace, file } = await persistentStore(t);
  const slot = store.reserveStory({ frame });
  store.editStory(slot.slotId, { body: "Preserve this human sentence." });
  store.startJob({ slotId: slot.slotId, prompt: "Pending research" });
  await store.flush();
  await trace.flush();
  const saved = await readFile(file, "utf8"), before = store.snapshot();
  const version = store.mutationVersion, count = trace.summary().totalRecords;
  for (let index = 0; index < 7; index++)
    store.moveStory(slot.slotId, index % 2 ? frame : jitter);
  await store.flush();
  assert.equal(await readFile(file, "utf8"), saved);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.mutationVersion, version);
  assert.equal(trace.summary().totalRecords, count);
  store.undo();
  assert.equal(store.getStory(slot.slotId).body, "", "no-op moves did not add undo entries");
});

test("real movement keeps jittered dimensions canonical and a fractional resize still saves", async () => {
  const store = await createIssueStore();
  const slot = store.reserveStory({ frame });
  const before = store.snapshot().issue.revision;
  store.moveStory(slot.slotId, { ...jitter, x: 72.16, y: 85.55 });
  assert.deepEqual(store.getStory(slot.slotId).frame, { ...frame, x: 72.16, y: 85.55 });
  assert.equal(store.snapshot().issue.revision, before + 1);
  store.moveStory(slot.slotId, { ...store.getStory(slot.slotId).frame, width: 86.03 });
  assert.equal(store.getStory(slot.slotId).frame.width, 86.03);
  assert.equal(store.snapshot().issue.revision, before + 2);
});

test("layout no-ops preserve saves but still enforce stale revisions, locks and exact bounds", async (t) => {
  const { store, trace, file } = await persistentStore(t);
  const slot = store.reserveStory({ frame });
  store.lockStory(slot.slotId, true);
  await store.flush();
  await trace.flush();
  const before = store.snapshot(), saved = await readFile(file, "utf8");
  const args = { baseRevision: before.issue.revision, frames: [{ slotId: slot.slotId, frame: jitter }] };
  store.applyLayout(args);
  await store.flush();
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await readFile(file, "utf8"), saved);
  assert.throws(() => store.moveStory(slot.slotId, jitter), /Unlock/);
  assert.throws(() => store.applyLayout({ ...args, baseRevision: args.baseRevision - 1 }), { code: "STALE_LAYOUT" });
  assert.throws(() => store.applyLayout({ ...args, frames: [{ slotId: slot.slotId, frame: { ...frame, x: 12.03 } }] }),
    { code: "STORY_LOCKED" });
  assert.throws(() => store.applyLayout({ ...args, frames: [{ slotId: slot.slotId, frame: { ...frame, x: 11.99 } }] }),
    { code: "FRAME_BOUNDS" });
  assert.deepEqual(store.snapshot(), before);
});

test("snapping tiny layout changes cannot admit an overlap with an unchanged block", async () => {
  const store = await createIssueStore();
  const a = store.reserveStory({ frame });
  store.reserveStory({ frame: { ...frame, x: 98.01, width: 60 } });
  const before = store.snapshot();
  // The raw proposed width fits, but preserving the old width would overlap.
  assert.throws(() => store.applyLayout({
    baseRevision: before.issue.revision,
    frames: [{ slotId: a.slotId, frame: { ...frame, x: 12.03, width: 85.98 } }],
  }), { code: "LAYOUT_OVERLAP" });
  assert.deepEqual(store.snapshot(), before);
});

async function mcpSetup(t) {
  const { store, trace, file } = await persistentStore(t);
  store.setStage("research");
  const slot = store.reserveStory({ frame });
  store.editStory(slot.slotId, { body: "Preserve my saved copy." });
  const reviews = [], resizes = [];
  const config = { mode: "fixture", onDraftComplete: () => {} };
  const ctx = { store, trace, config,
    editorial: { review: async (args) => { reviews.push(args); } },
    agent: { resizeStory: (args) => { resizes.push(args); return { scheduled: true }; } } };
  const server = createMcpServer(ctx), mcp = await connectMcp(server, trace);
  t.after(async () => { await mcp.client.close(); await server.close(); });
  const call = (name, args) => mcp.callTool(name, args);
  await store.flush();
  return { store, trace, file, slot, call, reviews, resizes, ctx };
}

test("MCP no-ops make no saves or model work; real moves and resizes keep their routing", async (t) => {
  const { store, file, slot, call, reviews, resizes } = await mcpSetup(t);
  const saved = await readFile(file, "utf8"), before = store.snapshot().issue;
  for (let index = 0; index < 7; index++) {
    const result = await call("move_story", { slotId: slot.slotId, frame: jitter });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.unchanged, true);
  }
  await call("apply_layout", { baseRevision: before.revision, frames: [{ slotId: slot.slotId, frame: jitter }] });
  await store.flush();
  assert.equal(await readFile(file, "utf8"), saved);
  assert.deepEqual(store.snapshot().issue, before);
  assert.deepEqual([reviews.length, resizes.length], [0, 0]);
  const moved = await call("move_story", { slotId: slot.slotId, frame: { ...jitter, x: 60 } });
  assert.equal(moved.structuredContent.resized, false);
  assert.deepEqual([reviews.length, resizes.length], [1, 0]);
  await call("move_story", { slotId: slot.slotId, frame: { ...frame, x: 60, width: 86.03 } });
  assert.deepEqual([reviews.length, resizes.length], [1, 1]);
  store.lockStory(slot.slotId);
  const locked = await call("move_story", { slotId: slot.slotId, frame: store.getStory(slot.slotId).frame });
  assert.equal(locked.structuredContent.code, "STORY_LOCKED");
});

test("approved template resize defers review; same-template geometry cannot start another writer", async (t) => {
  const { store, slot, call, reviews, resizes, ctx } = await mcpSetup(t);
  const apply = (width) => call("apply_layout", {
    baseRevision: store.snapshot().issue.revision, template: "newspaper",
    frames: [{ slotId: slot.slotId, frame: { ...frame, width } }],
  });
  const first = await apply(120);
  assert.deepEqual(first.structuredContent.adaptedSlotIds, [slot.slotId]);
  assert.deepEqual([reviews.length, resizes.length], [0, 1]);
  await apply(120);
  assert.deepEqual([reviews.length, resizes.length], [0, 1]);
  ctx.agent.resizeStory = () => ({ scheduled: false });
  await apply(121);
  assert.equal(reviews.length, 0);
  ctx.agent.resizeStory = () => ({ scheduled: true });
  delete ctx.config.onDraftComplete;
  await apply(122);
  assert.equal(reviews.length, 0, "same-template calls stay cleanup even without a completion hook");
  assert.equal(resizes.length, 1);
});

test("earlier-visit results retain all saved content and distinguish unavailable from restored archives", async (t) => {
  const { store, trace, file } = await persistentStore(t);
  const job = store.startBriefing({ prompt: "Keep this briefing" });
  const span = trace.start("briefing", { jobId: job.id, requestId: job.id });
  store.updateJob(job.id, { status: "completed", answer: "Saved complete answer", partialText: "Saved partial text" });
  span.finish({ status: "complete" });
  const editorial = trace.record("editorial", { status: "complete", payload: { actual: "archived input" } });
  const receipt = { requestId: editorial.id, status: "complete", answers: { lead: { choice: "retained" } },
    durationMs: 12, inputRevision: 3, resultRevision: 4, operationIds: ["original-operation"] };
  store.updateActivity({ editorial: receipt, editorialHistory: [receipt] });
  await store.flush();
  const savedBytes = await readFile(file, "utf8");
  assert.equal(briefingViews(store.snapshot())[0].executionHistory.available, true);
  assert.equal(savedExecutionResult(store.snapshot(), editorial.id), null);

  const freshTrace = createTrace();
  t.after(() => freshTrace.close());
  const next = await createIssueStore({ trace: freshTrace, file });
  const state = next.snapshot(), view = briefingViews(state)[0];
  assert.equal(view.executionHistory.available, false);
  assert.equal(view.executionHistory.origin, "earlier_visit");
  assert.equal(view.canCancel, false);
  assert.equal(view.answer, "Saved complete answer");
  assert.equal(view.partialText, "Saved partial text");
  const compact = savedExecutionResult(state, editorial.id);
  assert.equal(compact.executionHistory.available, false);
  for (const [key, value] of Object.entries(receipt)) assert.deepEqual(compact[key], value);
  assert.equal(compact.payload, undefined, "never reconstruct archived input from the receipt");
  assert.equal(await freshTrace.get(editorial.id), null);
  assert.equal(await readFile(file, "utf8"), savedBytes, "availability checks do not rewrite the save");

  const withArchive = await createIssueStore({ trace, file });
  for (let index = 0; index < 60; index++) trace.record("app", { action: "later_activity" });
  assert.equal(withArchive.snapshot().trace.some((record) => record.id === editorial.id), false);
  assert.equal(withArchive.snapshot().editorial.executionHistory.available, true);
  assert.equal(briefingViews(withArchive.snapshot())[0].executionHistory.available, true);
  assert.equal(savedExecutionResult(withArchive.snapshot(), editorial.id), null);
  assert.equal((await trace.get(editorial.id)).payload.actual, "archived input");

  const newJob = next.startBriefing({ prompt: "Fresh request" });
  freshTrace.record("briefing", { jobId: newJob.id, requestId: newJob.id });
  const fresh = briefingViews(next.snapshot()).find((entry) => entry.jobId === newJob.id);
  assert.equal(fresh.executionHistory.available, true);
  assert.equal(fresh.executionHistory.origin, "current_visit");
  assert.equal(fresh.canCancel, true);
  next.updateJob(newJob.id, { status: "cancelled" });
  assert.equal(briefingViews(next.snapshot()).find((entry) => entry.jobId === newJob.id).canCancel, false);
  await next.flush();
});

test("cancel briefing retains current server authority and rejects an earlier visit's job", async (t) => {
  const { store, call, ctx } = await mcpSetup(t);
  const job = store.startBriefing({ prompt: "Current request" });
  const cancelled = [];
  ctx.agent.cancelBriefing = (id) => { cancelled.push(id); store.updateJob(id, { status: "cancelled" }); return true; };
  assert.equal((await call("cancel_briefing", { jobId: "earlier-visit-job" })).structuredContent.code, "UNKNOWN_JOB");
  assert.deepEqual(cancelled, []);
  const result = await call("cancel_briefing", { jobId: job.id });
  assert.equal(result.structuredContent.cancelled, true);
  assert.deepEqual(cancelled, [job.id]);
  assert.equal(store.snapshot().briefings[0].status, "cancelled");
});

test("MCP editorial retries require an explicit boolean and default to ordinary review", async (t) => {
  const { call, reviews } = await mcpSetup(t);
  assert.equal((await call("editorialize_board", {})).isError, undefined);
  assert.deepEqual(reviews, [{ reason: "editor_requested_review", retry: false }]);
  assert.equal((await call("editorialize_board", { reason: "Retry failed review", retry: true })).isError, undefined);
  assert.deepEqual(reviews.at(-1), { reason: "Retry failed review", retry: true });
  assert.equal((await call("editorialize_board", { retry: "true" })).isError, true);
  assert.equal(reviews.length, 2);
});

test("ephemeral inference activity stays visible without new hosted saves", async () => {
  const saved = [];
  const persistence = {
    status: () => ({ mode: "hosted", phase: "saved", error: null }),
    save: async (state) => { saved.push(structuredClone(state)); },
  };
  const store = await createIssueStore({ config: { mode: "hosted" }, persistence });
  store.setTitle("Retain this edition");
  await store.flush();
  for (let index = 0; index < 20; index++)
    store.updateActivity({ inferenceActivity: { status: index % 2 ? "idle" : "running", requestId: `fresh-${index}` } });
  await store.flush();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].inferenceActivity, undefined);
  assert.equal(store.snapshot().inferenceActivity.requestId, "fresh-19");
  store.setTitle("A real saved change");
  await store.flush();
  assert.equal(saved.length, 2);
  assert.equal(saved[1].inferenceActivity, undefined);
});
