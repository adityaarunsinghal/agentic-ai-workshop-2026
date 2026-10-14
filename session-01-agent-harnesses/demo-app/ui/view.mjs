/**
 * Turn application events into a recoverable browser view.
 * Browser reconnection reads state; it never repeats a model request.
 */
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { RESOURCE_LIMITS_FOR_HARNESS_TESTING } from "../support/limits.mjs";
import { publicActionField } from "../support/action-fields.mjs";
import { safeErrorMetadata } from "../support/recovery.mjs";
import { createExecutionLog } from "../support/execution-log.mjs";
import { createUiReload } from "../support/ui-reload.mjs";

const recentExecutionLimit = 50;

/** Labels describe observed work. The original event type stays in each record. */
function describeExecution(entry) {
  const type = entry.type ?? entry.kind;
  const role = entry.role ?? entry.agentRole;
  const messageRole = entry.message?.role;
  const actor =
    entry.actor ??
    (messageRole === "user"
      ? "user"
      : messageRole === "assistant" || type?.startsWith("app.request_")
        ? "model"
        : messageRole === "toolResult" || type?.startsWith("tool_execution_")
          ? "tool"
          : "harness");
  const labels = {
    "app.briefing_start": "Briefing started",
    "app.briefing_end": "Briefing ended",
    "app.briefing_resume": "Briefing resumed",
    "app.request_start": `Model request${role ? ` · ${role}` : ""}`,
    "app.request_end": "Model request ended",
    agent_start: `Run started${role ? ` · ${role}` : ""}`,
    agent_end: `Run ended${role ? ` · ${role}` : ""}`,
    turn_start: `Turn ${entry.turn ?? ""} started`,
    turn_end: `Turn ${entry.turn ?? ""} ended`,
    message_end:
      messageRole === "assistant"
        ? "Model response"
        : messageRole === "toolResult"
          ? `${entry.message.toolName} observation`
          : "Input delivered",
    tool_execution_start: `Tool · ${entry.toolName}`,
    tool_execution_end: `Tool ended · ${entry.toolName}`,
    tool_execution_update: `Tool progress · ${entry.toolName}`,
    "app.hn_observation": `HN observation · ${entry.returned} records`,
    "app.skill_loaded": "Skill loaded · hn-briefing",
    "app.fixed_source_call": "Harness selected HN lookup",
    "app.approval_requested": "Approval requested",
    "app.approval_decision": `Approval ${entry.decision}`,
    "app.approval_ended": "Approval ended",
    "app.permission": "Permission checked",
    "app.user_preferences_start": "Preferences change started",
    "app.user_preferences_end": "Preferences change ended",
    "app.user_preferences_saved": "Preferences saved",
    "app.user_preferences_recovered": "Preferences save confirmed",
    "app.input_queued": "Input queued",
    "app.input_archived": "Input not executed",
    "app.input_rejected": "Input rejected",
    "app.recovery": "Request status",
    "app.recovery_status_unavailable": "Request status unavailable",
    "app.context_rejected": "Request context rejected",
    "app.cancel_requested": "Cancellation requested",
    "app.action_rejected": "Action rejected",
    "app.scheduled": "Briefing scheduled",
    "app.schedule_failed": "Scheduled briefing could not start",
    "app.schedule_cancelled": "Scheduled briefing cancelled",
    "app.setup_failed": "Visit setup failed",
    "app.user_preferences_error": "Preferences operation failed",
  };
  return {
    actor,
    taskId: entry.taskId ?? entry.briefingId,
    toolCallId: entry.toolCallId ?? entry.message?.toolCallId,
    status:
      entry.status ??
      entry.outcome?.status ??
      (entry.isError ||
      entry.message?.isError ||
      /_(?:rejected|failed)$/.test(type ?? "") ||
      type === "app.recovery_status_unavailable"
        ? "failed"
        : type === "app.approval_requested"
          ? "waiting"
          : type === "app.approval_decision"
            ? entry.decision
            : type === "app.hn_observation" && !entry.complete
              ? "partial"
              : type?.endsWith("_start")
                ? "running"
                : "completed"),
    label: entry.label ?? labels[type] ?? type,
  };
}

/** Apply the environment's secret redaction only to the diagnostic copy. */
function cleanDiagnostic(value, clean, seen = new WeakSet()) {
  if (typeof value === "string") return clean(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => cleanDiagnostic(item, clean, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          cleanDiagnostic(item, clean, seen),
        ]),
      );
  seen.delete(value);
  return result;
}

/** Only public fields enter this view; provider replay stays in Agent state. */
function publicMessage(message) {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolName
      ? { toolName: message.toolName, toolCallId: message.toolCallId }
      : {}),
    ...(message.isError ? { isError: true } : {}),
    ...(message.stopReason ? { stopReason: message.stopReason } : {}),
  };
}

export function createView(
  initial = {},
  { directory, clean = (value) => value } = {},
) {
  const execution = createExecutionLog({
    directory,
    scopeId: initial.visitId ?? initial.sessionId ?? randomUUID(),
    initialEntries: (initial.trace ?? []).map((entry) =>
      cleanDiagnostic(entry, clean),
    ),
  });
  const state = {
    revision: 0,
    phase: "initializing",
    chat: [],
    trace: [],
    sources: [],
    cards: [],
    queued: [],
    approval: null,
    scheduled: null,
    requestsUsed: 0,
    recovery: null,
    recoverySupported: false,
    recoveryOperationId: null,
    resume: null,
    briefings: [],
    limits: RESOURCE_LIMITS_FOR_HARNESS_TESTING,
    ...initial,
    trace: execution.recent({ limit: recentExecutionLimit }),
    execution: execution.summary(),
  };
  const readers = new Set();
  const assistants = new Map();
  const requestRecords = new Map();
  const requestSummaries = new Map();
  const toolRecords = new Map();
  const pendingSpans = new Map();
  let capturing = false,
    executionSignature = "",
    closing,
    clearingExecution;
  let pendingText = null,
    timer = null;

  function write(response, frame) {
    if (
      response.destroyed ||
      response.writableLength + Buffer.byteLength(frame) > 256 * 1024
    ) {
      readers.delete(response);
      response.destroy();
    } else {
      try {
        response.write(frame);
      } catch {
        readers.delete(response);
        response.destroy();
      }
    }
  }

  function send(kind, data) {
    state.revision++;
    const body = { revision: state.revision, ...data };
    const frame = `id: ${state.revision}\nevent: ${kind}\ndata: ${JSON.stringify(body)}\n\n`;
    for (const reader of readers) write(reader, frame);
  }

  function syncExecution() {
    if (clearingExecution) return;
    state.trace = execution.recent({ limit: recentExecutionLimit });
    state.execution = {
      ...execution.summary(),
      requests: [...requestSummaries.values()],
    };
    const data = { trace: state.trace, execution: state.execution };
    const signature = JSON.stringify(data);
    if (signature !== executionSignature) {
      executionSignature = signature;
      send("execution", data);
    }
  }
  const stopObservingExecution = execution.subscribe(() => {
    if (!capturing) syncExecution();
  });

  function clearExecution() {
    if (clearingExecution) return clearingExecution;
    // Task events can continue, but the reset owns diagnostics until it finishes.
    clearingExecution = Promise.resolve().then(async () => {
      try {
        await execution.clear();
        requestRecords.clear();
        requestSummaries.clear();
        toolRecords.clear();
        pendingSpans.clear();
      } catch (error) {
        clearingExecution = null;
        syncExecution();
        throw error;
      }
      clearingExecution = null;
      syncExecution();
      return { ...state.execution, revision: state.revision };
    });
    return clearingExecution;
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    syncExecution();
    if (!pendingText) return;
    const { index, text } = pendingText;
    const offset = state.chat[index].text.length;
    state.chat[index].text += text;
    pendingText = null;
    send("text", { index, offset, text });
  }

  function update(patch) {
    flush();
    Object.assign(state, patch);
    if (
      state.briefing &&
      ["briefing", "cards", "sources", "queued"].some((key) =>
        Object.hasOwn(patch, key),
      )
    ) {
      const { id } = state.briefing;
      const previous = state.briefings.find((item) => item.id === id);
      const briefing = {
        ...previous,
        ...state.briefing,
        question: state.briefing.question ?? previous?.question ?? "",
        options: state.briefing.options,
        effectiveSettings: {
          ...state.briefing.options,
          permission:
            state.briefing.effectivePermission ??
            state.briefing.options?.permission,
        },
        cards: structuredClone(state.cards),
        sources: structuredClone(state.sources),
        queued: structuredClone(
          state.queued.filter((item) => item.briefingId === id),
        ),
        outcome: state.briefing.status === "running" ? null : state.lastOutcome,
      };
      state.briefings = previous
        ? state.briefings.map((item) => (item.id === id ? briefing : item))
        : [...state.briefings, briefing];
      patch = { ...patch, briefings: state.briefings };
    }
    send("patch", { patch });
  }

  function message(role, text, extra = {}) {
    flush();
    const value = { id: randomUUID(), role, text, ...extra };
    const index = state.chat.push(value) - 1;
    send("message", { index, message: value });
    return index;
  }

  function text(index, delta) {
    if (pendingText?.index !== index) flush();
    pendingText ??= { index, text: "" };
    pendingText.text += delta;
    timer ??= setTimeout(flush, 80);
  }

  function trace(entry) {
    if (clearingExecution) return null;
    flush();
    capturing = true;
    try {
      return recordTrace(entry);
    } catch {
      return execution.record({
        type: "execution.capture_error",
        actor: "harness",
        status: "failed",
        label: "A diagnostic entry could not be captured",
      });
    } finally {
      capturing = false;
      syncExecution();
    }
  }

  function recordTrace(entry) {
    const record = cleanDiagnostic(
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        ...entry,
        ...describeExecution(entry),
      },
      clean,
    );
    const toolKey = `${record.taskId}:${record.toolCallId}`;
    if (record.type === "app.request_start")
      record.label =
        requestSummaries.get(record.operationId)?.label ??
        `Request ${requestSummaries.size + 1}${record.role ? ` · ${record.role}` : ""}`;
    record.parentId ??=
      toolRecords.get(toolKey) ??
      requestRecords.get(record.operationId) ??
      record.agentRunId ??
      record.taskId;
    if (record.parentId === record.id)
      record.parentId =
        record.taskId !== record.id ? record.taskId : undefined;
    const summary = execution.record(record);
    if (record.type === "app.request_start") {
      requestRecords.set(record.operationId, record.id);
      requestSummaries.set(record.operationId, summary);
    }
    if (record.type === "tool_execution_start")
      toolRecords.set(toolKey, record.id);

    // Only identifiers and timestamps are retained here. Results live on disk.
    const spanKey =
      record.type?.startsWith("app.request_")
        ? `request:${record.operationId}`
        : record.type?.startsWith("tool_execution_")
          ? `tool:${toolKey}`
          : record.type?.startsWith("mcp.request_")
            ? `mcp:${record.mcpRequestId}`
            : record.type?.startsWith("app.approval_")
              ? `approval:${record.approvalId}`
              : null;
    if (
      spanKey &&
      (record.type.endsWith("_start") || record.type === "app.approval_requested")
    )
      pendingSpans.set(spanKey, {
        id: record.id,
        at: record.at,
        type: record.type,
        taskId: record.taskId,
      });
    if (
      spanKey &&
      (record.type.endsWith("_end") ||
        ["app.approval_decision", "app.approval_ended"].includes(record.type))
    ) {
      const start = pendingSpans.get(spanKey);
      if (start) {
        const updated = execution.update(start.id, {
          status: record.status,
          endedAt: record.at,
          durationMs: Math.max(0, Date.parse(record.at) - Date.parse(start.at)),
          endRecordId: record.id,
        });
        if (record.type === "app.request_end")
          requestSummaries.set(record.operationId, updated);
      }
      pendingSpans.delete(spanKey);
    }
    if (record.type === "agent_end")
      for (const [key, start] of pendingSpans)
        if (start.taskId === record.taskId && start.type === "tool_execution_start") {
          execution.update(start.id, {
            status: "unconfirmed",
            endRecordId: record.id,
            message: "The run ended without a completed tool observation.",
          });
          pendingSpans.delete(key);
        }
    return summary;
  }

  /** Application output consumes the same lifecycle shown in the source. */
  function acceptAgentEvent(event, role, briefingId) {
    const key = `${role}:${event.agentRunId}`;
    const common = { agentRole: role, briefingId, agentRunId: event.agentRunId };
    if (event.type === "message_start" && event.message.role === "assistant") {
      assistants.set(
        key,
        message(role, "", { ...common, actor: role, complete: false }),
      );
      return;
    }
    if (event.type === "message_update") {
      const index = assistants.get(key);
      if (index !== undefined) text(index, event.assistantMessageEvent.delta);
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      flush();
      const index = assistants.get(key);
      const complete = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (index !== undefined) {
        state.chat[index] = {
          ...state.chat[index],
          text: complete,
          complete: true,
        };
        send("message_update", { index, message: state.chat[index] });
      }
    }
    if (event.type === "message_end") {
      if (event.message.inputId)
        update({
          queued: state.queued.map((item) =>
            item.id === event.message.inputId
              ? { ...item, status: "delivered" }
              : item,
          ),
        });
      trace({
        ...common,
        ...event,
        type: event.type,
        message: publicMessage(event.message),
      });
      return;
    }
    if (event.type === "message_start") return;
    const { messages, message: sourceMessage, ...safe } = event;
    trace({
      ...common,
      ...safe,
      ...(sourceMessage ? { message: publicMessage(sourceMessage) } : {}),
      ...(messages ? { messages: messages.map(publicMessage) } : {}),
    });
  }

  function connect(response) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    flush();
    readers.add(response);
    response.on("close", () => readers.delete(response));
    response.on("error", () => readers.delete(response));
    const snapshot = `event: snapshot\ndata: ${JSON.stringify(state)}\n\n`;
    // Large snapshots use the free GET rather than overflowing this stream.
    write(
      response,
      Buffer.byteLength(snapshot) <= 256 * 1024
        ? snapshot
        : `event: resync\ndata: {"revision":${state.revision}}\n\n`,
    );
  }

  const heartbeat = setInterval(() => {
    for (const reader of readers) write(reader, ": keepalive\n\n");
  }, 15000);
  heartbeat.unref();

  function close() {
    closing ??= (async () => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      stopObservingExecution();
      for (const reader of readers) reader.end();
      readers.clear();
      await execution.close();
    })();
    return closing;
  }

  return {
    state,
    update,
    message,
    text,
    trace,
    execution,
    clearExecution,
    acceptAgentEvent,
    flush,
    connect,
    close,
  };
}

/**
 * Explicit routes make the paid-action boundary easy to find.
 * The hosting platform authenticates the visit; this server accepts no key
 * or identity supplied by the browser.
 */
export async function serveApp(
  application,
  { port = 8080, host = "0.0.0.0", hotReload = false } = {},
) {
  const rootUrl = new URL("../", import.meta.url);
  const root = fileURLToPath(rootUrl);
  const uiReload = hotReload ? createUiReload({
    root, script: "scripts/build-browser.mjs", ignore: ["browser.mjs", "browser.mjs.next"],
  }) : null;
  const assets = new Map([
    ["/", ["ui/index.html", "text/html; charset=utf-8"]],
    ["/favicon.svg", ["ui/favicon.svg", "image/svg+xml"]],
    ["/browser.mjs", ["ui/browser.mjs", "text/javascript; charset=utf-8"]],
    [
      "/action-fields.mjs",
      ["support/action-fields.mjs", "text/javascript; charset=utf-8"],
    ],
    [
      "/support/action-fields.mjs",
      ["support/action-fields.mjs", "text/javascript; charset=utf-8"],
    ],
    [
      "/support/limits.mjs",
      ["support/limits.mjs", "text/javascript; charset=utf-8"],
    ],
    ["/limits.mjs", ["support/limits.mjs", "text/javascript; charset=utf-8"]],
    ["/style.css", ["ui/style.css", "text/css; charset=utf-8"]],
    ["/montserrat.woff2", ["ui/fonts/montserrat.woff2", "font/woff2"]],
  ]);
  const markdown = await readFile(
    createRequire(import.meta.url).resolve("markdown-it/browser"),
  );
  const sourceMap = JSON.parse(
    await readFile(new URL("source-map.json", rootUrl), "utf8"),
  );
  const allowedSources = new Set(sourceMap.files);

  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    // frame-ancestors belongs to the hosting ingress, which knows the portal.
    response.setHeader(
      "content-security-policy",
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'self'",
      ].join("; "),
    );
    const reply = (status, type, body) =>
      response.writeHead(status, { "content-type": type }).end(body);
    const json = (status, value) =>
      reply(status, "application/json", JSON.stringify(value));
    try {
      const url = new URL(request.url, "http://application.local");
      const reloadResponse = request.method === "GET" && uiReload?.response(url.pathname);
      if (reloadResponse) return reply(200, reloadResponse.type, reloadResponse.body);
      if (request.method === "GET" && url.pathname === "/healthz")
        return reply(200, "text/plain", "ok");
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        const body = await readFile(new URL(name, rootUrl));
        return reply(200, type, url.pathname === "/" && uiReload ? uiReload.inject(body) : body);
      }
      if (request.method === "GET" && url.pathname === "/markdown-it.js")
        return reply(200, "text/javascript; charset=utf-8", markdown);
      if (request.method === "GET" && url.pathname === "/api/state") {
        await application.initialize();
        application.view.flush();
        return json(200, application.view.state);
      }
      if (request.method === "GET" && url.pathname === "/api/events")
        return application.view.connect(response);
      // Observer reads never initialize work, poll a provider or record a trace.
      if (request.method === "GET" && url.pathname === "/api/execution")
        return json(
          200,
          application.view.execution.list({
            view: url.searchParams.get("view") === "protocol" ? "protocol" : "teaching",
            order: url.searchParams.get("order") || undefined,
            cursor: url.searchParams.get("cursor") || undefined,
            limit: Math.max(
              1,
              Math.min(100, Number(url.searchParams.get("limit")) || 50),
            ),
            query: url.searchParams.get("query") || undefined,
            taskId: url.searchParams.get("taskId") || undefined,
          }),
        );
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/execution/")
      ) {
        const record = await application.view.execution.get(
          decodeURIComponent(url.pathname.slice("/api/execution/".length)),
        );
        return json(record ? 200 : 404, { record });
      }
      if (request.method === "GET" && url.pathname === "/api/action")
        return json(200, application.actionStatus(url.searchParams.get("id")));
      if (request.method === "GET" && url.pathname === "/api/sources")
        return json(200, sourceMap);
      if (request.method === "GET" && url.pathname === "/api/source") {
        const name = url.searchParams.get("path");
        if (!allowedSources.has(name))
          return json(404, { error: "Unknown source file." });
        const resolved = await realpath(new URL(name, rootUrl));
        if (!resolved.startsWith(root))
          return json(404, { error: "Unknown source file." });
        return reply(
          200,
          "text/plain; charset=utf-8",
          await readFile(resolved),
        );
      }
      const clearingLogs = url.pathname === "/api/execution/clear";
      if (request.method !== "POST" || (!clearingLogs && url.pathname !== "/api/actions"))
        return json(404, { error: "Unknown route." });
      if (clearingLogs) {
        const site = request.headers["sec-fetch-site"];
        const origin = request.headers.origin;
        let sameOrigin = !site || site === "same-origin" || site === "none";
        if (origin) {
          try {
            const scheme = request.socket.encrypted ? "https" :
              (request.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
            sameOrigin &&= ["http", "https"].includes(scheme) &&
              new URL(origin).origin === new URL(`${scheme}://${request.headers.host}`).origin;
          } catch { sameOrigin = false; }
        }
        if (!sameOrigin) return json(403, { error: "Clear logs from this application's own page." });
      }
      if (
        request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
        "application/json"
      )
        return json(415, { error: "Send a JSON action." });
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (
          Buffer.byteLength(body) >
          RESOURCE_LIMITS_FOR_HARNESS_TESTING.bodyBytes
        )
          return json(413, { error: "The complete action is too large." });
      }
      let action;
      try {
        action = JSON.parse(body);
      } catch {
        return json(400, { error: "The action is not valid JSON." });
      }
      if (clearingLogs) {
        if (!action || Array.isArray(action) || typeof action !== "object" || Object.keys(action).length)
          return json(400, { error: "Send an empty JSON object to clear execution logs." });
        return json(200, await application.view.clearExecution());
      }
      const result = await application.action(action);
      return json(200, result);
    } catch (error) {
      return json(error.status ?? 400, {
        error: application.cleanError(error),
        code: error.code ?? "INVALID_ACTION",
        ...publicActionField(error),
        ...safeErrorMetadata(error, application.cleanError),
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    port: server.address().port,
    async close() {
      uiReload?.close();
      await application.close();
      await application.view.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
