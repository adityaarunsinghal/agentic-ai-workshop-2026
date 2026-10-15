/**
 * A portable, server-owned execution archive.
 *
 * Small summaries travel to the interface. Captured records and shared payload
 * objects stay on disk until a person asks to inspect them. Diagnostic failure
 * never grants authority, changes a budget, or throws into application work.
 */
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, openSync, readSync,
  closeSync, existsSync, statSync,
} from "node:fs";
import { appendFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

const FORMAT = "workshop.execution.v1";
const REDACT = /^(authorization|proxy-authorization|cookie|set-cookie|(?:x[-_])?api[-_]?key|(?:access[-_]|refresh[-_]|run[-_]|visit[-_]|development[-_]|workshop[-_])?token|password|secret|credentials?|private[-_]?key|provider[-_]?replay|reasoning(?:[-_](?:details|content|text))?|thinking|thoughts?|thinkingSignature|thoughtSignature|encrypted[-_]content)$/i;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const encoded = (value) => JSON.stringify(value);
const sizeOf = (value) => Buffer.byteLength(encoded(value));
const clip = (value, length = 180) => typeof value === "string" ? value.slice(0, length) : undefined;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const eventTime = (value, fallback) => {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : fallback;
};
const terminalFailure = (entry) => Boolean(entry.error) ||
  ["failed", "error", "aborted", "cancelled", "canceled", "interrupted", "blocked", "charge-unavailable"].includes(entry.status);
const autoResearchLabels = {
  "auto_research.run": "Auto research",
  "auto_research.audit": "Audit claims and set goals",
  "auto_research.research": "Research evidence",
  "auto_research.experiment": "Experiment with revised copy",
  "auto_research.evaluate": "Evaluate baseline and candidate",
  "auto_research.repair": "Repair revision format",
  "auto_research.keep": "Keep candidate",
  "auto_research.revert": "Revert candidate",
  "auto_research.stop": "Stop auto research",
};
const researchField = (entry, key) => entry[key] ?? entry.payload?.[key];
const taskOf = (entry) => entry.taskId ?? entry.jobId ?? entry.briefingId ??
  (Object.hasOwn(autoResearchLabels, entry.kind) ? researchField(entry, "runId") : null);
const finished = (entry) => terminalFailure(entry) ||
  ["completed", "complete", "done", "incomplete", "stopped", "superseded"].includes(entry.status);
const exchangeKind = (entry) => {
  const kind = entry.kind ?? entry.type;
  if (["model", "model.request", "model.response", "model.http", "model.http_response",
    "model.sdk_payload", "model.sdk_response", "model.provider_event",
    "app.request_start", "app.request_end"].includes(kind)) return "model";
  if (["decision", "decision.request", "decision.http", "decision.response"].includes(kind)) return "decision";
  return null;
};
const exchangeRoot = (entry) => ["story", "briefing", "editorial", "auto_research.run"].includes(entry.kind);
const recoveryEvent = (entry) => ["model.json_recovery", "model.output_limit"].includes(entry.kind);
const cancellationCodes = new Set(["ABORTED", "CANCELLED", "CANCELED", "ERR_CANCELED", "ABORT_ERR"]);
const cancellationStatus = (entry) => ["aborted", "cancelled", "canceled", "superseded"].includes(entry.status);
const cancellationEvidence = (entry) => cancellationStatus(entry) || cancellationCodes.has(entry.errorCode);
const providerFailure = (entry) => entry.httpStatus >= 400 ||
  (typeof entry.status === "number" && entry.status >= 400) ||
  (entry.errorCode && !cancellationCodes.has(entry.errorCode));

// Group only correlated lifecycles. Equal arguments do not establish that two
// tool calls are the same operation. Every ID remains in the Protocol index.
function logicalIdentity(entry) {
  const kind = entry.kind ?? entry.type;
  const task = taskOf(entry);
  if (task && (["story", "briefing"].includes(kind) ||
    /^(?:story|briefing)\.(?:queued|admitted|finished)$/.test(kind) ||
    (kind === "agent" && ["job_progress", "job_started", "briefing_started"].includes(entry.action))))
    return { key: `task:${task}`, type: "task", priority: ["story", "briefing"].includes(kind) ? 3 : 1 };
  if (entry.operationId && exchangeKind(entry))
    return { key: `exchange:${entry.operationId}`, type: "model",
      priority: ["model", "decision"].includes(kind) ? 4
        : ["model.response", "decision.response", "app.request_end"].includes(kind) ? 3 : 1 };
  if (entry.toolCallId && (kind === "mcp.call" ||
    (kind === "mcp" && entry.method === "tools/call")))
    return { key: `tool:${task ?? entry.agentRunId ?? ""}:${entry.toolCallId}`, type: "tool",
      priority: kind === "mcp.call" ? 3 : 1 };
  return null;
}

export function sanitizeExecution(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:api_key|access_token|token|key|signature)=)[^&#\s]*/gi, "$1[redacted]");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular diagnostic value]";
  if (depth > 40) return { captureIncomplete: true, reason: "Diagnostic nesting limit" };
  seen.add(value);
  const thought = /^(thinking|reasoning)(?:_|$)/.test(value.type || "");
  const result = Array.isArray(value)
    ? value.map((item) => sanitizeExecution(item, seen, depth + 1))
    : Object.fromEntries(Object.entries(value).filter(([, item]) =>
      item !== undefined && typeof item !== "function").map(([key, item]) => [
      key, REDACT.test(key) || (thought && ["text", "delta", "content"].includes(key))
        ? "[retained on server]"
        : key === "trace" && Array.isArray(item)
          ? { records: item.length, availableInExecution: true }
          : sanitizeExecution(item, seen, depth + 1),
    ]));
  seen.delete(value);
  return result;
}

function teachingEvent(entry) {
  const kind = String(entry.kind ?? entry.type ?? "event");
  if (terminalFailure(entry)) return true;
  if (entry.captureIncomplete || entry.completeForRequestedScope === false || entry.losses?.length) return true;
  // These are decisions in the research loop, separate from the model/tool
  // requests that produced their evidence. Their original payload stays here.
  if (Object.hasOwn(autoResearchLabels, kind)) return true;
  if (recoveryEvent(entry)) return true;
  if (["get_editor_state", "list_execution", "get_execution_record"].includes(
    entry.toolName ?? entry.tool ?? entry.params?.name ?? entry.payload?.name,
  )) return false;
  if (kind === "mcp") {
    // Agent tool execution has a parent mcp.call row. Direct app calls have
    // only the canonical server span and must remain visible to the student.
    if (entry.mcpRequestId !== undefined && entry.actor === "agent" &&
      entry.method === "tools/call") return false;
    return ["initialize", "tools/list", "tools/call", "resources/read"].includes(entry.method);
  }
  if (logicalIdentity(entry)) return true;
  if (/^model\./.test(kind)) return false;
  if (/^agent\.(?:message_|tool_execution_|turn_|agent_)/.test(kind)) return false;
  if (/^(?:message_|turn_)/.test(kind)) return false;
  if (/^source\./.test(kind)) return false;
  if (["http", "story.finished", "story.queued", "story.admitted",
    "story.written", "story.fit", "mcp.list", "model.sdk_payload",
    "inference.final_reserved", "inference.final_released", "inference.reserved",
    "inference.settlement", "app.recovery", "cache"].includes(kind)) return false;
  return true;
}

const labels = {
  model: "Model request", "app.request_start": "Model request started",
  "app.request_end": "Model request completed", "agent.final_turn": "Final turn: tools disabled",
  "app.briefing_start": "Briefing started", "app.briefing_end": "Briefing finished",
  "app.hn_observation": "HN evidence received", "app.skill_loaded": "Briefing recipe loaded",
  "app.approval_requested": "Your approval is needed",
  "app.approval_decision": "Approval decision", "app.user_preferences_saved": "Preferences saved",
  "app.fixed_source_call": "Application chose the HN lookup",
  "story.fit_rewrite": "Fit rewrite within the same allowance",
  "story.draft": "Draft result", "mcp.exposure": "Tools available to the model",
  "mcp.app.initialize": "Editor app initialized", "mcp.resource": "Editor resource loaded",
  "teaching.revise_copy": "Auto-revision teaching placeholder",
  "model.json_recovery": "JSON formatting recovery",
  "model.output_limit": "Model output limit reached",
};

function reportedCost(entry) {
  for (let value of [entry.costUsd, entry.usage?.cost, entry.usage?.cost_usd, entry.usage?.total_cost]) {
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function project(entry, sequence, updatedSequence) {
  const kind = String(entry.kind ?? entry.type ?? "event");
  const research = Object.hasOwn(autoResearchLabels, kind);
  const tool = entry.toolName ?? entry.tool ?? entry.params?.name ?? entry.payload?.name;
  let title = entry.label ?? (research ? autoResearchLabels[kind] : undefined) ??
    labels[kind] ?? entry.purpose ?? entry.action ??
    (kind === "mcp" ? `${entry.method ?? "MCP"}${tool ? ` · ${tool}` : ""}` : tool) ??
    kind.replaceAll("_", " ");
  const round = research ? researchField(entry, "round") : undefined;
  // The label survives the browser's scalar-only projection. Do not require
  // full phase payloads in snapshots just to identify a cycle.
  if (Number.isSafeInteger(round) && round > 0 &&
    !new RegExp(`^(?:Cycle|Round) ${round}\\b`, "i").test(title))
    title = `Cycle ${round} · ${title}`;
  const summary = {
    id: entry.id, kind, type: entry.type ?? kind, sequence, updatedSequence,
    generation: entry.generation ?? 0,
    actor: entry.actor ?? entry.role ?? "harness",
    label: clip(title, 200),
    status: entry.error && (!entry.status || entry.status === "complete") ? "failed" : entry.status ?? "complete",
    startedAt: entry.startedAt ?? entry.at ?? entry.timestamp,
    at: entry.at ?? entry.startedAt,
    taskId: taskOf(entry),
    detailAvailable: true,
    view: teachingEvent(entry) ? "teaching" : "protocol",
  };
  if (research) {
    // No claims, rubric, source content, evaluations or copy snapshots belong
    // in the summary. GET record remains the only path to that evidence.
    for (const key of ["runId", "slotId", "round", "maxRounds", "outcome"]) {
      const value = researchField(entry, key);
      if (typeof value === "string") summary[key] = clip(value, 160);
      else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        summary[key] = value;
    }
  }
  for (const key of ["parentId", "jobId", "briefingId", "agentRunId", "requestId",
    "operationId", "toolCallId", "mcpRequestId", "toolName", "tool", "method", "transport", "reportedBy",
    "model", "turn", "agentTurn", "maxTurns", "phase", "action", "durationMs", "issueRevision", "beforeRevision",
    "inputRevision", "requestKind", "dispatched", "simulated", "fixture", "mode", "cached",
    "toolsDisabled", "finalReason", "resolvedModel", "backend", "batchIndex", "batchCount",
    "questionsCount", "requestedBatchCount", "completedBatchCount", "cachedBatchCount",
    "knownCostUsd", "unreportedCostCount", "supersededReason", "reason", "httpStatus",
    "logicalStepId", "recoveryOfOperationId", "recoveryOperationId", "sourceOperationId",
    "additionalRequest", "attempt", "maxAttempts", "outputTokenLimit", "maxTokens",
    "finishReason", "causeRecordId", "stopReason", "outputLimitReached", "maxOutputTokens", "outputTokens",
    "layoutIntentId"]) {
    const value = entry[key];
    if (["string", "number", "boolean"].includes(typeof value))
      summary[key] = typeof value === "string" ? clip(value, 256) : value;
  }
  if (entry.error) summary.error = clip(typeof entry.error === "string" ? entry.error : entry.error.message);
  const errorCode = entry.errorCode ?? entry.code ?? entry.error?.code;
  if (typeof errorCode === "string") summary.errorCode = clip(errorCode, 100);
  if (recoveryEvent(entry)) {
    for (const key of ["kind", "completeCopies", "discardedPartialCopy"]) {
      const value = entry.recovery?.[key];
      if (["string", "number", "boolean"].includes(typeof value))
        summary[`recovery${key[0].toUpperCase()}${key.slice(1)}`] = value;
    }
  }
  if (Array.isArray(entry.losses) && entry.losses.length) summary.warning = `${entry.losses.length} evidence limitation(s)`;
  if (entry.completeForRequestedScope === false) summary.warning ??= "Evidence is incomplete for the requested scope";
  const cost = reportedCost(entry);
  if (cost !== null) summary.costUsd = cost;
  if (object(entry.usage)) summary.usage = Object.fromEntries(
    ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "cost", "cost_usd"]
      .filter((key) => typeof entry.usage[key] === "number")
      .map((key) => [key, entry.usage[key]]),
  );
  if (entry.captureIncomplete) {
    summary.detailAvailable = false;
    summary.warning = entry.captureReason ?? "Some execution details could not be captured";
  }
  return summary;
}

/**
 * directory is private application storage. clear() advances the visible
 * generation; it never removes journal segments, objects or funding evidence.
 * Both views, their counts and recent() use the current generation. get(),
 * describe(), readAll() and list({view:"protocol", scope:"all"}) retain history.
 * Span finishes stay with their origin.
 *
 * Retention requires this directory and scopeId on reopening. Omitting the
 * directory creates a process-owned archive removed at close. Hosted visits
 * currently use separate runtime directories: cross-visit retention needs a
 * visitor-scoped durable archive adapter, not a shared local path. Capture is
 * still sanitized and subject to the reported storage/queue/index bounds.
 * Earlier .cleared-* sibling directories remain separate recovery checkpoints;
 * this format does not merge, overwrite or remove them.
 */
export function createExecutionLog({
  directory, scopeId = randomUUID(), initialEntries = [],
  maximumArchiveBytes = 1024 * 1024 * 1024, maximumPendingBytes = 64 * 1024 * 1024,
  maximumRecords = 250000, segmentBytes = 4 * 1024 * 1024,
} = {}) {
  const ephemeral = !directory;
  let root, enabled = true, closed = false, sequence = 0, segment = 0, offset = 0;
  let generation = 0, clearing = null, storageOwned = false;
  let diskBytes = 0, pendingBytes = 0, logicalBytes = 0, droppedRecords = 0, errors = 0;
  let logicalRows = null;
  let reason, writes = Promise.resolve(), budget;
  const index = new Map(), cache = new Map(), blobs = new Set(), pendingBlobs = new Map();
  const listeners = new Set(), operations = new Map(), taskGenerations = new Map();
  const operationGenerations = new Map(), generations = new Map();
  const cacheLimit = 256;

  function incomplete(message, dropped = false) {
    reason = message;
    if (dropped) droppedRecords++;
    else errors++;
  }
  function remember(id, value) {
    cache.delete(id); cache.set(id, value);
    while (cache.size > cacheLimit) {
      const candidate = cache.keys().next().value;
      if (cache.get(candidate).pending) break;
      cache.delete(candidate);
    }
  }
  function account(value) {
    const entry = value.summary;
    if (entry.operationId && (exchangeKind(entry) || entry.kind === "inference.settlement")) {
      const previous = operations.get(entry.operationId) ?? {};
      operations.set(entry.operationId, {
        ...previous, kind: previous.kind ?? entry.kind,
        costUsd: entry.costUsd ?? previous.costUsd ?? null,
      });
    }
    if (value.budget) budget = value.budget;
  }
  function install(value, pointer) {
    const previous = index.get(value.id);
    logicalBytes += value.recordBytes - (previous?.recordBytes ?? 0);
    const item = {
      ...pointer, id: value.id, firstSequence: value.firstSequence,
      sequence: value.sequence, recordBytes: value.recordBytes,
      startedAt: previous?.startedAt ?? value.summary.startedAt,
      sortTime: previous?.sortTime ?? value.sortTime ?? eventTime(value.summary.startedAt, value.firstSequence),
      summary: value.summary, logical: logicalIdentity(value.summary),
      generation: value.summary.generation ?? 0,
      taskId: value.summary.taskId, searchText: encoded(value.summary).toLowerCase(),
    };
    index.set(value.id, item);
    if (!generations.has(item.generation)) generations.set(item.generation, new Map());
    generations.get(item.generation).set(item.id, item);
    if (previous && previous.generation !== item.generation) generations.get(previous.generation)?.delete(item.id);
    if (value.summary.taskId && !taskGenerations.has(value.summary.taskId))
      taskGenerations.set(value.summary.taskId, value.summary.generation ?? 0);
    if (value.summary.operationId && !operationGenerations.has(value.summary.operationId))
      operationGenerations.set(value.summary.operationId, value.summary.generation ?? 0);
    if (item.generation === generation || previous?.generation === generation) logicalRows = null;
    sequence = Math.max(sequence, value.sequence);
    account(value);
  }
  try {
    root = directory || mkdtempSync(join(tmpdir(), "workshop-execution-"));
    mkdirSync(join(root, "objects"), { recursive: true, mode: 0o700 });
    const manifestPath = join(root, "scope.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.schemaVersion !== FORMAT || manifest.scopeId !== scopeId)
        throw new Error("Execution archive scope does not match this application");
      generation = Number.isSafeInteger(manifest.generation) ? manifest.generation : 0;
      sequence = Number.isSafeInteger(manifest.latestSequence) ? manifest.latestSequence : 0;
      if (object(manifest.budget)) budget = manifest.budget;
      if (manifest.capture?.status === "partial") {
        reason = manifest.capture.reason ?? "An earlier capture was incomplete";
        droppedRecords = manifest.capture.droppedRecords ?? 0;
        errors = manifest.capture.errors ?? 0;
      }
    } else {
      writes = writes.then(() => writeFile(manifestPath,
        encoded({ schemaVersion: FORMAT, scopeId }) + "\n", { mode: 0o600 }));
    }
    storageOwned = true;
    const segments = readdirSync(root).filter((name) => /^events-\d{6}\.ndjson$/.test(name)).sort();
    for (const name of segments) {
      const data = readFileSync(join(root, name));
      diskBytes += data.length;
      let start = 0;
      while (start < data.length) {
        const end = data.indexOf(10, start);
        if (end < 0) { incomplete("An interrupted archive tail is retained; earlier records remain available"); break; }
        try {
          const value = JSON.parse(data.subarray(start, end).toString("utf8"));
          if (!value.id || !Number.isSafeInteger(value.sequence) || !value.summary)
            throw new Error("Invalid archive entry");
          // Rebuild projections with the current grouping rules without changing
          // original records or their payloads on disk.
          value.summary = project({ ...value.summary, ...value.entry, label: value.summary.label },
            value.firstSequence, value.sequence);
          generation = Math.max(generation, value.summary.generation);
          if (index.size < maximumRecords || index.has(value.id)) {
            install(value, { file: name, offset: start, length: end - start });
            remember(value.id, { value });
          } else incomplete("Execution record index limit reached", true);
        } catch { incomplete("An unreadable archive record is retained"); }
        start = end + 1;
      }
    }
    // A new segment preserves an interrupted tail without appending into it.
    segment = segments.length ? Number(segments.at(-1).slice(7, 13)) + 1 : 0;
    for (const name of readdirSync(join(root, "objects"))) {
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        blobs.add(name.slice(0, -5));
        diskBytes += statSync(join(root, "objects", name)).size;
      }
    }
  } catch {
    enabled = false;
    incomplete("Execution storage is unavailable; application work can continue");
  }
  writes = writes.catch(() => {
    enabled = false;
    incomplete("Execution storage initialization failed");
  });

  function packedRecord(id) {
    const cached = cache.get(id);
    if (cached) { remember(id, cached); return cached.value; }
    const position = index.get(id);
    if (!position || !root) return null;
    let fd;
    try {
      fd = openSync(join(root, position.file), "r");
      const buffer = Buffer.alloc(position.length);
      if (readSync(fd, buffer, 0, buffer.length, position.offset) !== buffer.length)
        throw new Error("Incomplete record");
      const value = JSON.parse(buffer.toString("utf8"));
      if (value.id !== id) throw new Error("Record identity mismatch");
      remember(id, { value });
      return value;
    } catch {
      incomplete("An execution record could not be read");
      return null;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function hydrate(value) {
    if (Array.isArray(value)) return value.map(hydrate);
    if (!object(value)) return value;
    if (Object.keys(value).length === 1 && /^[a-f0-9]{64}$/.test(value.$executionObject ?? "")) {
      const hash = value.$executionObject;
      try {
        const text = pendingBlobs.get(hash) ?? readFileSync(join(root, "objects", `${hash}.json`), "utf8");
        if (digest(text) !== hash) throw new Error("Object digest mismatch");
        return hydrate(JSON.parse(text));
      } catch {
        return { captureIncomplete: true, reason: "Captured payload is unavailable", sha256: hash };
      }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item)]));
  }
  function pack(value, additions, top = false) {
    if (Array.isArray(value)) value = value.map((item) => pack(item, additions));
    else if (object(value)) value = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, pack(item, additions)]),
    );
    const text = encoded(value);
    if (top || text === undefined || Buffer.byteLength(text) < 4096) return value;
    const hash = digest(text);
    if (!blobs.has(hash) && !pendingBlobs.has(hash)) additions.set(hash, text);
    return { $executionObject: hash };
  }
  function notify() {
    for (const listener of listeners) {
      try { listener(); } catch { incomplete("An execution observer could not update"); }
    }
  }
  function record(supplied = {}, options = {}) {
    try {
      if (closed) return null;
      const previous = index.get(String(supplied.id));
      const recordGeneration = previous?.generation ?? options.generation ?? supplied.generation ??
        taskGenerations.get(taskOf(supplied)) ?? operationGenerations.get(supplied.operationId) ??
        taskGenerations.get(supplied.ownerId) ?? index.get(supplied.parentId)?.generation ?? generation;
      if (!Number.isSafeInteger(recordGeneration) || recordGeneration < 0 || recordGeneration > generation) return null;
      let entry = sanitizeExecution({
        id: randomUUID(), startedAt: new Date().toISOString(), ...supplied, generation: recordGeneration,
      });
      const id = String(entry.id);
      entry.id = id;
      if (previous?.startedAt !== undefined) entry.startedAt = previous.startedAt;
      if (!previous && index.size >= maximumRecords) {
        incomplete("Execution archive record limit reached; newer diagnostics were not captured", true);
        notify();
        return project({ ...entry, captureIncomplete: true }, ++sequence, sequence);
      }
      const recordBytes = sizeOf(entry);
      let additions = new Map(), packed = pack(entry, additions, true);
      let objectBytes = [...additions.values()].reduce((total, text) => total + Buffer.byteLength(text), 0);
      let projected = project(entry, previous?.firstSequence ?? sequence + 1, sequence + 1);
      const recordBudget = object(entry.budget) ? sanitizeExecution(entry.budget) : undefined;
      if (!enabled || pendingBytes + objectBytes + sizeOf(packed) > maximumPendingBytes ||
        diskBytes + pendingBytes + objectBytes + sizeOf(packed) > maximumArchiveBytes) {
        incomplete(enabled ? "Execution detail capture reached its storage or queue bound"
          : "Execution storage is unavailable", true);
        entry = {
          ...projected, captureIncomplete: true, captureReason: reason,
          originalBytes: recordBytes, originalSha256: digest(encoded(entry)),
        };
        additions = new Map(); objectBytes = 0; packed = entry;
        projected = project(entry, projected.sequence, projected.updatedSequence);
      }
      const nextSequence = ++sequence;
      const value = {
        id, firstSequence: previous?.firstSequence ?? nextSequence,
        sortTime: previous?.sortTime ?? eventTime(entry.startedAt, Date.now()),
        sequence: nextSequence, recordBytes, summary: projected, entry: packed,
        ...(recordBudget ? { budget: recordBudget } : {}),
      };
      const line = encoded(value) + "\n";
      const length = Buffer.byteLength(line);
      if (offset && offset + length > segmentBytes) { segment++; offset = 0; }
      const file = `events-${String(segment).padStart(6, "0")}.ndjson`;
      const position = { file, offset, length: length - 1 };
      offset += length;
      install(value, position);
      remember(id, { value, pending: enabled });
      if (enabled) {
        for (const [hash, text] of additions) pendingBlobs.set(hash, text);
        pendingBytes += length + objectBytes;
        writes = writes.then(async () => {
          try {
            for (const [hash, text] of additions) {
              await writeFile(join(root, "objects", `${hash}.json`), text, { mode: 0o600 });
              blobs.add(hash);
            }
            await appendFile(join(root, file), line, { mode: 0o600 });
            diskBytes += length + objectBytes;
          } catch {
            enabled = false;
            incomplete("Execution write failed; application state and spending authority remain separate");
          } finally {
            pendingBytes -= length + objectBytes;
            for (const hash of additions.keys()) pendingBlobs.delete(hash);
            const current = cache.get(id);
            if (current?.value.sequence === nextSequence) current.pending = false;
          }
        });
      }
      notify();
      return projected;
    } catch {
      incomplete("An execution record could not be captured", true);
      notify();
      return null;
    }
  }
  function update(id, patch = {}, options = {}) {
    const previous = packedRecord(id);
    if (!previous) return record({ id, ...patch, captureIncomplete: true,
      captureReason: "The beginning of this operation was not captured" }, options);
    return record({ ...hydrate(previous.entry), ...patch, id }, options);
  }
  function teachingRows(selectedGeneration = generation) {
    if (selectedGeneration === generation && logicalRows) return logicalRows;
    const items = generations.get(selectedGeneration) ?? new Map();
    const groups = new Map();
    const batches = [];
    for (const item of items.values()) {
      if (item.summary.view !== "teaching") continue;
      if (item.summary.kind === "editorial.batch") { batches.push(item); continue; }
      const key = item.logical?.key ?? `record:${item.id}`;
      const group = groups.get(key);
      if (!group) groups.set(key, { canonical: item, first: item, latest: item, members: [item] });
      else {
        group.members.push(item);
        if (item.firstSequence < group.first.firstSequence) group.first = item;
        if (item.sequence > group.latest.sequence) group.latest = item;
        const priority = item.logical?.priority ?? 0, previous = group.canonical.logical?.priority ?? 0;
        if (priority > previous || (priority === previous && item.sequence > group.canonical.sequence))
          group.canonical = item;
      }
    }
    // A batch is the harness wrapper for a call, not another charged request.
    // During an in-flight call it may not yet have an operationId; accept only
    // an unambiguous parent relationship in that case. Cached results never
    // create or merge into a new exchange using their original operation ID.
    const exchanges = [...groups.values()].filter((group) => group.canonical.logical?.type === "model");
    for (const item of batches) {
      const matches = item.summary.cached ? [] : exchanges.filter((group) =>
        item.summary.operationId
          ? group.canonical.summary.operationId === item.summary.operationId
          : group.members.some((member) => ancestors(member, items).some((parent) => parent.id === item.id)));
      if (matches.length !== 1) {
        groups.set(`record:${item.id}`, { canonical: item, first: item, latest: item, members: [item] });
        continue;
      }
      const group = matches[0];
      group.members.push(item);
      if (item.firstSequence < group.first.firstSequence) group.first = item;
      if (item.sequence > group.latest.sequence) group.latest = item;
    }
    const rows = [...groups.values()].map(({ canonical, first, latest, members }) => {
      const summary = { ...canonical.summary, sequence: first.firstSequence,
        updatedSequence: latest.sequence, rawCount: members.length };
      if (canonical.logical?.type === "task") {
        summary.label = canonical.summary.kind === "briefing" ? "Research briefing"
          : canonical.summary.kind === "story" ? canonical.summary.label === "story" ? "Write story" : canonical.summary.label
            : "Task progress";
        // Sparse text updates often carry a default complete status. Only the
        // canonical task span decides completion; actual progress fields can
        // refine its running phase without creating a new row for each token.
        if (!finished(canonical.summary) || canonical.logical.priority < 3) {
          const progress = [...members].sort((a, b) => a.sequence - b.sequence);
          for (const item of progress) {
            for (const key of ["turn", "maxTurns", "phase"])
              if (item.summary[key] !== undefined) summary[key] = item.summary[key];
            if (item.summary.status !== "complete") summary.status = item.summary.status;
          }
        }
      } else if (canonical.logical?.type === "model") {
        summary.exchangeKind = exchangeKind(canonical.summary);
        summary.label = summary.exchangeKind === "decision" ? "Decision exchange" : "Model exchange";
        const batch = members.find((item) => item.summary.kind === "editorial.batch");
        if (batch) {
          summary.batchRecordId = batch.id;
          for (const key of ["batchIndex", "batchCount", "questionsCount", "backend"])
            if (batch.summary[key] !== undefined) summary[key] = batch.summary[key];
        }
        // Settlement may arrive after the model span. Use the same operation
        // ledger as the all-runs total; missing charges remain unknown.
        const cost = operations.get(summary.operationId)?.costUsd;
        if (cost !== null && cost !== undefined) summary.costUsd = cost;
        // A response's HTTP status is not a lifecycle status.
        if (typeof summary.status === "number") summary.status =
          summary.status >= 400 ? "failed" : "complete";
      } else if (summary.kind === "editorial.batch") {
        summary.label = summary.cached ? "Cached editorial answers" : "Editorial batch";
        summary.costRole = "metadata";
      }
      if (recoveryEvent(summary)) summary.costRole = "metadata";
      // A failure/limitation in a correlated member remains visible even while
      // its parent span has not finished. Original error payloads stay in get().
      const failure = members.find((item) => terminalFailure(item.summary));
      if (failure) {
        summary.error ??= failure.summary.error;
        summary.errorCode ??= failure.summary.errorCode;
        if (!finished(canonical.summary)) summary.status = failure.summary.status;
        else if (!terminalFailure(canonical.summary) && failure.summary.error)
          summary.warning ??= "A related record reports an error";
      }
      summary.warning ??= members.find((item) => item.summary.warning)?.summary.warning;
      return { ...canonical, summary, firstSequence: first.firstSequence, sortTime: first.sortTime, members };
    });
    annotateExchanges(rows, selectedGeneration);
    annotateOutcomes(rows, items);
    annotateRecovery(rows, items);
    if (selectedGeneration === generation) logicalRows = rows;
    return rows;
  }

  function ancestors(item, items) {
    const parents = [], seen = new Set([item.id]);
    let parent = items.get(item.summary.parentId);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      parents.push(parent);
      parent = items.get(parent.summary.parentId);
    }
    return parents;
  }

  function annotateExchanges(rows, selectedGeneration) {
    const items = generations.get(selectedGeneration) ?? new Map();
    const roots = new Map();
    for (const item of items.values()) if (exchangeRoot(item.summary)) {
      roots.set(item.id, item);
      if (item.taskId) roots.set(item.taskId, item);
    }
    const jobs = new Map();
    for (const row of rows.filter((item) => item.summary.exchangeKind)) {
      let owner = ancestors(row, items).find((parent) => exchangeRoot(parent.summary));
      owner ??= roots.get(row.summary.requestId) ?? roots.get(row.taskId);
      const key = owner?.taskId ?? owner?.id ?? row.taskId ?? row.summary.requestId ?? row.summary.operationId;
      if (!jobs.has(key)) jobs.set(key, { owner, rows: [] });
      jobs.get(key).rows.push(row);
    }
    for (const [key, job] of jobs) {
      // Request order survives late HTTP capture, repeated one-turn calls and
      // retries. A configured ten-turn allowance does not establish finality.
      const requestSequence = (row) => row.members.find((item) =>
        ["model.request", "decision.request", "app.request_start"].includes(item.summary.kind))?.firstSequence
        ?? row.firstSequence;
      job.rows.sort((a, b) => requestSequence(a) - requestSequence(b));
      const overview = rows.find((row) => row.id === job.owner?.id);
      if (overview) {
        const costs = job.rows.map((row) => operations.get(row.summary.operationId)?.costUsd ?? null);
        Object.assign(overview.summary, {
          costRole: "aggregate", workflowId: key, workflowRequestCount: job.rows.length,
          workflowKnownCostUsd: costs.some((cost) => cost !== null)
            ? costs.reduce((sum, cost) => sum + (cost ?? 0), 0) : null,
          workflowUnknownCostCount: costs.filter((cost) => cost === null).length,
        });
      }
      job.rows.forEach((row, position) => {
        const standalone = !job.owner && !row.taskId && !row.summary.requestId;
        const final = position === job.rows.length - 1 && (job.owner
          ? finished(job.owner.summary)
          : standalone && finished(row.summary) &&
            (row.summary.maxTurns === 1 || row.summary.exchangeKind === "decision"));
        Object.assign(row.summary, {
          costRole: "request",
          exchangeJobId: key, exchangeIndex: position + 1, exchangeCount: job.rows.length,
          finalExchange: final,
          exchangeJobStatus: job.owner?.summary.status ?? (standalone ? row.summary.status : "unknown"),
        });
        if (final) row.summary.label = row.summary.exchangeKind === "decision"
          ? "Final decision exchange" : "Final model exchange";
      });
    }
    // A review satisfied entirely by cached answers has zero new requests,
    // even if its raw receipt references earlier usage and operation IDs.
    for (const row of rows) if (row.summary.kind === "editorial" && !row.summary.costRole) {
      Object.assign(row.summary, { costRole: "aggregate", workflowId: row.taskId ?? row.id,
        workflowRequestCount: 0, workflowKnownCostUsd: null, workflowUnknownCostCount: 0 });
    }
  }

  function annotateOutcomes(rows, items) {
    for (const row of rows) {
      const related = row.members.map((member) => member.summary);
      const superseded = [row, ...ancestors(row, items)].find((item) =>
        item.summary.status === "superseded" && item.summary.supersededReason);
      const cancellationMessages = new Set(related.filter(cancellationEvidence)
        .map((entry) => entry.error).filter(Boolean));
      if (superseded) cancellationMessages.add(superseded.summary.supersededReason);
      // Cancellation is not evidence that an unrelated provider failure was
      // harmless. Never overwrite an HTTP error or a specific non-abort code.
      if (!related.some(providerFailure) && related.some(cancellationEvidence) &&
          related.every((entry) => !entry.error || cancellationMessages.has(entry.error))) {
        row.summary.displayStatus = superseded ? "superseded" : "cancelled";
        row.summary.statusReason = superseded?.summary.supersededReason ??
          row.summary.reason ?? row.summary.error;
      } else if (row.summary.error && row.summary.status !== "superseded") {
        row.summary.displayStatus = "failed";
      }
    }
    const failures = rows.filter((row) => row.summary.error &&
      !["superseded", "cancelled"].includes(row.summary.displayStatus ?? row.summary.status));
    for (const row of failures) {
      if (row.summary.exchangeKind) continue;
      const cause = failures.filter((candidate) => candidate.summary.exchangeKind &&
        (candidate.summary.error === row.summary.error ||
          (row.summary.errorCode && row.summary.errorCode === candidate.summary.errorCode)) &&
        (ancestors(candidate, items).some((parent) => parent.id === row.id) ||
          (row.summary.operationId && row.summary.operationId === candidate.summary.operationId) ||
          (row.summary.causeRecordId && candidate.members.some((member) => member.id === row.summary.causeRecordId)) ||
          (row.summary.kind === "layout.completion" && row.summary.operationId &&
            ancestors(candidate, items).some((parent) => parent.summary.layoutIntentId === row.summary.operationId))))
        .sort((a, b) => b.firstSequence - a.firstSequence)[0];
      if (!cause) continue;
      row.summary.failureCauseId = cause.id;
      cause.summary.affectedStepCount = (cause.summary.affectedStepCount ?? 0) + 1;
    }
  }

  function annotateRecovery(rows, items) {
    const byOperation = new Map(rows.filter((row) => row.summary.exchangeKind)
      .map((row) => [row.summary.operationId, row]));
    for (const event of rows.filter((row) => recoveryEvent(row.summary))) {
      const recovery = byOperation.get(event.summary.recoveryOperationId);
      const original = byOperation.get(event.summary.recoveryOfOperationId ??
        event.summary.sourceOperationId ?? event.summary.operationId);
      if (original) {
        event.summary.sourceRequestRecordId = original.id;
        if (event.summary.kind === "model.json_recovery" && event.summary.status === "recovered") {
          original.summary.localJsonRecovery = true;
          original.summary.localRecoveryEventId = event.id;
          event.summary.label = "JSON response recovered locally";
        }
        if (event.summary.kind === "model.output_limit") {
          original.summary.outputLimitReached = true;
          original.summary.outputLimitEventId = event.id;
        }
      }
      if (!recovery) continue; // An intent/repair event alone is not another API call.
      Object.assign(recovery.summary, {
        jsonRecovery: true, recoveryEventId: event.id,
        recoveryOfRecordId: original?.id,
        logicalStepId: event.summary.logicalStepId ?? event.summary.parentId,
      });
      event.summary.recoveryRecordId = recovery.id;
    }
    for (const row of byOperation.values()) {
      if (row.summary.recoveryOfOperationId || row.summary.requestKind === "json_recovery") {
        row.summary.jsonRecovery = true;
        row.summary.recoveryOfRecordId ??= byOperation.get(row.summary.recoveryOfOperationId)?.id;
      }
      const parent = ancestors(row, items).find((item) =>
        ["model.json_recovery", "auto_research.repair"].includes(item.summary.kind));
      if (parent) {
        row.summary.jsonRecovery = true;
        row.summary.recoveryEventId = parent.id;
        row.summary.logicalStepId ??= parent.summary.logicalStepId ?? parent.summary.parentId;
        row.summary.recoveryOfRecordId ??= byOperation.get(
          parent.summary.recoveryOfOperationId ?? parent.summary.sourceOperationId)?.id;
      }
    }
  }

  async function getExchange(id) {
    const record = await api.get(id);
    if (!record) return null;
    const item = index.get(String(id));
    const rows = teachingRows(item.generation);
    const row = rows.find((candidate) => candidate.members.some((member) => member.id === record.id));
    if (!row) return record;
    const executionPresentation = {
      ...row.summary,
      affectedSteps: rows.filter((candidate) => candidate.summary.failureCauseId === row.id)
        .map((candidate) => ({ id: candidate.id, label: candidate.summary.label })),
    };
    if (!row.summary.exchangeKind || !record.operationId) return { ...record, executionPresentation };
    // This envelope is a derived inspection view. Every value names its
    // original record and field; get(id), the journal and blobs stay unchanged.
    const members = row.members.sort((a, b) => a.firstSequence - b.firstSequence);
    const originals = members.map((member) => ({
      item: member, record: hydrate(packedRecord(member.id)?.entry),
    })).filter((member) => member.record);
    const fields = (kinds, field) => originals.filter(({ record: entry }) =>
      kinds.includes(entry.kind) && Object.hasOwn(entry, field)).map(({ record: entry }) => ({
      recordId: entry.id, kind: entry.kind, field, value: entry[field],
    }));
    const http = originals.filter(({ record: entry }) => ["model.http", "decision.http"].includes(entry.kind));
    const request = fields(["model.http", "decision.http"], "payload");
    const responses = fields(["model.http", "decision.http"], "result");
    const assistant = fields(["model.response"], "message");
    const toolIds = new Set(assistant.flatMap(({ value }) => Array.isArray(value?.content)
      ? value.content.filter((part) => part.type === "toolCall").map((part) => part.id) : []));
    const relatedTools = [];
    if (toolIds.size) for (const candidate of generations.get(item.generation)?.values() ?? []) {
      if ((row.taskId ? candidate.taskId !== row.taskId : candidate.summary.parentId !== row.summary.parentId) ||
        !["mcp.call", "mcp", "agent.tool_execution_end", "agent.message_end"].includes(candidate.summary.kind)) continue;
      // Tool-call IDs, never equal argument text or the last conversation turn,
      // establish the relationship with the assistant's call.
      if (candidate.summary.toolCallId && !toolIds.has(candidate.summary.toolCallId)) continue;
      const original = hydrate(packedRecord(candidate.id)?.entry);
      if (!original || !toolIds.has(original.toolCallId ?? original.message?.toolCallId)) continue;
      const field = Object.hasOwn(original, "result") ? "result"
        : original.message?.role === "toolResult" ? "message" : null;
      if (field) relatedTools.push({ recordId: original.id, kind: original.kind,
        field, toolCallId: original.toolCallId ?? original.message.toolCallId, value: original[field] });
    }
    const urls = http.map(({ record: entry }) => entry.url).filter((url) => typeof url === "string");
    const simulated = row.summary.simulated === true || row.summary.mode === "fixture";
    const brokered = urls.some((url) => /\/v1\/(?:llm|services)\//.test(url)) ||
      ["development", "hosted", "workshop"].includes(row.summary.mode);
    const directOpenRouter = urls.length > 0 && urls.every((url) => {
      try { return new URL(url).hostname === "openrouter.ai"; } catch { return false; }
    });
    const boundary = simulated ? "Simulated capture"
      : brokered ? "Captured at the app gateway. Workshop broker routing may be added downstream; the upstream provider body is not captured here."
        : directOpenRouter ? "Captured by the app at its HTTP boundary to OpenRouter."
          : "Captured at the app HTTP boundary. Downstream provider transformations are not established by this record.";
    const exchange = {
      schemaVersion: "workshop.execution.exchange.v1", derived: true,
      originalRecordId: record.id, operationId: row.summary.operationId,
      kind: row.summary.exchangeKind, boundary,
      jobId: row.summary.exchangeJobId, jobStatus: row.summary.exchangeJobStatus,
      index: row.summary.exchangeIndex, count: row.summary.exchangeCount,
      final: row.summary.finalExchange,
      jsonRecovery: row.summary.jsonRecovery === true,
      localJsonRecovery: row.summary.localJsonRecovery === true,
      localRecoveryEventId: row.summary.localRecoveryEventId,
      outputLimitEventId: row.summary.outputLimitEventId,
      recoveryOfRecordId: row.summary.recoveryOfRecordId,
      recoveryEventId: row.summary.recoveryEventId,
      logicalStepId: row.summary.logicalStepId,
      originalRecordIds: members.map((member) => member.id),
      request: {
        http: request,
        captured: fields(["model.request", "decision.request", "app.request_start"], "payload"),
        sdk: fields(["model.sdk_payload"], "payload"),
        headers: fields(["model.request", "app.request_start"], "headers"),
      },
      response: {
        http: responses,
        headers: [...fields(["model.http", "decision.http"], "responseHeaders"),
          ...fields(["model.http_response"], "headers")],
        chunks: fields(["model.provider_event"], "event"),
        body: fields(["decision.response"], "body"),
        assistant,
      },
      decision: {
        state: fields(["decision"], "state"),
        questions: fields(["decision"], "questions"),
        answers: fields(["decision"], "answers"),
      },
      transport: http.map(({ record: entry }) => ({ recordId: entry.id, kind: entry.kind,
        value: Object.fromEntries(Object.entries(entry).filter(([key]) => !["payload", "result"].includes(key))) })),
      relatedTools,
      limitations: originals.filter(({ record: entry }) => entry.captureIncomplete || entry.truncated || entry.warning)
        .map(({ record: entry }) => ({ recordId: entry.id, captureIncomplete: entry.captureIncomplete,
          truncated: entry.truncated, warning: entry.warning, reason: entry.captureReason })),
    };
    return { ...record, exchange, executionPresentation };
  }
  function summary() {
    const currentRecords = generations.get(generation)?.size ?? 0;
    return {
      scopeId, generation, clearSupported: true, sortSupported: true, totalRecords: currentRecords,
      teachingRecords: teachingRows().length, archivedRecords: index.size - currentRecords,
      retention: { clear: "new-visible-generation", protocol: "current-generation",
        storage: ephemeral ? "process" : "directory", crossVisit: false },
      latestSequence: sequence, logicalBytes, storedBytes: diskBytes,
      requestCount: operations.size,
      reportedCostUsd: [...operations.values()].some((entry) => entry.costUsd !== null)
        ? [...operations.values()].reduce((total, entry) => total + (entry.costUsd ?? 0), 0) : null,
      ...(budget ? { budget } : {}),
      capture: { status: reason ? "partial" : "complete", droppedRecords, errors, ...(reason ? { reason } : {}) },
    };
  }
  function clear() {
    if (clearing) return clearing;
    if (closed || !root || !storageOwned)
      return Promise.reject(new Error("Execution storage cannot be cleared in this application scope."));
    const nextGeneration = ++generation, clearSequence = ++sequence;
    logicalRows = null;
    // Commit only the view marker. Existing writes complete first; later
    // records queue after it. No archive path, object or index entry is removed.
    const barrier = writes.then(async () => {
      await writeFile(join(root, "scope.json.next"), encoded({
        schemaVersion: FORMAT, scopeId, generation: nextGeneration,
        latestSequence: clearSequence, ...(budget ? { budget } : {}),
        capture: summary().capture,
      }) + "\n", { mode: 0o600 });
      await rename(join(root, "scope.json.next"), join(root, "scope.json"));
    });
    writes = barrier.catch(() => {
      enabled = false;
      incomplete("The visible generation could not be saved; retained records and spending evidence were not removed.");
    });
    clearing = barrier.then(() => summary()).finally(() => {
      clearing = null;
      notify();
    });
    notify();
    return clearing;
  }
  function list({ view = "teaching", cursor, limit = 50, query = "", taskId, order = "desc", scope: archiveScope = "current" } = {}) {
    if (!["asc", "desc"].includes(order)) throw new Error("Choose ascending or descending execution order.");
    if (!["teaching", "protocol"].includes(view)) throw new Error("Choose teaching or protocol records.");
    if (!["current", "all"].includes(archiveScope) || (archiveScope === "all" && view !== "protocol"))
      throw new Error("Retained history is available through the all-records Protocol scope.");
    const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const needle = String(query).slice(0, 256).toLowerCase();
    const scope = digest(encoded({ scopeId, generation, archiveScope, order, view, query: needle, taskId: taskId ?? null }));
    let boundary;
    if (cursor != null && cursor !== "") {
      try {
        if (typeof cursor !== "string" || cursor.length > 1024) throw new Error();
        boundary = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (boundary.scope !== scope || !Number.isFinite(boundary.time) ||
          !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 1) throw new Error();
      } catch { throw new Error("This execution cursor does not match the current generation, order or search. Start from the first page."); }
    }
    const direction = order === "asc" ? 1 : -1;
    const candidates = (view === "teaching" ? teachingRows()
      : [...(archiveScope === "all" ? index.values() : generations.get(generation)?.values() ?? [])]).filter((entry) =>
      (!taskId || entry.taskId === taskId) &&
      (!needle || entry.searchText.includes(needle) || encoded(entry.summary).toLowerCase().includes(needle) ||
        entry.members?.some((member) => member.searchText.includes(needle))),
    ).sort((a, b) => direction * (a.sortTime - b.sortTime || a.firstSequence - b.firstSequence));
    const records = [];
    let nextCursor = null, more = false;
    for (const candidate of candidates) {
      if (boundary && direction * (candidate.sortTime - boundary.time ||
        candidate.firstSequence - boundary.sequence) <= 0) continue;
      if (records.length === count) { more = true; break; }
      records.push({ ...candidate.summary });
      nextCursor = Buffer.from(encoded({
        scope, time: candidate.sortTime, sequence: candidate.firstSequence,
      })).toString("base64url");
    }
    return { records, nextCursor: more ? nextCursor : null, total: candidates.length, summary: summary() };
  }
  const api = {
    record, update, list, summary, clear, getExchange,
    get generation() { return generation; },
    recent({ limit = 50, view = "teaching" } = {}) {
      const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      return list({ limit: count, view, order: "desc" }).records.reverse();
    },
    async get(id) {
      const value = packedRecord(String(id));
      return value ? hydrate(value.entry) : null;
    },
    describe(id) {
      const value = packedRecord(String(id));
      return value ? structuredClone(value.summary) : null;
    },
    // Explicit legacy/testing access. Normal state delivery uses recent().
    readAll() {
      return [...index.values()].sort((a, b) => a.firstSequence - b.firstSequence)
        .map((item) => packedRecord(item.id)).filter(Boolean).map((item) => hydrate(item.entry));
    },
    has(id) { return index.has(id); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async flush() {
      await writes;
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      return summary();
    },
    async restore(entries) {
      const restoreGeneration = generation;
      // Cleared archives must not re-import a retained legacy history at restart.
      if (restoreGeneration > 0) return summary();
      for (let offset = 0; offset < entries.length; offset += 50) {
        if (generation !== restoreGeneration) break;
        for (const entry of entries.slice(offset, offset + 50))
          if (entry?.id && !index.has(entry.id)) record(entry);
        await api.flush();
      }
      return summary();
    },
    async close() {
      closed = true;
      await writes;
      listeners.clear();
      if (ephemeral && root)
        await rm(root, { recursive: true, force: true });
    },
  };
  for (const previous of generation === 0 ? initialEntries : []) {
    if (!previous?.id || index.has(previous.id)) continue;
    record(previous);
  }
  return api;
}
