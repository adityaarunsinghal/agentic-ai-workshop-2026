import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createIssueStore } from "../src/domain/store.mjs";
import { createTrace } from "../src/trace.mjs";
import { createEditorial } from "../src/editorial.mjs";
import { createMcpServer } from "../src/mcp/server.mjs";
import { layoutBasis } from "../src/layout-operations.mjs";
import { layoutMeasurementKey, tidyLayoutPlan } from "../ui/src/shared/geometry.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await tick();
  }
  assert.ok(predicate(), "the bounded fixture did not settle");
}

async function setup(t, { layoutCleanup = "offer_tidy" } = {}) {
  const trace = createTrace();
  const store = await createIssueStore({ trace, config: { mode: "fixture" } });
  store.setStage("editor");
  store.addSources([{ id: "source", title: "Synthetic evidence", text: "Fixture observations." }]);
  const slots = [0, 1].map((index) => {
    const slot = store.reserveStory({ slotId: randomUUID(), sourceIds: ["source"],
      frame: { x: 12 + index * 100, y: 44, width: 86, height: 104 } });
    store.editStory(slot.slotId, {
      headline: `Fixture ${index + 1}`,
      body: index ? "A supporting observation." : Array.from({ length: 18 }, (_, i) => `Fixture sentence ${i + 1}.`).join(" "),
    });
    return slot.slotId;
  });
  const requests = [];
  const editorial = createEditorial({ store, trace, gateway: {
    model: "fixture/layout", maxTokens: 20000,
    completeText(args) {
      const input = JSON.parse(args.messages.at(-1).content);
      requests.push(input);
      return {
        model: "fixture/layout", simulated: true,
        text: JSON.stringify({ answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => [id, {
          type: "choice", choice: {
            layout: Object.hasOwn(question.criteria, "newspaper") ? "newspaper" : Object.keys(question.criteria)[0],
            layout_cleanup: layoutCleanup, reaction: "keep", lead: slots[0], layout_basis: "balanced_coverage",
          }[id] ?? "medium_regular",
        }])) }),
      };
    },
  } });
  const idle = Promise.withResolvers(), resizes = [], jobs = new Map();
  const agent = {
    resizeStory({ slotId }) {
      resizes.push(slotId);
      jobs.set(slotId, store.startJob({ slotId, prompt: "Synthetic approved resize" }));
      return { scheduled: true };
    },
    waitForIdle: () => idle.promise,
  };
  const ctx = { store, trace, editorial, agent, config: { onDraftComplete: true } };
  const server = createMcpServer(ctx);
  const client = new Client({ name: "Layout fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); await store.flush(); await trace.close(); });
  const call = (name, args = {}) => trace.withContext({ actor: "app" },
    () => client.callTool({ name, arguments: args }));
  const approval = (kind) => {
    const state = store.snapshot();
    return { intentId: state.layoutOperation.id, reviewRequestId: state.editorial.requestId,
      documentVersion: state.documentVersion, kind };
  };
  const frames = () => slots.map((slotId, index) => ({
    slotId, frame: { x: index ? 198 : 12, y: 44, width: index ? 87 : 180, height: index ? 80 : 106.5 },
  }));
  async function finishWriter(slotId, { failed = false } = {}) {
    const job = jobs.get(slotId), story = store.getStory(slotId);
    if (!failed) store.completeStory({
      slotId, requestId: job.id, baseContentVersion: job.baseContentVersion,
      headline: story.headline, body: `${story.body} Adapted once.`, sourceIds: story.sourceIds,
    });
    store.updateJob(job.id, { status: failed ? "failed" : "completed" });
    if (!failed) return editorial.reviewDraft({ movedStoryId: slotId, reason: "Review resized copy and typography" });
  }
  async function finishRenderedWriter(slotId, layoutOperationId) {
    const before = store.getStory(slotId);
    const job = store.startJob({ slotId, prompt: "Synthetic rendered fit" });
    store.completeStory({
      slotId, requestId: job.id, baseContentVersion: job.baseContentVersion,
      headline: before.headline, body: `${before.body} Rendered fit.`, sourceIds: before.sourceIds,
    });
    store.updateJob(job.id, { status: "completed" });
    return editorial.reviewDraft({
      movedStoryId: slotId, origin: "rendered_fit", layoutOperationId, reason: "Review resized copy and typography",
    });
  }
  return { store, trace, editorial, call, slots, requests, resizes, idle, approval, frames, finishWriter, finishRenderedWriter };
}

test("one template approval joins its writers, styles once, then cleanup freezes copy and typography", async (t) => {
  const app = await setup(t);
  await app.call("editorialize_board");
  const intentId = app.store.snapshot().layoutOperation.id;
  const template = await app.call("apply_layout", {
    baseRevision: app.store.snapshot().issue.revision, template: "newspaper",
    approval: app.approval("template"), frames: app.frames(),
  });
  assert.equal(template.isError, undefined);
  assert.deepEqual(app.resizes, app.slots);
  assert.equal(app.store.snapshot().layoutOperation.status, "adapting");
  assert.equal((await app.finishWriter(app.slots[0])).deferredToLayout, intentId);
  assert.equal((await app.finishWriter(app.slots[1])).deferredToLayout, intentId);
  assert.equal(app.requests.length, 1, "individual writers cannot start full reviews");
  app.idle.resolve();
  await until(() => app.store.snapshot().layoutOperation.status === "offered");
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].questions.layout, undefined);
  assert.equal(app.store.snapshot().editorial.approvedTemplate, "newspaper");
  assert.equal(app.store.snapshot().layoutOperation.id, intentId);

  const before = app.store.snapshot();
  const cleanupFrames = app.frames().map((change, index) => ({
    ...change, frame: { ...change.frame, height: index ? 60 : 157.5 },
  }));
  const escalation = await app.call("apply_layout", {
    baseRevision: before.issue.revision, template: "newspaper", frames: cleanupFrames,
    approval: app.approval("template"),
  });
  assert.equal(escalation.structuredContent.code, "LAYOUT_AUTHORITY");
  assert.deepEqual(app.store.snapshot().issue, before.issue);
  const cleanup = await app.call("apply_layout", {
    baseRevision: before.issue.revision, frames: cleanupFrames, approval: app.approval("tidy"),
  });
  assert.equal(cleanup.isError, undefined);
  assert.equal(cleanup.structuredContent.geometryComplete, true);
  assert.equal(app.store.snapshot().layoutOperation.status, "complete");
  for (const [index, story] of app.store.snapshot().issue.stories.entries()) {
    assert.equal(story.body, before.issue.stories[index].body);
    assert.deepEqual(story.typography, before.issue.stories[index].typography);
  }
  assert.equal((await app.editorial.reviewDraft({ reason: "Late duplicate completion" })).layoutSettled, true);
  const repeated = await app.call("apply_layout", {
    baseRevision: app.store.snapshot().issue.revision, template: "newspaper", frames: cleanupFrames,
  });
  assert.equal(repeated.structuredContent.code, "LAYOUT_COMPLETE");
  assert.deepEqual([app.requests.length, app.resizes.length], [2, 2]);

  await app.call("editorialize_board");
  assert.notEqual(app.store.snapshot().layoutOperation.id, intentId, "explicit review opens a fresh intent");
  assert.deepEqual(Object.keys(app.requests.at(-1).questions.layout.criteria).sort(),
    ["breaking_news", "newspaper", "side_by_side"]);
});

test("approved template without a cleanup offer settles; later rendered fitting keeps geometry closed", async (t) => {
  const app = await setup(t, { layoutCleanup: "keep" });
  await app.call("editorialize_board");
  const intentId = app.store.snapshot().layoutOperation.id;
  await app.call("apply_layout", {
    baseRevision: app.store.snapshot().issue.revision, template: "newspaper",
    approval: app.approval("template"), frames: app.frames(),
  });
  await app.finishWriter(app.slots[0]);
  // A rendered correction may complete while another template writer is still finishing.
  assert.equal((await app.finishRenderedWriter(app.slots[0], intentId)).deferredToLayout, intentId);
  await app.finishWriter(app.slots[1]);
  assert.equal(app.requests.length, 1);
  app.idle.resolve();
  await until(() => app.store.snapshot().layoutOperation.status === "complete");
  assert.equal(app.requests.length, 2);
  assert.equal(app.store.snapshot().layoutOperation.geometryComplete, true);

  const before = app.store.snapshot();
  await app.finishRenderedWriter(app.slots[0], intentId);
  const after = app.store.snapshot();
  assert.equal(app.requests.length, 3);
  assert.equal(app.requests.at(-1).questions.layout, undefined);
  assert.equal(app.requests.at(-1).questions.layout_cleanup, undefined);
  assert.deepEqual(after.editorial.scope.typographyStoryIds, [app.slots[0]]);
  assert.deepEqual(after.issue.stories[1].typography, before.issue.stories[1].typography);
  assert.equal(after.layoutOperation.id, intentId);
  assert.equal(after.layoutOperation.status, "complete");
  assert.equal(after.settings.editorLayout, "newspaper");
  assert.equal(after.settings.layoutCleanup, "keep");
  assert.equal(after.editorial.settledGeometry, true);
  assert.equal(after.editorial.answers.layout_cleanup, undefined);
  assert.equal((await app.editorial.reviewDraft({
    movedStoryId: app.slots[0], origin: "rendered_fit", layoutOperationId: intentId,
  })).layoutSettled, true);
  assert.equal(app.requests.length, 3);

  app.editorial.layout.invalidate(intentId, "Manual edit superseded this intent.");
  app.store.editStory(app.slots[0], { body: "Keep this manual copy." });
  const stale = await app.editorial.reviewDraft({
    movedStoryId: app.slots[0], origin: "rendered_fit", layoutOperationId: intentId,
  });
  assert.equal(stale.layoutSuperseded, true);
  assert.equal(app.store.snapshot().layoutOperation.status, "superseded");
  assert.equal(app.requests.length, 3);
});

test("manual edits supersede template completion and stale approval cannot change their copy", async (t) => {
  const app = await setup(t);
  await app.call("editorialize_board");
  const oldApproval = app.approval("template");
  await app.call("apply_layout", {
    baseRevision: app.store.snapshot().issue.revision, template: "newspaper",
    approval: oldApproval, frames: app.frames(),
  });
  await app.call("edit_story", { slotId: app.slots[0], patch: { body: "Keep this exact manual edit." } });
  await until(() => app.store.snapshot().layoutOperation.status === "offered");
  const newId = app.store.snapshot().layoutOperation.id;
  app.idle.resolve();
  await tick(); await tick();
  assert.notEqual(newId, oldApproval.intentId);
  assert.equal(app.store.snapshot().layoutOperation.id, newId);
  assert.equal(app.store.getStory(app.slots[0]).body, "Keep this exact manual edit.");
  const stale = await app.call("apply_layout", {
    baseRevision: app.store.snapshot().issue.revision, frames: app.frames(), approval: oldApproval,
  });
  assert.equal(stale.structuredContent.code, "STALE_LAYOUT");
  assert.equal(app.store.getStory(app.slots[0]).body, "Keep this exact manual edit.");
});

test("failed template writer leaves a visible failed operation and does not start a final style request", async (t) => {
  const app = await setup(t);
  await app.call("editorialize_board");
  await app.call("apply_layout", {
    baseRevision: app.store.snapshot().issue.revision, template: "newspaper",
    approval: app.approval("template"), frames: app.frames(),
  });
  await app.finishWriter(app.slots[0], { failed: true });
  await app.finishWriter(app.slots[1]);
  app.idle.resolve();
  await until(() => app.store.snapshot().layoutOperation.status === "failed");
  assert.match(app.store.snapshot().layoutOperation.reason, /writer did not complete/);
  assert.equal(app.requests.length, 1);
});

test("intent and measurement identity ignore receipt bookkeeping but retain real inputs and fit", () => {
  const story = { id: "a", slotId: "a", headline: "Fixture", body: "Keep this copy.", sourceIds: [],
    frame: { x: 12, y: 44, width: 180, height: 151.5 }, contentVersion: 1,
    typography: { contentVersion: 1, styles: { s0: "medium_regular" }, requestId: "before" } };
  const state = { issue: { id: "paper", stories: [story], sources: [] }, settings: { stage: "editor" } };
  const basis = layoutBasis(state), measured = layoutMeasurementKey(story);
  story.typography.requestId = "after"; story.typography.assessedAt = "later";
  state.issue.revision = 100; state.editorial = { requestId: "new-receipt" };
  assert.equal(layoutBasis(state), basis);
  assert.equal(layoutMeasurementKey(story), measured);
  const measurements = { a: { key: measured, ready: true, requiredHeight: 151.501, overflow: false } };
  assert.equal(tidyLayoutPlan([story], measurements), null, "rounding alone cannot enlarge fitted copy");
  story.body = "A deliberate content change.";
  assert.notEqual(layoutBasis(state), basis);
  story.body = "Keep this copy."; story.frame.width = 273;
  assert.notEqual(layoutBasis(state), basis);
  story.frame.width = 180; state.issue.sources.push({ id: "source", text: "New observed evidence." });
  assert.notEqual(layoutBasis(state), basis);
});

test("paired execution reads are explicit and remain unlogged; raw defaults are unchanged", async (t) => {
  const app = await setup(t);
  const raw = app.trace.record("fixture.record", { payload: { original: true } });
  const reads = [];
  const rawGet = app.trace.get;
  app.trace.getExchange = async (id) => { reads.push(id); return { ...(await rawGet(id)), paired: true }; };
  const before = app.trace.summary().totalRecords;
  const plain = await app.call("get_execution_record", { id: raw.id });
  const paired = await app.call("get_execution_record", { id: raw.id, includeExchange: true });
  const explicitFalse = await app.call("get_execution_record", { id: raw.id, includeExchange: false });
  assert.equal(plain.structuredContent.executionRecord.paired, undefined);
  assert.equal(explicitFalse.structuredContent.executionRecord.paired, undefined);
  assert.equal(paired.structuredContent.executionRecord.paired, true);
  assert.deepEqual(reads, [raw.id]);
  assert.equal(app.trace.summary().totalRecords, before);
});
