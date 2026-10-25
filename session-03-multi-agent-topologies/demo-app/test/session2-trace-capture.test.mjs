import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTrace } from "../src/trace.mjs";

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function captured(trace, id) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (trace.describe(id)?.status !== "running") {
      await trace.flush();
      return trace.get(id);
    }
    await delay(10);
  }
  assert.fail("The HTTP capture did not finish.");
}

test("a 9 MiB fixture preserves full sanitized strings and SSE beyond both former capture bounds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "trace-large-capture-"));
  let trace = createTrace({ directory, scopeId: "large-fixture", secrets: ["fixture-secret"] });
  t.after(async () => { await trace.close(); await rm(directory, { recursive: true, force: true }); });
  const visible = `${"x".repeat(9 * 1024 * 1024)} fixture-secret final-visible-suffix`;
  const sanitized = visible.replace("fixture-secret", "[redacted]");
  const event = { choices: [{ delta: { content: visible, reasoning: "private replay" } }] };
  const wire = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
  const origin = await localServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(wire);
  });
  trace.withContext({ generation: 0 }, () => trace.record("model.request", {
    id: "large-request", operationId: "large-operation",
    payload: { messages: [{ role: "user", content: visible }] },
  }));
  const response = await trace.withContext({ generation: 0 }, () =>
    trace.fetch(origin, {}, { id: "large-http", kind: "model.http", operationId: "large-operation" }));
  // The application receives the full original response; trace redaction never
  // rewrites its model input or stream.
  assert.equal(await response.text(), wire);
  const record = await captured(trace, "large-http");
  assert.equal(record.status, "complete");
  assert.equal(record.truncated, false);
  assert.equal(record.captureLimitBytes, 32 * 1024 * 1024);
  assert.equal(record.captureIncomplete, undefined);
  assert.equal(record.bytes, Buffer.byteLength(wire));
  assert.equal(record.capturedBytes, Buffer.byteLength(wire));
  assert.equal(record.digest, createHash("sha256").update(wire).digest("hex"));
  assert.equal(record.result[0].choices[0].delta.content, sanitized);
  assert.equal(record.result[0].choices[0].delta.reasoning, "[retained on server]");
  assert.equal(record.result[1], "[DONE]");
  assert.equal((await trace.get("large-request")).payload.messages[0].content, sanitized);
  assert.equal(trace.summary().capture.status, "complete");
  assert.equal(trace.summary().capture.droppedRecords, 0);
  assert.equal(trace.list({ view: "protocol" }).total, 2);
  await trace.close();
  trace = createTrace({ directory, scopeId: "large-fixture" });
  assert.equal((await trace.get("large-http")).result[0].choices[0].delta.content, sanitized);
  assert.equal((await trace.get("large-request")).payload.messages[0].content, sanitized);
});

test("a failed stream keeps received frames, HTTP metadata and its generation without exposing a partial replay", async (t) => {
  const trace = createTrace();
  t.after(() => trace.close());
  const event = { choices: [{ delta: { content: "The visible prefix.", reasoning: "private full replay" } }] };
  const partial = '{"choices":[{"delta":{"reasoning":"private partial replay';
  const prefix = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\ndata: ${partial}`;
  let abort;
  const origin = await localServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(prefix);
    abort = () => response.destroy();
  });
  const response = await trace.withContext({ generation: 0 }, () =>
    trace.fetch(origin, {}, { id: "partial-http", kind: "model.http", operationId: "partial-operation" }));
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString("utf8"), prefix);
  // The original and clone both receive the prefix before the fixture socket fails.
  await delay(10);
  await trace.clear();
  abort();
  await assert.rejects(reader.read());
  reader.releaseLock();
  const record = await captured(trace, "partial-http");
  assert.equal(record.status, "failed");
  assert.equal(record.httpStatus, 200);
  assert.equal(record.responseHeaders["content-type"], "text/event-stream");
  assert.equal(record.generation, 0);
  assert.equal(record.captureIncomplete, true);
  assert.match(record.captureReason, /received prefix/);
  assert.equal(record.truncated, false);
  assert.equal(record.bytes, Buffer.byteLength(prefix));
  assert.equal(record.capturedBytes, Buffer.byteLength(prefix));
  assert.equal(record.digest, createHash("sha256").update(prefix).digest("hex"));
  assert.equal(record.result[0].choices[0].delta.content, "The visible prefix.");
  assert.equal(record.result[0].choices[0].delta.reasoning, "[retained on server]");
  assert.equal(record.result[1], "[DONE]");
  assert.equal(record.result[2].captureIncomplete, true);
  assert.equal(record.result[2].characters, partial.length);
  assert.doesNotMatch(JSON.stringify(record), /private full replay|private partial replay/);
  assert.equal(trace.list().total, 0, "completion stays in the pre-clear generation");
  assert.equal(trace.list({ view: "protocol", scope: "all" }).total, 1);
});

test("source capture respects maxBytes and stops its clone when the source consumer stops", async (t) => {
  const trace = createTrace();
  t.after(() => trace.close());
  const maxBytes = 1024 * 1024, total = 4 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, "x");
  let sent = 0;
  const origin = await localServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => {
      sent += chunk.length;
      response.write(chunk);
      if (sent >= total) { clearInterval(timer); response.end(); }
    }, 1);
    response.on("close", () => clearInterval(timer));
  });
  const response = await trace.fetch(origin, {}, { id: "source-http", kind: "source.read", maxBytes });
  const reader = response.body.getReader();
  let received = 0;
  while (received < maxBytes) {
    const next = await reader.read();
    assert.equal(next.done, false);
    received += next.value.length;
  }
  await reader.cancel();
  reader.releaseLock();
  const record = await captured(trace, "source-http");
  assert.equal(record.status, "complete");
  assert.equal(record.captureLimitBytes, maxBytes);
  assert.equal(record.capturedBytes, maxBytes);
  assert.equal(record.result, "x".repeat(maxBytes));
  assert.equal(record.truncated, true);
  assert.equal(record.captureIncomplete, true);
  assert.match(record.captureReason, /1048576-byte/);
  assert.ok(sent < total, "the clone must not drain the source after its consumer cancels");
});

test("ordinary HTTP keeps the 2 MiB default while decision HTTP gets the model capture limit", async (t) => {
  const trace = createTrace();
  t.after(() => trace.close());
  const body = "x".repeat(3 * 1024 * 1024);
  const origin = await localServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });
  for (const [kind, maxBytes, expectedLimit, expectedBytes] of [
    ["http", undefined, 2 * 1024 * 1024, 2 * 1024 * 1024],
    ["decision.http", 1024, 32 * 1024 * 1024, body.length],
  ]) {
    const response = await trace.fetch(origin, {}, { id: kind, kind, maxBytes });
    assert.equal(await response.text(), body, "capture limits do not truncate the caller's response");
    const record = await captured(trace, kind);
    assert.equal(record.captureLimitBytes, expectedLimit);
    assert.equal(record.capturedBytes, expectedBytes);
    assert.equal(record.result.length, expectedBytes);
    assert.equal(record.truncated, expectedBytes < body.length);
  }
});
