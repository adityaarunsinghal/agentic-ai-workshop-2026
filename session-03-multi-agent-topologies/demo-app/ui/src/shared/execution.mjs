// Snapshots carry summaries only. Original records are read from Execution.
export const EXECUTION_PAGE_SIZE = 50;
export const TRACE_SUMMARY_LIMIT = 50;
export const LOCAL_SUMMARY_LIMIT = 24;

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value : [];
const scalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const pick = (value, keys) => Object.fromEntries(keys
  .filter((key) => value?.[key] !== undefined && scalar(value[key]))
  .map((key) => [key, value[key]]));
const count = (...values) => values.find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
const amount = (...values) => values.find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ?? null;

export const kindOf = (record) => String(record.kind ?? record.type ?? "event");
export const actorOf = (record) => record.actor ?? record.caller ?? "harness";
export const statusOf = (record) => record.displayStatus ?? record.status ?? (record.error ? "failed" : "recorded");
export const titleOf = (record) => String(
  record.label ?? record.title ?? record.toolName ?? record.tool ?? record.params?.name ??
  record.name ?? record.purpose ?? record.action?.replaceAll("_", " ") ?? record.method ?? kindOf(record),
);
export const isRunning = (record) => [
  "pending", "queued", "started", "running", "researching", "reading", "writing",
].includes(statusOf(record));

/** An opened record owns its scope; issue-level and unknown links stay global. */
export function executionRunScope({ recordId = null, taskId = "", records = [], jobs = [] } = {}) {
  if (taskId) return taskId;
  if (recordId !== null) {
    const record = records.find((entry) => entry.id === recordId);
    if (record?.taskId || record?.jobId) return record.taskId || record.jobId;
    const job = jobs.find((entry) => entry.id === recordId ||
      (record?.requestId && entry.id === record.requestId));
    return job?.taskId || job?.id || "";
  }
  const current = [...jobs].reverse().find(isRunning);
  return current?.taskId || current?.id || "";
}

export function compactRecord(record) {
  const summary = pick(record, [
    "id", "kind", "type", "actor", "caller", "status", "startedAt", "at", "endedAt",
    "parentId", "operationId", "requestId", "toolCallId", "taskId", "jobId",
    "sequence", "seq", "updatedSequence", "generation", "rawCount", "phase",
    "model", "resolvedModel", "requestKind", "turn", "agentTurn", "maxTurns",
    "durationMs", "beforeRevision", "issueRevision", "inputRevision", "resultRevision",
    "costUsd", "knownCostUsd", "mode", "simulated", "dispatched", "cached", "childCount",
    "view", "detailAvailable", "warning", "reportedBy", "deliveryStatus", "deliveryError",
    "exchangeKind", "exchangeJobId", "exchangeJobStatus", "exchangeIndex", "exchangeCount", "finalExchange",
    "costRole", "workflowId", "workflowRequestCount", "workflowKnownCostUsd", "workflowUnknownCostCount",
    "batchRecordId", "batchIndex", "batchCount", "questionsCount", "cachedBatchCount",
    "displayStatus", "statusReason", "error", "errorCode", "failureCauseId", "affectedStepCount",
    "jsonRecovery", "logicalStepId", "recoveryOfRecordId", "recoveryRecordId", "recoveryEventId",
    "recoveryOfOperationId", "recoveryOperationId", "sourceOperationId", "additionalRequest",
    "localJsonRecovery", "localRecoveryEventId", "outputLimitEventId", "sourceRequestRecordId",
    "outputLimitReached", "stopReason", "recoveryKind", "recoveryCompleteCopies", "recoveryDiscardedPartialCopy",
  ]);
  summary.label = titleOf(record).slice(0, 300);
  if (object(record.usage)) summary.usage = pick(record.usage, [
    "input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "total_tokens",
    "input", "output", "totalTokens", "cost", "cost_usd", "total_cost", "knownCostUsd",
  ]);
  if (typeof record.cost === "number") summary.cost = record.cost;
  else if (object(record.cost)) summary.cost = pick(record.cost, ["usd", "totalUsd", "total"]);
  return summary;
}

export function compactRecords(records, limit = TRACE_SUMMARY_LIMIT) {
  return list(records).filter(object).slice(-limit).map(compactRecord);
}

export function executionParams({ view = "teaching", cursor, query = "", taskId = "", order } = {}) {
  return {
    view: view === "protocol" ? "protocol" : "teaching", limit: EXECUTION_PAGE_SIZE,
    ...(cursor !== undefined && cursor !== null && cursor !== "" ? { cursor } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(taskId ? { taskId } : {}),
    ...(["asc", "desc"].includes(order) ? { order } : {}),
  };
}

export function executionPage(value) {
  const page = value?.executionPage ?? value;
  if (!object(page) || !Array.isArray(page.records)) throw new Error("Execution returned no record page.");
  // A larger response must not silently skip rows when following its cursor.
  if (page.records.length > EXECUTION_PAGE_SIZE) throw new Error("Execution exceeded the 50-record page limit.");
  return {
    records: page.records.filter(object).map(compactRecord),
    nextCursor: page.nextCursor ?? null, total: count(page.total),
    summary: object(page.summary) ? page.summary : {},
  };
}

export function executionRecord(value) {
  const record = value?.executionRecord ?? value?.record;
  if (!object(record) || record.id == null) throw new Error("The original Execution record is unavailable.");
  return record;
}

export function correlatedExchange(record) {
  const exchange = record?.exchange;
  return exchange?.schemaVersion === "workshop.execution.exchange.v1" &&
    exchange.derived === true && exchange.originalRecordId === record.id &&
    exchange.operationId === record.operationId ? exchange : null;
}

export function exchangeTitle(record) {
  const exchange = correlatedExchange(record);
  const kind = exchange?.kind ?? record.exchangeKind;
  if (!kind) return titleOf(record);
  const title = kind === "decision" ? "Decision exchange" : "Model exchange";
  const label = (exchange?.final ?? record.finalExchange) ? `Final ${title.toLowerCase()}` : title;
  return (exchange?.jsonRecovery ?? record.jsonRecovery) ? `${label} · JSON formatting repair` : label;
}

export function exchangeStillCapturing(record) {
  const exchange = correlatedExchange(record);
  return isRunning(record) || Boolean(exchange && (
    isRunning({ status: exchange.jobStatus }) ||
    list(exchange.transport).some((entry) => isRunning(entry.value))
  ));
}

// Never sum the visible page. Unknown or unsettled costs remain separate from
// the server's aggregate known charge.
export function executionTotals(execution = {}, gateway = {}, pageSummary = {}) {
  execution = object(execution) ? execution : {};
  pageSummary = object(pageSummary) ? pageSummary : {};
  const summary = { ...pageSummary, ...execution.summary, ...execution };
  const budget = gateway?.budget ?? (gateway && Object.keys(gateway).length ? gateway : summary.budget) ?? {};
  const usage = summary.usage ?? {};
  const accountingUnavailable = budget.accountingAvailable === false;
  return {
    total: count(summary.total, summary.totalRecords, summary.records),
    requests: count(summary.modelRequests, summary.requestCount, summary.requests, summary.inferenceRequests, usage.requests),
    live: count(summary.liveRequests, summary.live),
    knownCostUsd: accountingUnavailable ? null : amount(budget.knownCostUsd, summary.knownCostUsd, summary.reportedCostUsd, usage.knownCostUsd),
    unknown: accountingUnavailable ? null : count(summary.unknownCostRequests, summary.unsettledRequests, usage.unsettledRequests,
      Array.isArray(budget.unsettledOperations) ? budget.unsettledOperations.length : undefined),
    reservedUsd: accountingUnavailable ? null : amount(budget.reservedUsd, summary.reservedUsd),
    accountingUnavailable,
    accountingError: budget.error ?? budget.accountingError ?? null,
    simulated: budget.simulated === true || summary.simulated === true,
    capture: summary.capture ?? execution.capture ?? null,
  };
}

export function recordDepth(record, records) {
  let depth = 0;
  let parent = record.parentId;
  const visited = new Set([record.id]);
  while (parent && !visited.has(parent) && records.has(parent)) {
    visited.add(parent);
    depth++;
    parent = records.get(parent).parentId;
  }
  return Math.min(depth, 4);
}

export function relatedRecordIds(record, summaries = []) {
  const children = [...list(record?.childIds), ...list(record?.children).map((child) => object(child) ? child.id : child),
    ...summaries.filter((child) => child.parentId === record?.id).map((child) => child.id)];
  return [...new Set(children.filter((id) => ["string", "number"].includes(typeof id) && id !== record?.id))];
}

export function groupTeachingRecords(records) {
  const groups = new Map();
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    let root = record;
    const seen = new Set([record.id]);
    while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
      seen.add(root.parentId);
      root = byId.get(root.parentId);
    }
    const key = record.workflowId ?? record.exchangeJobId ?? record.taskId ?? record.jobId ?? root.taskId ?? root.jobId ?? root.id;
    if (!groups.has(key)) groups.set(key, { id: key, root, records: [] });
    groups.get(key).records.push(record);
  }
  return [...groups.values()];
}

export function durationLabel(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "Time not reported";
  return durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(2)} s`;
}
