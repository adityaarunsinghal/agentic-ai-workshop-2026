// LEARNING: createTrace records model HTTP input/output and linked tool activity.
// Start with record, start and fetchTracked; execution-log.mjs stores and groups their records.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createExecutionLog } from "./execution-log.mjs";

const nativeFetch = globalThis.fetch;
const MODEL_HTTP_CAPTURE_BYTES = 32 * 1024 * 1024;
const DEFAULT_HTTP_CAPTURE_BYTES = 2 * 1024 * 1024;
// Never archive a transport cause's message, stack, URL, headers or credentials.
const networkCauseCodes = new Set([
  "UND_ERR_INVALID_ARG",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_PRX_TLS",
  "UND_ERR_PRX_CONN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);
function networkCause(error) {
  let cause = error?.cause;
  for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause)
    if (networkCauseCodes.has(cause.code)) {
      return { causeCode: cause.code };
    }
  return {};
}
const hidden = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api_key",
  "x-api-key",
  "token",
  "password",
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "providerreplay",
  "thinking",
  "thought",
  "thoughts",
  "thinkingsignature",
  "thoughtsignature",
]);
export function createTrace({
  secrets = [],
  initialEntries = [],
  directory,
  scopeId,
  maximumArchiveBytes,
} = {}) {
  const context = new AsyncLocalStorage();
  const archive = createExecutionLog({
    directory,
    scopeId,
    ...(maximumArchiveBytes === undefined ? {} : { maximumArchiveBytes }),
  });
  const observerReads = {};
  let budgetSource, clearHandler, clearing;

  for (const previous of archive.generation === 0 ? initialEntries : [])
    if (previous?.id && previous.kind && !archive.has(previous.id)) {
      archive.record(restoredEntry(previous));
    }
  function record(kind, data = {}) {
    const inherited = context.getStore();
    const entry = safe({
      id: randomUUID(),
      kind,
      actor: inherited?.actor || "harness",
      parentId: inherited?.parentId || null,
      ...(Number.isSafeInteger(inherited?.generation)
        ? { generation: inherited.generation }
        : {}),
      startedAt: new Date().toISOString(),
      status: "complete",
      ...data,
    });
    const captured = archive.record(entry);
    entry.generation = captured?.generation ?? archive.generation;
    return entry;
  }
  function start(kind, data = {}) {
    const began = performance.now();
    const entry = record(kind, { ...data, status: "running" });
    const generation = entry.generation;
    let ended = false;
    return {
      id: entry.id,
      generation,
      finish(result = {}) {
        if (ended) {
          return entry;
        }
        ended = true;
        Object.assign(
          entry,
          safe({
            status: "complete",
            durationMs: Number((performance.now() - began).toFixed(1)),
            endedAt: new Date().toISOString(),
            ...result,
          }),
        );
        archive.record(entry, { generation });
        return entry;
      },
    };
  }
  async function fetchTracked(input, init = {}, meta = {}) {
    const url = String(input?.url || input);
    const captureLimitBytes = ["model.http", "decision.http"].includes(meta.kind)
      ? MODEL_HTTP_CAPTURE_BYTES
      : Number.isSafeInteger(meta.maxBytes) && meta.maxBytes >= 0
        ? meta.maxBytes
        : DEFAULT_HTTP_CAPTURE_BYTES;
    const span = start(meta.kind || "http", {
      method: init.method || "GET",
      url,
      payload: typeof init.body === "string" ? parseBody(init.body) : undefined,
      ...meta,
      captureLimitBytes,
    });
    const signal = AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(meta.timeoutMs || 45000),
    ]);
    try {
      const response = await nativeFetch(input, { ...init, signal });
      const copy = response.clone();
      void (async () => {
        const reader = copy.body?.getReader();
        const chunks = [];
        let length = 0,
          capturedBytes = 0,
          truncated = false,
          captureError;
        if (reader) {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                break;
              }
              length += next.value.length;
              const remaining = captureLimitBytes - capturedBytes;
              const chunk = next.value.subarray(0, remaining);
              if (chunk.length) {
                chunks.push(chunk);
              }
              capturedBytes += chunk.length;
              if (next.value.length > remaining) {
                truncated = true;
                break;
              }
            }
          } catch (error) {
            captureError = error;
          } finally {
            // Cancelling a clone may wait for the application's branch. Capture
            // must finish independently without cancelling or awaiting that branch.
            if (truncated) {
              void reader.cancel().catch(() => {});
            }
            reader.releaseLock();
          }
        }
        const bytes = Buffer.concat(chunks, capturedBytes);
        const raw = bytes.toString("utf8");
        const partial = truncated || Boolean(captureError);
        const eventStream = copy.headers
          .get("content-type")
          ?.includes("text/event-stream");
        const result = eventStream
          ? raw
              .split(/\r?\n/)
              .filter((line) => {
                return line.startsWith("data:");
              })
              .map((line) => {
                return parseCapturedBody(line.slice(5).trim(), partial);
              })
          : parseCapturedBody(raw, partial);
        span.finish({
          status: captureError
            ? signal.aborted
              ? "cancelled"
              : "failed"
            : response.ok
              ? "complete"
              : "failed",
          httpStatus: response.status,
          responseHeaders: { "content-type": response.headers.get("content-type") },
          result,
          bytes: length,
          capturedBytes,
          truncated,
          ...(partial
            ? {
                captureIncomplete: true,
                captureReason: truncated
                  ? `HTTP capture reached its ${captureLimitBytes}-byte bound.`
                  : "HTTP capture retained the received prefix after a stream read failed.",
              }
            : {}),
          ...(captureError
            ? {
                error: String(captureError.message ?? captureError),
                ...networkCause(captureError),
              }
            : {}),
          digest: createHash("sha256").update(bytes).digest("hex"),
        });
      })().catch((error) => {
        return span.finish({
          status: "failed",
          error: error.message,
          ...networkCause(error),
        });
      });
      return response;
    } catch (error) {
      span.finish({
        status: signal.aborted ? "cancelled" : "failed",
        error: error.message,
        ...networkCause(error),
      });
      throw error;
    }
  }
  const api = {
    // Full access is for explicit export/tests. Editor snapshots use recent().
    get entries() {
      return archive.readAll();
    },
    get generation() {
      return archive.generation;
    },
    record,
    start,
    fetch: fetchTracked,
    safe,
    recent: (options) => {
      return archive.recent(options);
    },
    list: (options) => {
      return { ...archive.list(options), summary: api.summary() };
    },
    get: (id) => {
      return archive.get(id);
    },
    getExchange: (id) => {
      return archive.getExchange(id);
    },
    describe: (id) => {
      return archive.describe(id);
    },
    summary: () => {
      return {
        ...archive.summary(),
        observerReads: { ...observerReads },
        ...(budgetSource ? { budget: budgetSource() } : {}),
      };
    },
    setBudgetSource(source) {
      budgetSource = source;
    },
    setClearHandler(handler) {
      clearHandler = handler;
    },
    clear() {
      if (clearing) {
        return clearing;
      }
      for (const key of Object.keys(observerReads)) {
        delete observerReads[key];
      }
      clearing = archive
        .clear()
        .then(async () => {
          const state = await clearHandler?.();
          return state ?? api.summary();
        })
        .finally(() => {
          clearing = null;
        });
      return clearing;
    },
    count(kind) {
      observerReads[kind] = (observerReads[kind] ?? 0) + 1;
    },
    flush: () => {
      return archive.flush();
    },
    close: () => {
      return archive.close();
    },
    async restore(previous = []) {
      // A legacy checkpoint must not reappear in the current visible generation.
      // Retained archived generations already loaded from disk remain inspectable.
      if (archive.generation > 0) {
        previous = [];
      }
      const ids = new Set();
      for (const entry of previous) {
        if (!entry?.id || !entry.kind || ids.has(entry.id)) {
          throw new Error("Execution history contains an invalid or duplicate record.");
        }
        ids.add(entry.id);
      }
      // Migration is batched so retaining a large history cannot exhaust the
      // diagnostic write queue. The original JSON file remains unchanged.
      for (let offset = 0; offset < previous.length; offset += 50) {
        await archive.restore(previous.slice(offset, offset + 50).map(restoredEntry));
      }
      let cursor;
      do {
        const page = archive.list({
          view: "protocol",
          scope: "all",
          cursor,
          limit: 100,
        });
        for (const entry of page.records) {
          if (entry.status === "running") {
            archive.update(entry.id, {
              status: "interrupted",
              interruptedAt: new Date().toISOString(),
            });
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      await archive.flush();
    },
    context: () => {
      return context.getStore() || {};
    },
    withContext: (data, fn) => {
      return context.run({ ...(context.getStore() || {}), ...data }, fn);
    },
    subscribe(fn) {
      return archive.subscribe(() => {
        return fn(archive.recent());
      });
    },
    addSecret(secret) {
      if (secret) {
        secrets.push(secret);
      }
    },
    installFetch() {
      const tracked = (url, options) => {
        return fetchTracked(url, options);
      };
      globalThis.fetch = tracked;
      return () => {
        if (globalThis.fetch === tracked) {
          globalThis.fetch = nativeFetch;
        }
      };
    },
  };
  return api;

  // SUPPORTING HELPERS: declarations stay in the same scope.

  function safe(value, depth = 0) {
    if (depth > 18) {
      return "[nested data]";
    }
    if (typeof value === "string") {
      let text = value;
      for (const secret of secrets)
        if (secret) {
          text = text.replaceAll(secret, "[redacted]");
        }
      return text;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        return safe(entry, depth + 1);
      });
    }
    if (value && typeof value === "object") {
      const thoughtEvent = /^(thinking|reasoning)(?:_|$)/.test(value.type || "");
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          return [
            key,
            key === "trace" && Array.isArray(entry)
              ? { records: entry.length, availableInExecution: true }
              : hidden.has(key.toLowerCase()) ||
                  (thoughtEvent && ["delta", "text", "content"].includes(key))
                ? "[retained on server]"
                : safe(entry, depth + 1),
          ];
        }),
      );
    }
    return value;
  }

  function restoredEntry(previous) {
    const entry = safe(previous);
    if (entry.status === "running") {
      entry.status = "interrupted";
      entry.interruptedAt = new Date().toISOString();
    }
    return entry;
  }
}
function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function parseCapturedBody(text, partial) {
  if (text === "[DONE]") {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    // A cut JSON frame cannot be sanitized by field name. Retain preceding
    // complete frames and the fragment's size, without exposing partial replay.
    if (partial && /^[\s]*[{\[]/u.test(text)) {
      return {
        captureIncomplete: true,
        characters: text.length,
        reason: "Incomplete JSON fragment omitted to preserve field redaction.",
      };
    }
    return text;
  }
}
