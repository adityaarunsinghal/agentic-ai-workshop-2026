import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionLog } from "../src/execution-log.mjs";
import { compactRecord, executionPage, statusOf } from "../ui/src/shared/execution.mjs";

// Captured October 15 decision/batch shape, with replacement IDs and newspaper
// input. In the recorded run, 28 operations produced 140 captured records plus
// one review. The per-operation receipt appeared on both decision and batch.
const payload = { state: { stories: [{ id: "example", text: "A workshop example." }] },
  questions: { font: { type: "choice", choices: ["small", "medium", "large"] } } };
const answers = { font: { choice: "medium" } };
function decision(log, index, { root = "review", cost = 0.000683214, error, status = "completed" } = {}) {
  const operationId = `operation-${index}`, batchId = `batch-${index}`, id = `decision-${index}`;
  const correlation = { operationId, requestId: root, model: "typesafe/jev-1.13", actor: "editor" };
  const usage = cost === null ? null : { input_tokens: 16267, output_tokens: 5197, cost };
  log.record({ id: batchId, kind: "editorial.batch", parentId: root, status: "running",
    backend: "decisions", batchIndex: index, batchCount: 28, questionsCount: 1, cached: false, payload });
  log.record({ ...correlation, id, kind: "decision", parentId: batchId, status,
    state: payload.state, questions: payload.questions, answers, usage, error });
  log.record({ ...correlation, id: `${id}-request`, kind: "decision.request", parentId: id, payload });
  log.record({ ...correlation, id: `${id}-http`, kind: "decision.http", parentId: id,
    status: error ? error.code === "ABORTED" ? "cancelled" : "failed" : "complete",
    httpStatus: error?.code === "INVALID_REQUEST" ? 400 : error ? undefined : 200,
    payload, result: error ? { error } : { answers, usage },
    ...(error?.code === "ABORTED" ? { error: error.message } : {}) });
  log.record({ ...correlation, id: `${id}-response`, kind: "decision.response", parentId: id,
    status: error?.code === "INVALID_REQUEST" ? 400 : 200, body: JSON.stringify(error ? { error } : { answers, usage }) });
  log.update(batchId, { operationId, status: error ? "failed" : "complete", usage,
    ...(error ? { error: error.message, code: error.code } : {}) });
  return id;
}
function allPages(log, options = {}) {
  let cursor, total;
  const rows = [];
  do {
    const page = log.list({ ...options, limit: 7, cursor });
    total ??= page.total;
    assert.equal(page.total, total);
    rows.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(rows.length, total);
  assert.equal(new Set(rows.map((row) => row.id)).size, total);
  return rows;
}

test("28 recorded-shape calls have 28 cost rows and one explicit review aggregate, with exact paging and raw I/O", async (t) => {
  const log = createExecutionLog();
  t.after(() => log.close());
  log.record({ id: "review", kind: "editorial", status: "complete", knownCostUsd: 27 * 0.000683214 });
  for (let index = 1; index <= 28; index++) decision(log, index, { cost: index === 28 ? null : 0.000683214 });
  const originals = log.readAll();
  const rows = allPages(log, { order: "asc" });
  assert.equal(rows.length, 29);
  assert.equal(log.summary().teachingRecords, rows.length);
  assert.equal(log.summary().requestCount, 28);
  assert.equal(allPages(log, { view: "protocol" }).length, 141);
  assert.equal(rows.filter((row) => row.costRole === "request").length, 28);
  assert.equal(rows.some((row) => row.kind === "editorial.batch"), false);
  const review = compactRecord(rows.find((row) => row.id === "review"));
  assert.equal(review.costRole, "aggregate");
  assert.equal(review.workflowRequestCount, 28);
  assert.equal(review.workflowUnknownCostCount, 1);
  assert.ok(Math.abs(review.workflowKnownCostUsd - 27 * 0.000683214) < 1e-12);
  assert.equal(review.workflowKnownCostUsd, log.summary().reportedCostUsd);
  assert.deepEqual(allPages(log).map((row) => row.id), rows.map((row) => row.id).reverse());
  assert.equal(log.list({ query: "batch-28" }).total, 1);
  assert.equal(log.list({ query: "batch-28" }).records[0].id, "decision-28");
  const row = executionPage(log.list({ query: "decision-28" })).records[0];
  assert.equal(row.rawCount, 5);
  assert.equal(row.batchRecordId, "batch-28");
  assert.equal(row.batchIndex, 28);
  assert.equal(row.questionsCount, 1);
  assert.equal(row.costUsd, undefined);
  assert.equal(row.finalExchange, true);
  const { exchange } = await log.getExchange("batch-28");
  assert.equal(exchange.count, 28);
  assert.deepEqual(exchange.request.http[0].value, payload);
  assert.deepEqual(exchange.response.http[0].value, { answers, usage: null });
  assert.ok(exchange.originalRecordIds.includes("batch-28"));
  assert.deepEqual(log.readAll(), originals);
});

test("live batches merge by proven parentage; caches and uncorrelated operations do not fabricate requests", async (t) => {
  const log = createExecutionLog();
  t.after(() => log.close());
  log.record({ id: "review", kind: "editorial", status: "running" });
  log.record({ id: "live-batch", kind: "editorial.batch", parentId: "review", status: "running" });
  log.record({ id: "live-call", kind: "decision", parentId: "live-batch", operationId: "op", status: "running" });
  assert.equal(log.list().total, 2);
  assert.equal(log.list().records.find((row) => row.id === "live-call").batchRecordId, "live-batch");
  log.record({ id: "cache-review", kind: "editorial", status: "complete", cachedBatchCount: 1 });
  log.record({ id: "cached", kind: "editorial.batch", parentId: "cache-review", operationId: "op",
    cached: true, usage: { cost: 0.5 } });
  log.record({ id: "missing", kind: "editorial.batch", operationId: "missing-operation", error: "No request captured" });
  const rows = log.list().records;
  assert.equal(rows.find((row) => row.id === "cache-review").workflowRequestCount, 0);
  assert.equal(rows.find((row) => row.id === "cached").costRole, "metadata");
  assert.equal((await log.getExchange("cached")).exchange, undefined);
  assert.equal(log.summary().requestCount, 1);
  assert.equal(log.summary().reportedCostUsd, null);
  assert.equal(rows.find((row) => row.id === "missing").exchangeKind, undefined);
});

test("only proven aborts become Superseded; genuine errors retain one cause and linked affected steps", async (t) => {
  const log = createExecutionLog();
  t.after(() => log.close());
  const message = "An explicit newspaper change replaced the layout operation.";
  log.record({ id: "review", kind: "editorial", status: "superseded", supersededReason: message,
    error: message, errorCode: "ABORTED" });
  decision(log, 1, { cost: null, status: "failed", error: { code: "ABORTED", message } });
  const cancelled = compactRecord(log.list().records.find((row) => row.id === "decision-1"));
  assert.equal(statusOf(cancelled), "superseded");
  assert.equal(cancelled.statusReason, message);
  assert.equal(cancelled.costUsd, undefined);
  assert.equal((await log.get("decision-1")).status, "failed");
  assert.equal(log.list({ view: "protocol", query: "decision-1" }).records.find((row) => row.id === "decision-1").displayStatus, undefined);
  log.update("decision-1", { error: { message: "Malformed provider output" } });
  assert.equal(statusOf(log.list().records.find((row) => row.id === "decision-1")), "failed",
    "an untyped provider error is not hidden merely because a related transport was cancelled");

  const invalid = { code: "INVALID_REQUEST", message: "Choice requires at least two options" };
  log.record({ id: "outer", kind: "story.editorial", status: "failed", error: invalid.message });
  log.record({ id: "invalid", kind: "editorial", parentId: "outer", status: "failed",
    error: invalid.message, errorCode: invalid.code, layoutIntentId: "layout-action" });
  log.record({ id: "layout", kind: "layout.completion", parentId: "outer", operationId: "layout-action",
    status: "failed", error: invalid.message, code: invalid.code });
  decision(log, 2, { root: "invalid", cost: null, status: "failed", error: invalid });
  const rows = log.list().records;
  const failure = compactRecord(rows.find((row) => row.id === "decision-2"));
  assert.equal(statusOf(failure), "failed");
  assert.equal(failure.error, invalid.message);
  assert.equal(failure.affectedStepCount, 3);
  assert.equal(rows.find((row) => row.id === "invalid").failureCauseId, failure.id);
  assert.equal(rows.find((row) => row.id === "outer").failureCauseId, failure.id);
  assert.equal(rows.find((row) => row.id === "layout").failureCauseId, failure.id);
  assert.equal((await log.getExchange(failure.id)).executionPresentation.affectedSteps.length, 3);
  log.update("invalid", { status: "superseded", supersededReason: "Newer edit" });
  assert.equal(statusOf(log.list().records.find((row) => row.id === failure.id)), "failed",
    "a later obsolete parent must not hide the provider's 400");
});

test("local JSON recovery and output limits are inspectable metadata; paid repair is another real request in the same step", async (t) => {
  const log = createExecutionLog();
  t.after(() => log.close());
  log.record({ id: "run", kind: "auto_research.run", taskId: "run", status: "complete" });
  log.record({ id: "experiment", kind: "auto_research.experiment", parentId: "run", taskId: "run" });
  const first = { operationId: "op-1", taskId: "run", parentId: "experiment" };
  log.record({ ...first, id: "model-1", kind: "model", turn: 6, status: "complete", costUsd: 0.01 });
  log.record({ ...first, id: "request-1", kind: "model.request", payload: { max_tokens: 4096 } });
  log.record({ ...first, id: "response-1", kind: "model.response", message: { content: '{"complete":true} {"part' } });
  log.record({ ...first, id: "limit", kind: "model.output_limit", stopReason: "length", outputLimitReached: true });
  log.record({ ...first, id: "local-recovery", kind: "model.json_recovery", status: "recovered",
    recovery: { kind: "complete_json_copy", completeCopies: 1, discardedPartialCopy: true },
    stopReason: "length", outputLimitReached: true });
  const before = await log.get("response-1");
  let rows = log.list().records;
  assert.equal(rows.find((row) => row.id === "local-recovery").label, "JSON response recovered locally");
  assert.equal(rows.find((row) => row.id === "local-recovery").sourceRequestRecordId, "model-1");
  assert.equal(rows.find((row) => row.id === "model-1").localJsonRecovery, true);
  assert.equal(rows.find((row) => row.id === "limit").costRole, "metadata");
  assert.equal(log.summary().requestCount, 1);
  assert.equal(log.summary().reportedCostUsd, 0.01);
  assert.equal(statusOf(rows.find((row) => row.id === "limit")), "complete");
  log.record({ id: "repair", kind: "auto_research.repair", taskId: "run", parentId: "experiment",
    logicalStepId: "experiment", sourceOperationId: "op-1", status: "running" });
  assert.equal(log.summary().requestCount, 1, "a repair plan is not a model request");
  log.record({ id: "model-2", kind: "model", taskId: "run", operationId: "op-2",
    parentId: "repair", turn: 1, status: "complete", costUsd: 0.02 });
  log.record({ id: "request-2", kind: "model.request", taskId: "run", operationId: "op-2",
    parentId: "model-2", payload: { messages: [{ role: "user", content: "Repair the JSON format." }] } });
  log.update("repair", { status: "complete" });
  rows = log.list().records;
  assert.deepEqual(rows.filter((row) => row.finalExchange).map((row) => row.id), ["model-2"],
    "a repair resetting its internal turn counter is still the last observed request");
  const repair = compactRecord(rows.find((row) => row.id === "model-2"));
  assert.equal(repair.jsonRecovery, true);
  assert.equal(repair.logicalStepId, "experiment");
  assert.equal(repair.recoveryEventId, "repair");
  assert.equal(repair.recoveryOfRecordId, "model-1");
  assert.equal(log.summary().requestCount, 2);
  assert.equal(log.summary().reportedCostUsd, 0.03);
  assert.deepEqual(await log.get("response-1"), before);
  assert.equal((await log.getExchange("model-1")).exchange.localRecoveryEventId, "local-recovery");
});
