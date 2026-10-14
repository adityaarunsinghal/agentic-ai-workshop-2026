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
import { appendFile, mkdir, writeFile, rm } from "node:fs/promises";
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
const terminalFailure = (entry) => Boolean(entry.error) ||
  ["failed", "error", "cancelled", "canceled", "interrupted", "blocked", "charge-unavailable"].includes(entry.status);

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
  const tool = entry.toolName ?? entry.tool ?? entry.params?.name ?? entry.payload?.name;
  const title = entry.label ?? labels[kind] ?? entry.purpose ?? entry.action ??
    (kind === "mcp" ? `${entry.method ?? "MCP"}${tool ? ` · ${tool}` : ""}` : tool) ??
    kind.replaceAll("_", " ");
  const summary = {
    id: entry.id, kind, type: entry.type ?? kind, sequence, updatedSequence,
    actor: entry.actor ?? entry.role ?? "harness",
    label: clip(title, 200),
    status: entry.status ?? (entry.error ? "failed" : "complete"),
    startedAt: entry.startedAt ?? entry.at ?? entry.timestamp,
    at: entry.at ?? entry.startedAt,
    taskId: entry.taskId ?? entry.jobId ?? entry.briefingId ?? null,
    detailAvailable: true,
    view: teachingEvent(entry) ? "teaching" : "protocol",
  };
  for (const key of ["parentId", "jobId", "briefingId", "agentRunId", "requestId",
    "operationId", "toolCallId", "mcpRequestId", "toolName", "tool", "method", "transport",
    "model", "turn", "agentTurn", "durationMs", "issueRevision", "beforeRevision",
    "inputRevision", "requestKind", "dispatched", "simulated", "fixture", "mode", "cached"]) {
    const value = entry[key];
    if (["string", "number", "boolean"].includes(typeof value))
      summary[key] = typeof value === "string" ? clip(value, 256) : value;
  }
  if (entry.error) summary.error = clip(typeof entry.error === "string" ? entry.error : entry.error.message);
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
 * directory is private application storage. Omitting it creates an ephemeral
 * archive, suitable for fixtures and a process-owned hosted visit.
 */
export function createExecutionLog({
  directory, scopeId = randomUUID(), initialEntries = [],
  maximumArchiveBytes = 256 * 1024 * 1024, maximumPendingBytes = 8 * 1024 * 1024,
  maximumRecords = 100000, segmentBytes = 4 * 1024 * 1024,
} = {}) {
  const ephemeral = !directory;
  let root, enabled = true, closed = false, sequence = 0, segment = 0, offset = 0;
  let diskBytes = 0, pendingBytes = 0, logicalBytes = 0, droppedRecords = 0, errors = 0;
  let teachingRecords = 0;
  let reason, writes = Promise.resolve(), budget;
  const index = new Map(), cache = new Map(), blobs = new Set(), pendingBlobs = new Map();
  const listeners = new Set(), operations = new Map();
  const recentTeaching = new Map(), recentProtocol = new Map();
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
    if (entry.operationId && ["model", "model.request", "decision", "decision.request",
      "app.request_start", "app.request_end", "inference.settlement"].includes(entry.kind)) {
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
    const teaching = value.summary.view === "teaching";
    teachingRecords += Number(teaching) - Number(previous?.teaching ?? false);
    index.set(value.id, {
      ...pointer, id: value.id, firstSequence: value.firstSequence,
      sequence: value.sequence, recordBytes: value.recordBytes,
      teaching, taskId: value.summary.taskId,
    });
    recentProtocol.delete(value.id); recentProtocol.set(value.id, value.summary);
    recentTeaching.delete(value.id);
    if (teaching) recentTeaching.set(value.id, value.summary);
    for (const recent of [recentTeaching, recentProtocol])
      while (recent.size > 256) recent.delete(recent.keys().next().value);
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
    } else {
      writes = writes.then(() => writeFile(manifestPath,
        encoded({ schemaVersion: FORMAT, scopeId }) + "\n", { mode: 0o600 }));
    }
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
  function record(supplied = {}) {
    try {
      if (closed) return null;
      let entry = sanitizeExecution({ id: randomUUID(), startedAt: new Date().toISOString(), ...supplied });
      const id = String(entry.id);
      entry.id = id;
      const previous = index.get(id);
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
  function update(id, patch = {}) {
    const previous = packedRecord(id);
    if (!previous) return record({ id, ...patch, captureIncomplete: true,
      captureReason: "The beginning of this operation was not captured" });
    return record({ ...hydrate(previous.entry), ...patch, id });
  }
  function summary() {
    return {
      scopeId, totalRecords: index.size,
      teachingRecords,
      latestSequence: sequence, logicalBytes, storedBytes: diskBytes,
      requestCount: operations.size,
      reportedCostUsd: [...operations.values()].some((entry) => entry.costUsd !== null)
        ? [...operations.values()].reduce((total, entry) => total + (entry.costUsd ?? 0), 0) : null,
      ...(budget ? { budget } : {}),
      capture: { status: reason ? "partial" : "complete", droppedRecords, errors, ...(reason ? { reason } : {}) },
    };
  }
  function list({ view = "teaching", cursor, limit = 50, query = "", taskId } = {}) {
    const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const boundary = cursor == null || cursor === "" ? Infinity : Number(cursor);
    const needle = String(query).slice(0, 256).toLowerCase();
    const candidates = [...index.values()].filter((entry) =>
      (view === "protocol" || entry.teaching) && (!taskId || entry.taskId === taskId),
    ).sort((a, b) => b.firstSequence - a.firstSequence);
    const records = [];
    let nextCursor = null, more = false;
    for (const candidate of candidates) {
      if (!(candidate.firstSequence < boundary)) continue;
      const value = packedRecord(candidate.id);
      if (!value) continue;
      if (needle && !encoded(value.summary).toLowerCase().includes(needle)) continue;
      if (records.length === count) { more = true; break; }
      records.push(value.summary);
      nextCursor = candidate.firstSequence;
    }
    return { records, nextCursor: more ? String(nextCursor) : null, total: candidates.length, summary: summary() };
  }
  const api = {
    record, update, list, summary,
    recent({ limit = 50, view = "teaching" } = {}) {
      const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      return [...(view === "protocol" ? recentProtocol : recentTeaching).values()].slice(-count);
    },
    async get(id) {
      const value = packedRecord(String(id));
      return value ? hydrate(value.entry) : null;
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
      for (let offset = 0; offset < entries.length; offset += 50) {
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
      if (ephemeral && root) await rm(root, { recursive: true, force: true });
    },
  };
  for (const previous of initialEntries) {
    if (!previous?.id || index.has(previous.id)) continue;
    record(previous);
  }
  return api;
}
