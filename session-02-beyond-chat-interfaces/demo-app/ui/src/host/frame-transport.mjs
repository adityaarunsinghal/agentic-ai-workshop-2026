import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { transportError } from "../shared/rpc-transport.mjs";

export const HOSTED_SANDBOX_PATH = "/__workshop/mcp-sandbox";

// SDK Transport with explicit origin validation for the local two-origin path.
// A port is the sole authority for the hosted path after its window handshake.
export class FrameTransport {
  constructor({ source, origin, port, owner = window }) {
    Object.assign(this, { source, origin, port, owner });
    this.closed = false;
    this.receive = (event) => {
      if (this.closed) return;
      if (!port && (event.source !== source || event.origin !== origin)) return;
      const parsed = JSONRPCMessageSchema.safeParse(event.data);
      if (parsed.success) this.onmessage?.(parsed.data);
      else if (port || event.data?.jsonrpc !== undefined) this.onerror?.(transportError(
        "MCP_MALFORMED_MESSAGE", "Invalid MCP frame message.",
        { message: event.data, issues: parsed.error.issues },
      ));
    };
    this.receiveError = (event) => {
      if (this.closed || (!port && (event.source !== source || event.origin !== origin))) return;
      this.onerror?.(transportError("MCP_MALFORMED_MESSAGE", "The MCP frame message could not be decoded."));
    };
  }
  async start() {
    if (this.closed || this.started) throw new Error("The MCP frame transport is unavailable.");
    this.started = true;
    if (this.port) {
      this.port.addEventListener("message", this.receive);
      this.port.addEventListener("messageerror", this.receiveError);
      this.port.start();
    } else {
      this.owner.addEventListener("message", this.receive);
      this.owner.addEventListener("messageerror", this.receiveError);
    }
  }
  async send(message) {
    if (this.closed || !this.started) throw transportError("MCP_CONNECTION_CLOSED", "The MCP frame transport is closed.");
    if (this.port) this.port.postMessage(message);
    else this.source.postMessage(message, this.origin);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.port) {
      this.port.removeEventListener("message", this.receive);
      this.port.removeEventListener("messageerror", this.receiveError);
      this.port.close();
    } else {
      this.owner.removeEventListener("message", this.receive);
      this.owner.removeEventListener("messageerror", this.receiveError);
    }
    this.onclose?.();
  }
}

export function connectSandbox(iframe, sandbox, signal) {
  const hosted = sandbox.origin === window.location.origin && sandbox.pathname === HOSTED_SANDBOX_PATH;
  const nonce = hosted ? Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0")).join("") : "";
  if (hosted) sandbox.hash = nonce;
  iframe.setAttribute("sandbox", hosted ? "allow-scripts allow-forms" : "allow-scripts allow-same-origin allow-forms");
  iframe.referrerPolicy = "no-referrer";
  return new Promise((resolve, reject) => {
    let channel;
    let finished = false;
    const timer = setTimeout(() => finish(new Error("The MCP sandbox did not become ready. Hosted visits require the platform MCP sandbox ingress.")), 20000);
    function finish(error, transport) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      signal.removeEventListener("abort", aborted);
      if (channel) channel.port1.onmessage = null;
      if (error) { channel?.port1.close(); channel?.port2.close(); reject(error); }
      else resolve(transport);
    }
    function aborted() { finish(new DOMException("Cancelled", "AbortError")); }
    function listener(event) {
      if (event.source !== iframe.contentWindow || event.origin !== (hosted ? "null" : sandbox.origin)) return;
      if (!hosted) {
        if (event.data?.method === "ui/notifications/sandbox-proxy-ready") {
          finish(null, new FrameTransport({ source: iframe.contentWindow, origin: sandbox.origin }));
        }
      } else if (!channel && event.data?.type === "workshop/mcp-sandbox-ready" && event.data.nonce === nonce) {
        channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          if (data?.type === "workshop/mcp-sandbox-connected" && data.nonce === nonce) {
            finish(null, new FrameTransport({ port: channel.port1 }));
          }
        };
        // "*" is required for an opaque target. Source + null origin + nonce
        // authenticated this document; the document checks our exact origin.
        iframe.contentWindow.postMessage({ type: "workshop/mcp-sandbox-connect", nonce }, "*", [channel.port2]);
      }
    }
    window.addEventListener("message", listener);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    iframe.src = sandbox.href;
  });
}
