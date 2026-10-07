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

export function createView(initial) {
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
    resume: null,
    briefings: [],
    limits: RESOURCE_LIMITS_FOR_HARNESS_TESTING,
    ...initial,
  };
  const readers = new Set();
  const assistants = new Map();
  let traceBytes = 0;
  let pendingText = null,
    timer = null;

  function write(response, frame) {
    if (
      response.destroyed ||
      response.writableLength + Buffer.byteLength(frame) > 256 * 1024
    ) {
      readers.delete(response);
      response.destroy();
    } else response.write(frame);
  }

  function send(kind, data) {
    state.revision++;
    const body = { revision: state.revision, ...data };
    const frame = `id: ${state.revision}\nevent: ${kind}\ndata: ${JSON.stringify(body)}\n\n`;
    for (const reader of readers) write(reader, frame);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
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
    flush();
    const record = { id: randomUUID(), at: new Date().toISOString(), ...entry };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (traceBytes + bytes > RESOURCE_LIMITS_FOR_HARNESS_TESTING.traceBytes)
      throw new Error(
        "The complete trace reached its limit. Start a new workshop visit.",
      );
    traceBytes += bytes;
    state.trace.push(record);
    send("trace", { entry: record });
  }

  /** Application output consumes the same lifecycle shown in the source. */
  function acceptAgentEvent(event, actor, briefingId) {
    const key = `${actor}:${event.agentRunId}`;
    const common = { actor, briefingId, agentRunId: event.agentRunId };
    if (event.type === "message_start" && event.message.role === "assistant") {
      assistants.set(key, message(actor, "", { ...common, complete: false }));
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
        type: event.type,
        message: publicMessage(event.message),
      });
      return;
    }
    if (event.type === "message_start") return;
    const { messages, message: ignored, ...safe } = event;
    trace({ ...common, ...safe });
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
    clearInterval(heartbeat);
    clearTimeout(timer);
    for (const reader of readers) reader.end();
    readers.clear();
  }

  return {
    state,
    update,
    message,
    text,
    trace,
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
  { port = 8080, host = "0.0.0.0" } = {},
) {
  const rootUrl = new URL("../", import.meta.url);
  const root = fileURLToPath(rootUrl);
  const assets = new Map([
    ["/", ["ui/index.html", "text/html; charset=utf-8"]],
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
      if (request.method === "GET" && url.pathname === "/healthz")
        return reply(200, "text/plain", "ok");
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        return reply(200, type, await readFile(new URL(name, rootUrl)));
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
      if (request.method !== "POST" || url.pathname !== "/api/actions")
        return json(404, { error: "Unknown route." });
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
      await application.close();
      application.view.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
