import test from "node:test";
import assert from "node:assert/strict";
import { connectSandbox, FrameTransport } from "../ui/src/host/frame-transport.mjs";
import { sandboxUrl } from "../ui/src/host/transport.mjs";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { RpcLifecycleTransport, transportFailure, transportLogParts } from "../ui/src/shared/rpc-transport.mjs";
import { sanitizeForInspection, toolError } from "../ui/src/shared/state.mjs";

test("per-visit HTTPS origins use only their platform-owned route, ignoring static local configuration", () => {
  const origin = "https://r-00000000-0000-4000-8000-000000000001.runtime.example.invalid";
  assert.equal(sandboxUrl(origin, "https://old.example.invalid").href, `${origin}/__workshop/mcp-sandbox`);
  assert.equal(sandboxUrl("http://localhost:8088").origin, "http://127.0.0.1:8088");
  assert.throws(() => sandboxUrl("https://unsupported.example.invalid"), /separate/);
  assert.throws(() => sandboxUrl("https://same.example.invalid", "https://same.example.invalid"), /different/);
});

test("window transport checks both source and exact origin before delivering valid MCP messages", async () => {
  const owner = new EventTarget();
  const sent = [];
  const source = { postMessage: (...args) => sent.push(args) };
  const origin = "http://127.0.0.1:8088";
  const transport = new FrameTransport({ source, origin, owner });
  const delivered = [];
  const errors = [];
  transport.onmessage = (message) => delivered.push(message);
  transport.onerror = (error) => errors.push(error);
  await transport.start();
  const rpc = { jsonrpc: "2.0", method: "ui/notifications/initialized" };
  function dispatch(windowSource, windowOrigin, data = rpc) {
    const event = new Event("message");
    Object.assign(event, { source: windowSource, origin: windowOrigin, data });
    owner.dispatchEvent(event);
  }
  dispatch(source, "null");
  dispatch({}, origin);
  dispatch(source, "https://attacker.invalid");
  dispatch(source, origin, { malformed: true });
  dispatch({}, origin, { jsonrpc: "2.0", id: 1, result: "bad" });
  assert.equal(delivered.length, 0);
  assert.equal(errors.length, 0);
  dispatch(source, origin, { jsonrpc: "2.0", id: 1, result: "bad" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "MCP_MALFORMED_MESSAGE");
  dispatch(source, origin);
  assert.deepEqual(delivered, [rpc]);
  await transport.send(rpc);
  assert.deepEqual(sent, [[rpc, origin]]);
  await transport.close();
  dispatch(source, origin);
  assert.equal(delivered.length, 1);
  await assert.rejects(transport.send(rpc), /closed/);
});

test("port transport receives only on its bound port and closes that capability", async () => {
  const channel = new MessageChannel();
  const transport = new FrameTransport({ port: channel.port1, owner: new EventTarget() });
  try {
    const errors = [];
    transport.onerror = (error) => errors.push(error);
    const delivered = new Promise((resolve) => { transport.onmessage = resolve; });
    await transport.start();
    channel.port2.postMessage({ malformed: true });
    channel.port2.postMessage({ jsonrpc: "2.0", id: 1, result: {} });
    assert.deepEqual(await delivered, { jsonrpc: "2.0", id: 1, result: {} });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "MCP_MALFORMED_MESSAGE");
    await transport.close();
    await assert.rejects(transport.send({ jsonrpc: "2.0", id: 2, result: {} }), /closed/);
  } finally { channel.port2.close(); await transport.close(); }
});

test("opaque handshake requires the exact frame, null origin and nonce and accepts one acknowledged port", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const owner = new EventTarget();
  owner.location = { origin: "https://r-00000000-0000-4000-8000-000000000001.runtime.example.invalid" };
  globalThis.window = owner;
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete globalThis.window;
  });
  const transferred = [];
  const source = { postMessage: (...args) => transferred.push(args) };
  const attributes = {};
  const iframe = { contentWindow: source, setAttribute: (key, value) => { attributes[key] = value; } };
  const abort = new AbortController();
  const sandbox = sandboxUrl(owner.location.origin);
  let connected = false;
  const pending = connectSandbox(iframe, sandbox, abort.signal).then((transport) => {
    connected = true;
    return transport;
  });
  const nonce = sandbox.hash.slice(1);
  assert.match(nonce, /^[a-f0-9]{64}$/);
  assert.equal(attributes.sandbox, "allow-scripts allow-forms");
  function ready(windowSource, origin, token) {
    const event = new Event("message");
    Object.assign(event, { source: windowSource, origin,
      data: { type: "workshop/mcp-sandbox-ready", nonce: token } });
    owner.dispatchEvent(event);
  }
  ready({}, "null", nonce);
  ready(source, owner.location.origin, nonce);
  ready(source, "null", "wrong");
  assert.equal(transferred.length, 0);
  ready(source, "null", nonce);
  ready(source, "null", nonce);
  assert.equal(transferred.length, 1);
  const [packet, targetOrigin, [port]] = transferred[0];
  assert.deepEqual(packet, { type: "workshop/mcp-sandbox-connect", nonce });
  assert.equal(targetOrigin, "*");
  port.postMessage({ type: "workshop/mcp-sandbox-connected", nonce: "wrong" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connected, false);
  port.postMessage({ type: "workshop/mcp-sandbox-connected", nonce });
  const transport = await pending;
  await transport.close();
  port.close();
});

test("aborting a pending sandbox removes its handshake listener and does not navigate", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const owner = new EventTarget();
  owner.location = { origin: "https://r-00000000-0000-4000-8000-000000000001.runtime.example.invalid" };
  globalThis.window = owner;
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete globalThis.window;
  });
  const abort = new AbortController();
  abort.abort();
  const iframe = { contentWindow: {}, setAttribute() {} };
  await assert.rejects(connectSandbox(iframe, sandboxUrl(owner.location.origin), abort.signal), { name: "AbortError" });
  assert.equal(iframe.src, undefined);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Hold only replies, after the real bridge handler has already completed.
// Cancellation can cross a posted reply even when the sender honors aborts.
class TestWire {
  sent = [];
  held = [];
  holdReplies = false;
  async start() {}
  async send(message) {
    this.sent.push(message);
    if (this.holdReplies && !message.method) this.held.push(message);
    else queueMicrotask(() => this.peer.onmessage?.(message));
  }
  release() {
    for (const message of this.held.splice(0)) this.peer.onmessage?.(message);
  }
  async close() { this.onclose?.(); }
}

async function sdkPair(t, { guarded = true, retiredLimit = 512 } = {}) {
  const appWire = new TestWire();
  const hostWire = new TestWire();
  appWire.peer = hostWire;
  hostWire.peer = appWire;
  const diagnostics = [], errors = [];
  const appTransport = guarded ? new RpcLifecycleTransport(appWire, {
    onDiagnostic: (event) => diagnostics.push(event), retiredLimit,
  }) : appWire;
  const hostTransport = new RpcLifecycleTransport(hostWire, { onDiagnostic: (event) => diagnostics.push(event) });
  const app = new App({ name: "Editor fixture", version: "1" }, {}, { autoResize: false });
  const bridge = new AppBridge(null, { name: "Host fixture", version: "1" }, { serverTools: {}, logging: {} });
  app.onerror = (error) => errors.push(error);
  bridge.onerror = (error) => errors.push(error);
  t.after(async () => { await app.close(); await bridge.close(); });
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  return { app, bridge, appWire, hostWire, appTransport, diagnostics, errors };
}

const archiveReply = {
  content: [{ type: "text", text: JSON.stringify({ executionPage: { records: [{ id: "fixture-record", label: "Research" }] } }) }],
  structuredContent: { executionPage: { records: [{ id: "fixture-record", label: "Research" }] } },
};

test("pinned SDK reproduces the screenshot error when cancellation crosses a completed archive reply", async (t) => {
  const { app, bridge, hostWire, errors } = await sdkPair(t, { guarded: false });
  bridge.oncalltool = async () => archiveReply;
  hostWire.holdReplies = true;
  const abort = new AbortController();
  const pending = app.callServerTool({ name: "list_execution" }, { signal: abort.signal });
  await tick();
  assert.equal(hostWire.held.length, 1, "the reply is already in flight");
  abort.abort();
  await assert.rejects(pending);
  hostWire.release();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^Received a response for an unknown message ID: /);
  assert.match(errors[0].message, /executionPage/);
});

test("cancelled in-flight completion is archived once without SDK error or a replay", async (t) => {
  const { app, bridge, appWire, hostWire, diagnostics, errors } = await sdkPair(t);
  let calls = 0;
  bridge.oncalltool = async () => { calls++; return archiveReply; };
  hostWire.holdReplies = true;
  const abort = new AbortController();
  const pending = app.callServerTool({ name: "list_execution" }, { signal: abort.signal });
  await tick();
  const [reply] = hostWire.held;
  abort.abort();
  await assert.rejects(pending);
  hostWire.release();
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "MCP_LATE_CANCELLED_RESPONSE");
  assert.equal(diagnostics[0].details.request.id, reply.id);
  assert.equal(diagnostics[0].details.request.tool, "list_execution");
  assert.deepEqual(diagnostics[0].details.response, reply);
  assert.equal(appWire.sent.filter((item) => item.method === "notifications/cancelled").length, 1);
  hostWire.holdReplies = false;
  assert.deepEqual(await app.callServerTool({ name: "list_execution" }), archiveReply, "next explicit read works");
});

test("cancelling pending work aborts the bridge handler and sends no response when it completes", async (t) => {
  const { app, bridge, hostWire, diagnostics, errors } = await sdkPair(t);
  const entered = deferred(), finish = deferred();
  let signal;
  bridge.oncalltool = async (_params, extra) => {
    signal = extra.signal;
    entered.resolve();
    await finish.promise;
    return archiveReply;
  };
  const abort = new AbortController();
  const pending = app.callServerTool({ name: "list_execution" }, { signal: abort.signal });
  await entered.promise;
  const before = hostWire.sent.length;
  abort.abort();
  await assert.rejects(pending);
  await tick();
  assert.equal(signal.aborted, true);
  finish.resolve();
  await tick();
  assert.equal(hostWire.sent.length, before);
  assert.deepEqual(errors, []);
  assert.deepEqual(diagnostics, []);
});

test("timeout stays a request failure while its later reply is only a cancellation diagnostic", async (t) => {
  const { app, bridge, hostWire, diagnostics, errors } = await sdkPair(t);
  bridge.oncalltool = async () => archiveReply;
  hostWire.holdReplies = true;
  const pending = app.callServerTool({ name: "list_execution" }, { timeout: 15 });
  await assert.rejects(pending, /timed out/i);
  assert.equal(hostWire.held.length, 1);
  hostWire.release();
  assert.deepEqual(errors, []);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].details.request.reason, /timed out/i);
});

test("unexpected replies and malformed cancelled replies remain real, concise, diagnosable errors", async (t) => {
  const { app, bridge, appWire, hostWire, diagnostics, errors } = await sdkPair(t);
  const unexpected = { jsonrpc: "2.0", id: 987654, result: archiveReply };
  appWire.onmessage(unexpected);
  assert.equal(errors.length, 1);
  const failure = transportFailure(errors[0]);
  assert.equal(failure.code, "MCP_UNEXPECTED_RESPONSE");
  assert.match(failure.message, /unexpected reply/);
  assert.ok(failure.message.length < 200);
  assert.doesNotMatch(failure.message, /jsonrpc|executionPage/);
  assert.deepEqual(failure.details.response, unexpected);

  bridge.oncalltool = async () => archiveReply;
  hostWire.holdReplies = true;
  const abort = new AbortController();
  const pending = app.callServerTool({ name: "list_execution" }, { signal: abort.signal });
  await tick();
  const id = hostWire.held[0].id;
  abort.abort();
  await assert.rejects(pending);
  appWire.onmessage({ jsonrpc: "2.0", id, result: "not a result object" });
  assert.equal(errors.length, 2);
  assert.equal(errors[1].code, "MCP_MALFORMED_MESSAGE");
  assert.deepEqual(diagnostics, []);
});

test("real tool and transport failures retain their actionable reason; completed aborts do not excuse duplicates", async (t) => {
  const { app, bridge, appWire, diagnostics, errors } = await sdkPair(t);
  bridge.oncalltool = async ({ name }) => {
    if (name === "get_editor_state") throw new Error("Workshop connection unavailable");
    return { isError: true, content: [{ type: "text", text: "STORAGE_SAVE_FAILED: Retry save." }] };
  };
  const abort = new AbortController();
  const result = await app.callServerTool({ name: "edit_story" }, { signal: abort.signal });
  assert.match(toolError(result).message, /STORAGE_SAVE_FAILED: Retry save/);
  const request = appWire.sent.find((item) => item.method === "tools/call");
  abort.abort();
  appWire.onmessage({ jsonrpc: "2.0", id: request.id, result });
  assert.equal(diagnostics.length, 0);
  assert.match(errors[0].message, /unknown message ID/);
  await assert.rejects(app.callServerTool({ name: "get_editor_state" }), /Workshop connection unavailable/);
  appWire.onerror(new Error("Message channel failed"));
  assert.match(transportFailure(errors.at(-1)).message, /Message channel failed/);
});

test("closing a transport rejects pending SDK work and releases cancellation state", async (t) => {
  const { app, bridge, appTransport } = await sdkPair(t);
  const entered = deferred(), finish = deferred();
  bridge.oncalltool = async () => { entered.resolve(); await finish.promise; return archiveReply; };
  const pending = app.callServerTool({ name: "list_execution" });
  await entered.promise;
  await appTransport.close();
  await assert.rejects(pending, /Connection closed/);
  assert.equal(appTransport.pending.size, 0);
  assert.equal(appTransport.cancelled.size, 0);
  await appTransport.close();
  finish.resolve();
});

test("large transport diagnostics preserve sanitized original details in ordered archive-sized parts", () => {
  const diagnostic = transportFailure(new Error(`Received a response for an unknown message ID: ${JSON.stringify({
    jsonrpc: "2.0", id: 170, result: { content: "\u0000\\\"\n🗞".repeat(16000), token: "private-fixture-token" },
  })}`));
  diagnostic.details.extra = { token: "private-fixture-token", message: "Bearer private-fixture-secret" };
  const parts = transportLogParts(diagnostic);
  assert.ok(parts.length > 1);
  assert.equal(new Set(parts.map((part) => part.data.eventId)).size, 1);
  assert.deepEqual(parts.map((part) => part.data.part), parts.map((_part, index) => index + 1));
  for (const part of parts) {
    assert.ok(Buffer.byteLength(JSON.stringify({
      id: crypto.randomUUID(), kind: "app.log", status: "failed",
      startedAt: new Date().toISOString(), payload: part, result: null,
    })) < 64 * 1024);
    assert.equal(part.data.parts, parts.length);
  }
  assert.deepEqual(JSON.parse(parts.map((part) => part.data.details).join("")), sanitizeForInspection(diagnostic.details));
  assert.doesNotMatch(JSON.stringify(parts), /private-fixture-token|private-fixture-secret/);
});
