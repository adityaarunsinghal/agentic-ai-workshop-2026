import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApplication } from "../src/server.mjs";

test("opening and restarting before any user action preserves the issue and funding scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session2-empty-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    mode: "fixture", fixture: true, stateFile: join(root, "issue.json"),
    exportsDirectory: join(root, "exports"),
  };
  const first = await createApplication(config);
  const id = first.store.snapshot().issue.id;
  await first.close();
  const next = await createApplication(config);
  assert.equal(next.store.snapshot().issue.id, id);
  assert.equal(next.trace.summary().scopeId, id);
  assert.equal(next.trace.summary().capture.status, "complete");
  assert.equal(next.gateway.budget.accountingAvailable, true);
  await next.close();
});

test("the actual fixture composes briefing, general-model editor, Jev and the zero-effect revision action", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session2-progression-"));
  const application = await createApplication({
    mode: "fixture", fixture: true, model: "openai/gpt-6-luna",
    decisionModel: "typesafe/jev-1.13", maxTurns: 10, maxDecisionRequests: 20,
    stateFile: join(root, "issue.json"), exportsDirectory: join(root, "exports"),
  });
  t.after(async () => { await application.close(); await rm(root, { recursive: true, force: true }); });
  const tool = async (name, args = {}) => {
    const result = await application.mcp.callTool(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent;
  };
  assert.equal(application.store.snapshot().settings.stage, "research");
  await tool("set_stage", { stage: "tools" });
  await tool("request_briefing", { prompt: "Find three HN links worth reading about useful agents." });
  await application.agent.waitForIdle();
  const briefing = application.store.snapshot().briefings[0];
  assert.equal(briefing.status, "completed");
  assert.ok(briefing.answer);
  assert.ok(briefing.cards.length);
  assert.equal(application.store.snapshot().issue.stories.length, 0);
  await tool("set_stage", { stage: "editor" });
  await tool("propose_briefing", { sourceIds: briefing.cards.slice(0, 2).map((card) => card.sourceId ?? card.id) });
  assert.equal(application.store.snapshot().issue.stories.length, 0);
  const slotId = randomUUID();
  await tool("create_story", { slotId, frame: { x: 12, y: 46, width: 120, height: 150 } });
  await tool("request_story", {
    slotId, contentVersion: 0,
    prompt: "Draft a short, source-backed story about useful agents using the briefing's observed sources.",
  });
  await application.agent.waitForIdle();
  const draft = application.store.snapshot().issue.stories.find((story) => story.slotId === slotId);
  assert.ok(draft?.headline && draft.body, "The explicit MCP request must produce newspaper copy.");
  assert.ok(draft.sourceIds.length, "The drafted story must retain its observed source lineage.");
  await tool("editorialize_board", { reason: "Compare presentation decisions" });
  const general = application.store.snapshot().editorial;
  assert.equal(general.backend, "chat");
  assert.equal(general.status, "complete");
  await tool("set_stage", { stage: "final" });
  await tool("editorialize_board", { reason: "Compare presentation decisions" });
  const native = application.store.snapshot().editorial;
  assert.equal(native.backend, "decisions");
  assert.equal(native.status, "complete");
  assert.equal(general.inputDigest, native.inputDigest);
  assert.ok(application.store.snapshot().issue.stories.every((story) =>
    typeof story.factCheck.probability === "number"));
  const before = application.store.snapshot();
  const requestCount = application.trace.summary().requestCount;
  const demo = await tool("revise_copy_demo");
  assert.equal(demo.message, "Auto-revisions would have started");
  assert.deepEqual(application.store.snapshot().issue, before.issue);
  assert.equal(application.trace.summary().requestCount, requestCount);
  const page = await tool("list_execution", { limit: 2 });
  assert.equal(page.executionPage.records.length, 2);
  assert.equal(page.issue, undefined);
  const full = await tool("get_execution_record", { id: native.requestId });
  assert.ok(full.executionRecord.payload.questions);
  assert.equal(full.issue, undefined);
  assert.ok(application.store.snapshot().trace.length <= 50);
  assert.ok(application.store.snapshot().trace.every((entry) => entry.payload === undefined));

  const serverRecord = await application.trace.get(native.requestId);
  const browserEvent = {
    id: native.requestId, kind: "mcp.app.initialize", actor: "agent",
    startedAt: new Date().toISOString(),
    operationId: "cannot-create-a-model-operation",
    payload: { authorization: "Bearer synthetic-secret", protocol: "MCP Apps" },
  };
  const response = await application.app.request("/api/execution/browser", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(browserEvent),
  });
  assert.equal(response.status, 200);
  const archived = (await response.json()).record;
  assert.equal(archived.id, `browser:${native.requestId}`);
  assert.equal(archived.actor, "host");
  assert.equal(archived.reportedBy, "browser");
  assert.deepEqual(await application.trace.get(native.requestId), serverRecord);
  assert.equal(application.trace.summary().requestCount, requestCount);
  assert.doesNotMatch(JSON.stringify(await application.trace.get(archived.id)), /synthetic-secret/);
  const rejected = await application.app.request("/api/execution/browser", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), kind: "model" }),
  });
  assert.equal(rejected.status, 400);
});
