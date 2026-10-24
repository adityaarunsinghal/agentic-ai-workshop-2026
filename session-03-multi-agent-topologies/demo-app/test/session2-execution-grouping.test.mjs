import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrace } from "../src/trace.mjs";
import { compactRecords, executionPage } from "../ui/src/shared/execution.mjs";

function pages(trace, options) {
  const records = [];
  let cursor, total;
  do {
    const page = trace.list({ limit: 7, ...options, cursor });
    total ??= page.total;
    assert.equal(page.total, total);
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(records.length, total);
  assert.equal(new Set(records.map((record) => record.id)).size, total);
  return records;
}

test("streamed task progress becomes one lifecycle, while canonical model/tool calls and milestones remain", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "execution-grouping-"));
  const trace = createTrace({ directory, scopeId: "paper" });
  let reopened;
  t.after(async () => {
    await reopened?.close();
    await trace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const jobId = "research-task";
  const root = trace.start("briefing", { jobId });
  for (let i = 0; i < 63; i++) {
    trace.record("agent", { id: `progress-${i}`, action: "job_progress", jobId,
      status: "researching", turn: 1, phase: "generating", partialText: `Visible response ${i}` });
    trace.record("agent.message_update", { id: `delta-${i}`, jobId,
      update: { type: "text_delta", delta: ` ${i}` } });
  }
  const full = { action: "job_progress", jobId, status: "researching",
    turn: 1, phase: "generating", partialText: "The same complete response." };
  const duplicate1 = trace.record("agent", full);
  const duplicate2 = trace.record("agent", full);
  assert.equal(trace.list().total, 1);
  assert.equal(trace.recent()[0].status, "researching");
  const model = trace.start("model", { jobId, operationId: "model-operation", turn: 1 });
  const request = trace.record("model.request", { jobId, operationId: "model-operation", parentId: model.id,
    payload: { messages: [{ role: "user", content: "Full context remains available." }] } });
  trace.record("model.response", { jobId, operationId: "model-operation", parentId: model.id,
    message: { content: [{ type: "text", text: "Visible result" }] } });
  model.finish({ costUsd: 0.01 });
  // Same arguments still mean separate real invocations. There is no teaching
  // cap after the 50th tool call; the second page must expose the remainder.
  const tools = [];
  for (let i = 0; i < 57; i++) {
    const span = trace.start("mcp.call", { jobId, toolCallId: `call-${i}`, tool: "fetch_read",
      payload: { url: "https://example.org/source" } });
    span.finish({ result: { text: `Observation ${i}` } });
    tools.push(span.id);
  }
  const milestones = [
    trace.record("app.approval_requested", { jobId, proposal: { action: "move" } }),
    trace.record("source.read", { jobId, completeForRequestedScope: false,
      losses: [{ code: "THIN_TEXT" }], result: { sourceId: "source-1" } }),
    trace.record("tool.blocked", { jobId, error: "Approval required" }),
    trace.record("story.research_continued", { jobId, turn: 2, reason: "Read the primary source" }),
    ...[1, 2].map((round) => trace.record("auto_research.research", {
      taskId: jobId, round, sources: [{ id: `round-${round}` }],
    })),
  ];
  root.finish({ status: "completed", turn: 2, answer: "The completed briefing." });

  const teaching = pages(trace, { view: "teaching", taskId: jobId, order: "asc" });
  assert.equal(teaching.length, 1 + 1 + tools.length + milestones.length);
  assert.equal(trace.summary().teachingRecords, teaching.length);
  assert.deepEqual(teaching.filter((record) => record.kind === "mcp.call").map((record) => record.id), tools);
  assert.ok(milestones.every((record) => teaching.some((summary) => summary.id === record.id)));
  assert.equal(teaching.find((record) => record.kind === "tool.blocked").status, "failed");
  const task = teaching.find((record) => record.id === root.id);
  assert.equal(task.rawCount, 66);
  assert.equal(task.status, "completed");
  assert.equal(task.turn, 2);
  assert.equal(task.label, "Research briefing");
  assert.equal(teaching.filter((record) => record.operationId === "model-operation").length, 1);
  assert.equal(teaching.find((record) => record.id === model.id).rawCount, 3);
  assert.equal(trace.summary().requestCount, 1);
  assert.equal(trace.summary().reportedCostUsd, 0.01);
  assert.equal(trace.list({ query: duplicate1.id }).records[0].id, root.id);
  assert.equal(trace.list({ query: duplicate1.id }).total, 1);
  const protocol = pages(trace, { view: "protocol", taskId: jobId });
  assert.equal(protocol.length, trace.summary().totalRecords);
  assert.ok(protocol.some((record) => record.id === duplicate1.id));
  assert.ok(protocol.some((record) => record.id === duplicate2.id));
  assert.equal((await trace.get(request.id)).payload.messages[0].content, "Full context remains available.");
  assert.equal((await trace.get("progress-56")).partialText, "Visible response 56");
  assert.equal((await trace.get("delta-56")).update.delta, " 56");
  const compact = compactRecords([task])[0];
  assert.equal(compact.rawCount, 66);
  assert.equal(compact.generation, 0);
  assert.equal(compact.partialText, undefined);
  assert.deepEqual(executionPage(trace.list({ limit: 50 })).records, compactRecords(trace.list({ limit: 50 }).records));
  await trace.close();
  reopened = createTrace({ directory, scopeId: "paper" });
  await reopened.restore();
  const restored = pages(reopened, { view: "teaching", taskId: jobId, order: "asc" });
  assert.deepEqual(restored, teaching);
  assert.equal((await reopened.get(duplicate1.id)).partialText, full.partialText);
  assert.equal((await reopened.get(duplicate2.id)).partialText, full.partialText);
});

test("legacy request start/end records share one counted summary without erasing either original", async (t) => {
  const trace = createTrace();
  t.after(() => trace.close());
  trace.record("app.request_start", { id: "started", operationId: "operation", status: "running" });
  trace.record("app.request_end", { id: "ended", operationId: "operation", costUsd: 0.004 });
  assert.equal(trace.list().total, 1);
  assert.equal(trace.summary().teachingRecords, 1);
  assert.equal(trace.recent()[0].id, "ended");
  assert.equal(trace.recent()[0].rawCount, 2);
  assert.equal(trace.list({ query: "started" }).records[0].id, "ended");
  assert.equal(trace.list({ view: "protocol" }).total, 2);
  assert.equal((await trace.get("started")).status, "running");
  assert.equal((await trace.get("ended")).costUsd, 0.004);
  await trace.restore();
  assert.equal(trace.list().records[0].status, "complete", "the end receipt establishes completion after reload");
});
