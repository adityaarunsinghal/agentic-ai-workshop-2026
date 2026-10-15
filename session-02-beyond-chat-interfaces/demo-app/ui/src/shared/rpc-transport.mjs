import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage, sanitizeForInspection } from "./state.mjs";

const UNKNOWN_RESPONSE = "Received a response for an unknown message ID: ";
const requestId = (value) => typeof value === "string" || Number.isSafeInteger(value);
const response = (message) => requestId(message?.id) && !message.method &&
  (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));

export function transportError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

// SDK diagnostics can contain an entire tool response. Preserve that separately
// from the actionable notice; an unknown ID alone is never evidence of a cancel.
export function transportFailure(error) {
  const original = errorMessage(error);
  let unexpectedResponse;
  if (original.startsWith(UNKNOWN_RESPONSE)) {
    try { unexpectedResponse = JSON.parse(original.slice(UNKNOWN_RESPONSE.length)); }
    catch { /* An unparseable SDK error is still an error, never a late reply. */ }
  }
  const code = error?.code ?? (original.startsWith(UNKNOWN_RESPONSE)
    ? "MCP_UNEXPECTED_RESPONSE" : "MCP_TRANSPORT_ERROR");
  const recovery = "Check Execution, then retry or reconnect the view.";
  const reason = original.length <= 360 && !/[{[]/.test(original)
    ? original : "The editor connection encountered an error.";
  const message = code === "MCP_UNEXPECTED_RESPONSE"
    ? "The editor received an unexpected reply. Check Execution, then retry the interrupted action."
    : code === "MCP_MALFORMED_MESSAGE" || original.startsWith("Invalid JSON-RPC message received:")
      ? "The editor received an unreadable message. Check Execution, then reconnect the view."
      : code === "MCP_CONNECTION_CLOSED"
        ? "The editor connection closed. Copy any unsaved text, then reload the page."
        : reason.endsWith(recovery) ? reason : `${reason} ${recovery}`;
  return {
    code, message, level: "error",
    details: { name: error?.name ?? "Error",
      // Structured originals let the archive redact secret fields inside an
      // SDK error's serialized response, as it does for normal tool records.
      message: unexpectedResponse ? UNKNOWN_RESPONSE.trimEnd() : original,
      ...(unexpectedResponse ? { response: unexpectedResponse } : {}),
      ...(error?.code !== undefined ? { code: error.code } : {}),
      ...(error?.details !== undefined ? { details: error.details } : {}) },
  };
}

// One logical diagnostic can exceed the browser archive's 64 KiB POST limit.
// Chunk the sanitized JSON without losing it, keeping a shared ID and ordering.
// Original details belong only in the on-demand archive, never a UI notice.
export function transportLogParts(diagnostic) {
  const id = crypto.randomUUID();
  const text = JSON.stringify(sanitizeForInspection(diagnostic.details ?? null));
  const chunkSize = 6000; // Even JSON-escaped UTF-16 stays below the POST limit.
  const count = Math.max(1, Math.ceil(text.length / chunkSize));
  return Array.from({ length: count }, (_, index) => ({
    level: diagnostic.level ?? "info", logger: "workshop.mcp.transport",
    data: {
      eventId: id, code: diagnostic.code, message: diagnostic.message,
      part: index + 1, parts: count, encoding: "json",
      details: text.slice(index * chunkSize, (index + 1) * chunkSize),
    },
  }));
}

// Observe actual wire cancellations, including the SDK's timeout cancellation,
// before a later response reaches the SDK. Do not inspect SDK private maps or
// suppress arbitrary "unknown message ID" errors. Both frame endpoints use this.
export class RpcLifecycleTransport {
  constructor(transport, { onDiagnostic = () => {}, retiredLimit = 512 } = {}) {
    this.transport = transport;
    this.onDiagnostic = onDiagnostic;
    this.retiredLimit = retiredLimit;
    this.pending = new Map();
    this.cancelled = new Map();
    this.closed = false;
    this.finishClose = () => {
      if (this.closed) return;
      this.closed = true;
      this.pending.clear();
      this.cancelled.clear();
      this.onclose?.();
    };
  }
  get sessionId() { return this.transport.sessionId; }
  setProtocolVersion(version) { this.transport.setProtocolVersion?.(version); }
  async start() {
    this.transport.onmessage = (message, extra) => {
      if (this.closed) return;
      const parsed = JSONRPCMessageSchema.safeParse(message);
      if (!parsed.success) {
        this.onerror?.(transportError("MCP_MALFORMED_MESSAGE", "Invalid MCP frame message.", {
          message, issues: parsed.error.issues,
        }));
        return;
      }
      if (response(message)) {
        const retired = this.cancelled.get(message.id);
        if (retired) {
          this.onDiagnostic({
            code: "MCP_LATE_CANCELLED_RESPONSE", level: "info",
            message: "A reply arrived after its editor request was cancelled.",
            details: { request: retired, response: message },
          });
          return;
        }
        this.pending.delete(message.id);
      }
      this.onmessage?.(message, extra);
    };
    this.transport.onerror = (error) => { if (!this.closed) this.onerror?.(error); };
    this.transport.onclose = this.finishClose;
    await this.transport.start();
  }
  async send(message, options) {
    if (this.closed) throw transportError("MCP_CONNECTION_CLOSED", "The MCP frame transport is closed.");
    const isRequest = requestId(message.id) && typeof message.method === "string";
    if (isRequest) {
      this.cancelled.delete(message.id);
      this.pending.set(message.id, {
        id: message.id, method: message.method, tool: message.params?.name,
      });
    } else if (message.method === "notifications/cancelled" && requestId(message.params?.requestId)) {
      const id = message.params.requestId;
      const pending = this.pending.get(id);
      // The SDK can emit another cancel when an already-settled signal aborts.
      // That does not turn an unsolicited/duplicate reply into a harmless one.
      if (pending) {
        this.pending.delete(id);
        this.cancelled.set(id, { ...pending, reason: message.params.reason });
        while (this.cancelled.size > this.retiredLimit)
          this.cancelled.delete(this.cancelled.keys().next().value);
      }
    }
    try { await this.transport.send(message, options); }
    catch (error) {
      if (isRequest) this.pending.delete(message.id);
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    // Close the SDK first, rejecting its in-flight requests exactly once.
    try { await this.transport.close(); }
    finally { this.finishClose(); }
  }
}
