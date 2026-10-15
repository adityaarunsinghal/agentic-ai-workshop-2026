import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createIssueStore } from "../domain/store.mjs";
import { createTrace } from "../trace.mjs";
import { createSources } from "../sources/service.mjs";
import { createMcpServer, EDITOR_RESOURCE_URI } from "./server.mjs";
import { connectMcp } from "./client.mjs";
import { SOURCE_TOOLS } from "./access.mjs";

const appTools = [
  "get_editor_state", "new_newspaper", "create_story", "apply_layout", "move_story", "edit_story", "delete_story", "lock_story", "set_focus",
  "set_title", "set_audience", "undo", "redo", "request_story", "cancel_story", "report_story_fit", "editorialize_board",
  "set_decision_model", "set_stage", "export_newspaper", "approve_change",
  "request_briefing", "cancel_briefing", "list_execution", "get_execution_record", "clear_execution", "revise_copy_demo",
];
const modelTools = [
  "read_skill", "inspect_user_preferences", "list_stories", "propose_briefing",
  "save_reading_list", "remember_preferences", "get_story", "get_comments",
  "search_hn", "search_google_news", "search_web", "fetch_read",
];
const frame = { x: 12, y: 46, width: 84, height: 78 };

async function setup(t) {
  const trace = createTrace();
  trace.fetch = async () => { throw new Error("External requests are forbidden."); };
  const store = await createIssueStore({ trace, config: { mode: "fixture" } });
  store.setStage("final");
  const sources = createSources({ store, trace, config: { mode: "fixture" } });
  const ctx = { store, trace, sources, config: { mode: "fixture" } };
  const server = createMcpServer(ctx);
  const mcp = await connectMcp(server, trace);
  const { client } = mcp;
  t.after(async () => { await client.close(); await server.close(); });
  // Assignment after server setup exercises the parent's composition order.
  const requests = [];
  ctx.agent = {
    requestStory(args) {
      requests.push(args);
      const job = store.startJob(args);
      store.updateJob(job.id, { sourceIds: store.snapshot().issue.sources.map((source) => source.id) });
      return job;
    },
    cancelStory(id) { store.updateJob(id, { status: "cancelled" }); },
    requestBriefing(args) { return store.startBriefing(args); },
  };
  const call = (name, args = {}) => mcp.callTool(name, args);
  const write = (args) => mcp.callTool("write_story", args, { actor: "agent", jobId: args.requestId });
  return { trace, store, sources, ctx, client, mcp, requests, call, write };
}

async function requestedStory(app) {
  const source = (await app.sources.getStory({ id: "fixture-hn-900001" })).records[0];
  const slotId = randomUUID();
  await app.call("create_story", { slotId, frame });
  const result = await app.call("request_story", { slotId, prompt: "A synthetic story about tools" });
  assert.equal(result.isError, undefined);
  const job = result.structuredContent.job;
  return {
    job,
    args: { slotId: job.slotId, requestId: job.id, baseContentVersion: job.baseContentVersion,
      headline: "Synthetic workshop report", body: "A fictional editor compared two toy workflows in a local exercise.",
      sourceIds: [source.id] },
  };
}

test("real MCP discovery enforces app, task, and stage authority", async (t) => {
  const app = await setup(t);
  const tools = await app.mcp.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...appTools, ...modelTools].sort());
  for (const name of appTools) {
    const tool = tools.find((entry) => entry.name === name);
    assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    assert.equal(tool._meta.ui.resourceUri, EDITOR_RESOURCE_URI);
  }
  assert.equal(tools.some((tool) => tool.name === "write_story"), false);
  const { resources } = await app.trace.withContext({ actor: "app" }, () => app.client.listResources());
  assert.equal(resources[0].uri, EDITOR_RESOURCE_URI);
  assert.equal(resources[0].mimeType, "text/html;profile=mcp-app");
  const invalid = await app.call("list_stories", { count: 13 });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.issue.id, app.store.snapshot().issue.id);
  const entry = app.trace.entries.find((record) => record.params?.arguments?.count === 13);
  assert.equal(entry.method, "tools/call");
  assert.equal(entry.status, "failed");
  const { job, args } = await requestedStory(app);
  const writer = await app.mcp.listTools({ actor: "agent", jobId: job.id });
  assert.deepEqual(writer.find((tool) => tool.name === "write_story")._meta.ui.visibility, ["model"]);
  assert.equal(writer.some((tool) => tool.name === "propose_briefing"), false);
  assert.equal((await app.call("write_story", args)).structuredContent.code, "TOOL_AUTHORITY");
  app.store.setStage("tools");
  const first = await app.mcp.listTools();
  assert.ok(first.some((tool) => tool.name === "request_briefing"));
  for (const name of ["create_story", "apply_layout", "request_story", "move_story", "editorialize_board", "revise_copy_demo"])
    assert.equal(first.some((tool) => tool.name === name), false);
  assert.equal((await app.call("request_story", { prompt: "No slot in this stage", frame })).structuredContent.code, "TOOL_AUTHORITY");
});

test("rendered fitting is advertised only by a capable backend and remains app-only", async (t) => {
  const app = await setup(t);
  assert.equal((await app.call("get_editor_state")).structuredContent.uiCapabilities.renderedCopyFit, false);
  let reports = 0;
  app.ctx.agent.reportRenderedFit = () => { reports++; return { accepted: false, reason: "stale_or_unavailable" }; };
  assert.equal((await app.call("get_editor_state")).structuredContent.uiCapabilities.renderedCopyFit, true);
  const args = {
    issueId: app.store.snapshot().issue.id, slotId: randomUUID(), contentVersion: 1, frame,
    key: "stale", overflow: true, bodyHeight: 100, availableBodyHeight: 20,
    minimumLineHeight: 24, requiredHeight: 100,
  };
  assert.equal((await app.call("report_story_fit", args)).isError, undefined);
  assert.equal(reports, 1);
  const denied = await app.mcp.callTool("report_story_fit", args, { actor: "agent" });
  assert.equal(denied.isError, true);
  assert.equal(reports, 1);
});

test("briefing recommendations never create newspaper stories in any stage", async (t) => {
  const app = await setup(t);
  const listing = await app.call("list_stories", { count: 2 });
  const sourceIds = listing.structuredContent.records.map((record) => record.id);
  for (const stage of ["tools", "editor", "final", "research"]) {
    app.store.setStage(stage);
    const before = app.store.snapshot().issue;
    const result = await app.call("propose_briefing", { sourceIds });
    assert.deepEqual(result.structuredContent.cards.map((card) => card.id), sourceIds);
    assert.deepEqual(app.store.snapshot().issue, before);
    assert.equal(result.structuredContent.jobs.length, 0);
  }
  assert.equal(app.requests.length, 0);
  const bad = await app.call("propose_briefing", { sourceIds: ["invented-source"] });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.code, "UNKNOWN_SOURCE");
  assert.equal(app.store.snapshot().issue.stories.length, 0);
});

test("briefing accepts matching source lists without losing notes and rejects conflicting lists", async (t) => {
  const app = await setup(t);
  app.store.setStage("tools");
  const listing = await app.call("list_stories", { count: 3 });
  const sourceIds = listing.structuredContent.records.map((record) => record.id);
  const recommendations = sourceIds.slice(0, 2).map((sourceId, index) => ({
    sourceId, note: `Observed source ${index + 1}.`,
  }));
  const { job } = (await app.call("request_briefing", { prompt: "Recommend observed links" })).structuredContent;
  app.store.updateJob(job.id, { sourceIds });
  const args = { issueId: job.issueId, recommendations, sourceIds: sourceIds.slice(0, 2) };
  for (const ids of [args.sourceIds, [...args.sourceIds].reverse()]) {
    const result = await app.mcp.callTool("propose_briefing", { ...args, sourceIds: ids },
      { actor: "agent", jobId: job.id });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.cards.map(({ sourceId, note }) => ({ sourceId, note })), recommendations);
  }
  const before = app.store.snapshot();
  for (const ids of [sourceIds, [sourceIds[0], sourceIds[2]]]) {
    const result = await app.mcp.callTool("propose_briefing", { ...args, sourceIds: ids },
      { actor: "agent", jobId: job.id });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "AMBIGUOUS_BRIEFING");
    assert.deepEqual(app.store.snapshot().briefings, before.briefings);
  }
  assert.deepEqual(app.store.snapshot().issue, before.issue);
});

test("approval binds observed links and topic changes to active session proposals", async (t) => {
  const app = await setup(t);
  const sourceId = (await app.sources.listStories({ count: 1 })).records[0].id;
  const proposed = await app.call("save_reading_list", { sourceIds: [sourceId] });
  assert.equal(proposed.structuredContent.needsApproval, true);
  assert.equal(proposed.structuredContent.preferences.readingList.length, 0);
  await app.call("approve_change", { approvalId: proposed.structuredContent.proposal.id, accepted: true });
  assert.equal(app.store.snapshot().preferences.readingList[0].id, sourceId);
  const preference = await app.call("remember_preferences", { topic: "synthetic tools" });
  await app.call("approve_change", { approvalId: preference.structuredContent.proposal.id, accepted: false });
  assert.equal(app.store.snapshot().preferences.topic, "");
  const bad = await app.call("approve_change", { approvalId: "other-session", accepted: true });
  assert.equal(bad.isError, true);
});

test("writer completion follows moved slots, validates lineage, and reuses an identical write", async (t) => {
  const app = await setup(t);
  const { job, args } = await requestedStory(app);
  const movedFrame = { ...frame, x: 110 };
  await app.call("move_story", { slotId: job.slotId, frame: movedFrame });
  const bad = await app.write({ ...args, sourceIds: ["invented-source"] });
  assert.equal(bad.isError, true);
  const result = await app.write(args);
  assert.equal(result.structuredContent.applied, true);
  const story = app.store.snapshot().issue.stories[0];
  assert.deepEqual(story.frame, movedFrame);
  assert.equal(story.sourceLineage[0].id, args.sourceIds[0]);
  assert.equal(story.sourceLineage[0].synthetic, true);
  assert.equal(story.factCheck.probability, null);
  const revision = app.store.snapshot().issue.revision;
  const reused = await app.write(args);
  assert.equal(reused.structuredContent.reused, true);
  assert.equal(app.store.snapshot().issue.revision, revision);
});

test("manual copy, locks, cancelled jobs, and deleted slots survive late generated writes", async (t) => {
  const app = await setup(t);
  const { job, args } = await requestedStory(app);
  await app.call("edit_story", { slotId: job.slotId, patch: { headline: "Manual headline", body: "Keep the editor's copy." } });
  const alternate = await app.write(args);
  assert.equal(alternate.structuredContent.alternate, true);
  assert.equal(app.store.snapshot().issue.stories[0].body, "Keep the editor's copy.");
  assert.equal(app.store.snapshot().issue.stories[0].alternateDraft.sourceLineage[0].id, args.sourceIds[0]);
  await app.call("cancel_story", { slotId: job.slotId });
  const cancelled = await app.write(args);
  assert.equal(cancelled.structuredContent.applied, false);
  await app.call("delete_story", { slotId: job.slotId });
  await app.write(args);
  assert.equal(app.store.snapshot().issue.stories.length, 0);
  const next = await requestedStory(app);
  await app.call("lock_story", { slotId: next.job.slotId, locked: true });
  const locked = await app.write(next.args);
  assert.equal(locked.structuredContent.alternate, true);
  assert.equal(app.store.snapshot().issue.stories[0].body, "");
  assert.equal(app.store.snapshot().issue.stories[0].locked, true);
});

test("job versions and supersession reject stale writes; metadata alone cannot support generated copy", async (t) => {
  const app = await setup(t);
  const { job, args } = await requestedStory(app);
  const wrong = await app.write({ ...args, baseContentVersion: 99 });
  assert.equal(wrong.isError, true);
  assert.equal(wrong.structuredContent.code, "WRONG_CONTENT_VERSION");
  await app.call("request_story", { slotId: job.slotId, prompt: "A replacement explicit prompt" });
  const obsolete = await app.write(args);
  assert.equal(obsolete.structuredContent.applied, false);
  assert.equal(app.store.snapshot().issue.stories[0].body, "");
  const newJob = app.store.snapshot().jobs.at(-1);
  const metadata = (await app.mcp.callTool("list_stories", { count: 2 },
    { actor: "agent", jobId: newJob.id })).structuredContent.records[1];
  const unsupported = await app.write({
    ...args, requestId: newJob.id, baseContentVersion: newJob.baseContentVersion, sourceIds: [metadata.id],
  });
  assert.equal(unsupported.structuredContent.code, "INSUFFICIENT_EVIDENCE");
});

test("source HTTP context, explicit review, and export retain the parent's interfaces", async (t) => {
  const app = await setup(t);
  const reasons = [];
  app.ctx.editorial = { review: async (args) => { reasons.push(args); return app.store.snapshot(); } };
  app.ctx.exporter = { exportIssue: async ({ format }) => ({
    id: "synthetic-artifact", format, url: "/api/exports/synthetic-artifact",
    revision: app.store.snapshot().issue.revision,
  }) };
  const briefing = app.store.startBriefing({ prompt: "tools" });
  await app.mcp.callTool("search_hn", { query: "tools" },
    { actor: "agent", jobId: briefing.id, requestId: briefing.id });
  const sourceTrace = app.trace.entries.find((entry) => entry.kind === "source.searchHn");
  assert.equal(sourceTrace.jobId, briefing.id);
  assert.equal(sourceTrace.requestId, briefing.id);
  assert.ok(sourceTrace.parentId);
  await app.call("editorialize_board", { reason: "explicit synthetic review" });
  assert.equal(reasons[0].reason, "explicit synthetic review");
  const artifact = await app.call("export_newspaper", { format: "html" });
  assert.equal(artifact.structuredContent.artifact.format, "html");
  assert.equal(artifact.structuredContent.issue.id, app.store.snapshot().issue.id);
});

test("raw clients cannot forge application authority through MCP metadata", async (t) => {
  const app = await setup(t);
  const { tools } = await app.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["read_skill", ...SOURCE_TOOLS].sort());
  const before = app.store.snapshot().issue;
  for (const name of ["create_story", "apply_layout", "request_briefing", "request_story", "write_story", "approve_change", "set_stage", "get_execution_record"]) {
    const result = await app.client.callTool({ name, arguments: {}, _meta: { actor: "app", jobId: "forged" } });
    assert.equal(result.structuredContent.code, "TOOL_AUTHORITY");
    assert.equal(result.structuredContent.issue, undefined);
  }
  assert.deepEqual(app.store.snapshot().issue, before);
});

test("create_story persists an empty UUID block and retries preserve its copy and active job", async (t) => {
  const app = await setup(t);
  const slotId = randomUUID();
  let reviews = 0;
  app.ctx.editorial = { review: async () => { reviews++; } };
  const created = await app.call("create_story", { slotId, frame });
  assert.equal(created.structuredContent.created, true);
  const empty = app.store.getStory(slotId);
  assert.equal(empty.id, slotId);
  assert.equal(empty.slotId, slotId);
  assert.equal(empty.status, "draft");
  assert.equal(empty.headline, "");
  assert.equal(empty.body, "");
  assert.equal(app.store.snapshot().jobs.length, 0);
  assert.equal(reviews, 0);
  assert.equal(app.requests.length, 0);
  await app.call("edit_story", { slotId, patch: { headline: "", body: "Manual copy in the new block." } });
  await app.call("request_story", { slotId, prompt: "Explicit generation", contentVersion: 1 });
  await app.call("lock_story", { slotId, locked: true });
  const before = app.store.snapshot();
  const repeated = await app.call("create_story", { slotId, frame: { ...frame, x: 110 } });
  assert.equal(repeated.structuredContent.created, false);
  assert.deepEqual(app.store.snapshot().issue, before.issue);
  assert.deepEqual(app.store.snapshot().jobs, before.jobs);
  assert.equal(app.requests.length, 1);
});

test("canonical arguments reject removed aliases and generation cannot create a slot", async (t) => {
  const app = await setup(t);
  const slotId = randomUUID();
  const before = app.store.snapshot().issue;
  assert.equal((await app.call("request_story", { slotId, prompt: "No existing block" })).structuredContent.code, "UNKNOWN_SLOT");
  assert.equal((await app.call("request_story", { prompt: "No implicit creation", frame })).isError, true);
  assert.deepEqual(app.store.snapshot().issue, before);
  await app.call("create_story", { slotId, frame });
  for (const [name, args] of [
    ["list_stories", { limit: 3 }], ["list_stories", { category: "jobs", count: 3 }],
    ["move_story", { storyId: slotId, frame }], ["edit_story", { id: slotId, patch: { body: "No" } }],
    ["delete_story", { id: slotId }], ["lock_story", { issueId: before.id, slotId, locked: true }],
    ["approve_change", { id: "old-alias", accepted: true }],
    ["approve_change", { proposalId: "old-alias", accepted: true }],
    ["propose_briefing", { sourceIds: ["unused"], frame }],
  ]) assert.equal((await app.call(name, args)).isError, true, name);
  const { args } = await requestedStory(app);
  assert.equal((await app.write({ ...args, contentVersion: args.baseContentVersion })).isError, true);
  const { baseContentVersion: _version, ...missingVersion } = args;
  assert.equal((await app.write(missingVersion)).isError, true);
});

test("size changes schedule resize for blank and pending blocks without reviewing empty copy", async (t) => {
  const app = await setup(t), slotId = randomUUID();
  const resizes = [], reviews = [];
  app.ctx.editorial = { review: async (args) => { reviews.push(args); } };
  app.ctx.agent.resizeStory = async (args) => {
    resizes.push({ args, context: app.trace.context(), story: app.store.getStory(args.slotId) });
    return { scheduled: Boolean(app.store.getStory(args.slotId).requestId), requestId: "resize-1" };
  };
  await app.call("create_story", { slotId, frame });
  const moved = await app.call("move_story", { slotId, frame: { ...frame, x: 20 } });
  assert.equal(moved.structuredContent.resized, false);
  assert.equal(reviews.length, 0);
  assert.equal(resizes.length, 0);
  const revision = app.store.snapshot().issue.revision;
  await app.call("move_story", { slotId, frame: { ...frame, x: 20 } });
  assert.equal(reviews.length, 0);
  assert.equal(app.store.snapshot().issue.revision, revision);
  const resized = await app.call("move_story", { slotId, frame: { ...frame, x: 20, width: 100 } });
  assert.equal(resized.structuredContent.resized, true);
  assert.equal(resized.structuredContent.resize.scheduled, false);
  assert.equal(resizes.length, 1);
  assert.equal(resizes[0].context.previousFrame.width, frame.width);
  assert.equal(resizes[0].context.movedStoryId, slotId);
  assert.equal(resizes[0].story.frame.width, 100);
  await app.call("request_story", { slotId, prompt: "A pending writer" });
  const requestId = app.store.getStory(slotId).requestId;
  const pending = await app.call("move_story", { slotId, frame: { ...frame, width: 110 } });
  assert.equal(pending.structuredContent.resize.scheduled, true);
  assert.equal(app.store.getStory(slotId).requestId, requestId);
  assert.equal(resizes.length, 2);
  assert.equal(reviews.length, 0);
  await app.call("lock_story", { slotId, locked: true });
  assert.equal((await app.call("move_story", { slotId, frame })).isError, true);
  assert.equal(resizes.length, 2);
});

test("accepted cleanups preserve copy without another review or per-story resize", async (t) => {
  const app = await setup(t);
  const slotIds = [randomUUID(), randomUUID()];
  await app.call("create_story", { slotId: slotIds[0], frame });
  await app.call("create_story", { slotId: slotIds[1], frame: { ...frame, x: 110 } });
  for (const slotId of slotIds) app.store.editStory(slotId, { body: "Retained manual copy." });
  app.store.update((_issue, state) => { state.settings.layoutCleanup = "offer_tidy"; }, { history: false });
  const before = app.store.snapshot();
  let reviews = 0, resizes = 0;
  app.ctx.editorial = { review: async ({ reason }) => { assert.equal(reason, "layout_applied"); reviews++; } };
  app.ctx.agent.resizeStory = () => { resizes++; };
  const applied = await app.call("apply_layout", {
    baseRevision: before.issue.revision,
    frames: slotIds.map((slotId, index) => ({ slotId, frame: { ...frame, x: index ? 110 : 12, height: 50 } })),
  });
  assert.equal(applied.structuredContent.applied, true);
  assert.equal(applied.structuredContent.issueRevision, before.issue.revision + 1);
  assert.equal(app.store.snapshot().settings.layoutCleanup, undefined);
  assert.equal(reviews, 0);
  assert.equal(resizes, 0);
  for (const story of app.store.snapshot().issue.stories) {
    assert.equal(story.body, "Retained manual copy.");
    assert.equal(story.contentVersion, 1);
  }
  const stale = await app.call("apply_layout", {
    baseRevision: before.issue.revision,
    frames: [{ slotId: slotIds[0], frame }],
  });
  assert.equal(stale.structuredContent.code, "STALE_LAYOUT");
  assert.equal(reviews, 0);
});

test("selecting editor or final with body copy triggers the selected stage's review", async (t) => {
  const app = await setup(t), slotId = randomUUID(), reviews = [];
  app.ctx.editorial = { review: async ({ reason }) => {
    reviews.push({ reason, stage: app.store.snapshot().settings.stage });
  } };
  await app.call("create_story", { slotId, frame });
  await app.call("set_stage", { stage: "editor" });
  assert.equal(reviews.length, 0);
  app.store.editStory(slotId, { body: "Existing copy." });
  await app.call("set_stage", { stage: "final" });
  await app.call("set_stage", { stage: "tools" });
  await app.call("set_stage", { stage: "editor" });
  assert.deepEqual(reviews, [
    { reason: "stage_changed", stage: "final" },
    { reason: "stage_changed", stage: "editor" },
  ]);
  assert.equal(app.store.getStory(slotId).body, "Existing copy.");
  assert.equal(app.store.snapshot().jobs.length, 0);
});

test("changing stage clears visible execution before a new review and retains archived records and newspaper content", async (t) => {
  const app = await setup(t), slotId = randomUUID();
  await app.call("create_story", { slotId, frame });
  app.store.editStory(slotId, { body: "Keep this copy across the workshop progression." });
  const previous = app.trace.record("fixture.old_stage", { label: "Earlier activity" });
  const issue = app.store.snapshot().issue;
  const generation = app.trace.generation;
  let reviewCount = -1;
  app.ctx.editorial = {
    cancel() {},
    review: async () => { reviewCount = app.trace.summary().totalRecords; },
  };
  const result = await app.call("set_stage", { stage: "tools" });
  assert.equal(result.isError, undefined);
  assert.equal(app.trace.generation, generation + 1);
  assert.equal(app.trace.summary().totalRecords, 0);
  assert.equal((await app.trace.get(previous.id)).kind, "fixture.old_stage");
  assert.equal((await app.trace.get(previous.id)).generation, generation);
  assert.equal(app.store.getStory(slotId).body, issue.stories[0].body);
  assert.equal(app.store.snapshot().issue.id, issue.id);
  assert.equal(reviewCount, -1);
  await app.call("set_stage", { stage: "editor" });
  assert.equal(app.trace.generation, generation + 2);
  assert.equal(reviewCount, 1, "the new stage starts with its own editorial trigger");
  const currentGeneration = app.trace.generation;
  await app.call("set_stage", { stage: "editor" });
  assert.equal(app.trace.generation, currentGeneration, "selecting the current stage is not a reset");
});

test("web snippets remain task-owned discovery and cannot substitute for read story evidence", async (t) => {
  const app = await setup(t);
  const { job, args } = await requestedStory(app);
  const web = await app.mcp.callTool("search_web", { query: "workshop" }, { actor: "agent", jobId: job.id });
  const source = web.structuredContent.records[0];
  assert.equal(source.evidenceLevel, "search-snippet");
  assert.equal((await app.write({ ...args, sourceIds: [source.id] })).structuredContent.code, "INSUFFICIENT_EVIDENCE");
  const other = app.store.startBriefing({ prompt: "Another task" });
  const denied = await app.mcp.callTool("propose_briefing", {
    sourceIds: [source.id],
  }, { actor: "agent", jobId: other.id });
  assert.equal(denied.structuredContent.code, "UNOBSERVED_SOURCE");
  const reading = await app.mcp.callTool("fetch_read", { sourceId: source.id }, { actor: "agent", jobId: job.id });
  assert.equal(reading.structuredContent.records[0].evidenceLevel, "article-text");
});

test("Execution reads return only their requested data and do not recursively record reads", async (t) => {
  const app = await setup(t);
  const record = { id: "record-1", sequence: 1, kind: "model.request", payload: { complete: true } };
  const summary = { totalRecords: 1, teachingRecords: 1, latestSequence: 1,
    requestCount: 1, reportedCostUsd: 0, capture: { status: "complete", droppedRecords: 0, errors: [] } };
  let query;
  app.trace.list = (args) => { query = args; return { records: [{ id: record.id, sequence: 1 }], nextCursor: null, total: 1, summary }; };
  app.trace.get = async (id) => id === record.id ? record : null;
  const count = app.trace.entries.length;
  const page = await app.call("list_execution", { limit: 1, query: "model", taskId: "task-1" });
  assert.deepEqual(Object.keys(page.structuredContent), ["executionPage"]);
  assert.deepEqual(query, { view: "teaching", order: "desc", limit: 1, query: "model", taskId: "task-1" });
  assert.deepEqual(page.structuredContent.executionPage.summary, summary);
  const detail = await app.call("get_execution_record", { id: record.id });
  assert.deepEqual(detail.structuredContent, { executionRecord: record });
  await app.call("list_execution", { view: "protocol", cursor: "10", limit: 1 });
  assert.deepEqual(query, { view: "protocol", order: "desc", cursor: "10", limit: 1 });
  const invalid = await app.call("list_execution", { limit: 101 });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.issue, undefined);
  assert.equal(app.trace.entries.length, count);
});

test("only final exposes the revision placeholder and it changes no issue or jobs", async (t) => {
  const app = await setup(t);
  let calls = 0;
  app.ctx.agent = { requestStory() { calls++; }, requestBriefing() { calls++; } };
  app.ctx.editorial = { review() { calls++; } };
  app.store.setStage("editor");
  assert.equal((await app.call("revise_copy_demo")).structuredContent.code, "TOOL_AUTHORITY");
  app.store.setStage("final");
  const before = app.store.snapshot();
  const result = await app.call("revise_copy_demo");
  assert.equal(result.structuredContent.message, "Auto-revisions would have started");
  assert.deepEqual(app.store.snapshot().issue, before.issue);
  assert.deepEqual(app.store.snapshot().jobs, before.jobs);
  assert.equal(calls, 0);
  assert.equal(app.trace.entries.filter((entry) => entry.kind === "teaching.placeholder").length, 1);
});
