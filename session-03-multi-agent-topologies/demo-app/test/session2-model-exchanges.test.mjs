import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createExecutionLog } from "../src/execution-log.mjs";
import {
  compactRecord, correlatedExchange, exchangeStillCapturing, executionPage, executionParams,
} from "../ui/src/shared/execution.mjs";

const payload = {
  model: "example/model",
  messages: [
    { role: "system", content: "Preserve every captured input field." },
    { role: "user", content: "Research the workshop." },
    { role: "assistant", tool_calls: [{ id: "read-1", type: "function",
      function: { name: "fetch_read", arguments: '{"url":"https://example.test/story"}' } }] },
    { role: "tool", tool_call_id: "read-1", content: "Full observed source. ".repeat(500) },
  ],
  tools: [{ type: "function", function: { name: "write_story", description: "Save grounded copy",
    parameters: { type: "object", properties: { headline: { type: "string" } }, required: ["headline"] } } }],
  stream: true, stream_options: { include_usage: true },
};
const assistant = {
  role: "assistant", content: [{ type: "toolCall", id: "write-4", name: "write_story",
    arguments: { headline: "A grounded workshop story" } }], stopReason: "toolUse",
};
const wireOutput = [
  { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-4",
    function: { name: "write_story", arguments: '{"headline":"A grounded workshop story"}' } }] } }] },
  { choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 25, completion_tokens: 14 } },
  "[DONE]",
];

function model(archive, operationId, { jobId, parentId, requestId, turn = 1, maxTurns = 10, ...options } = {}) {
  const data = { operationId, jobId, parentId, requestId, turn, model: payload.model, mode: "development", ...options };
  archive.record({ ...data, id: operationId, kind: "model", status: "completed", maxTurns, toolsDisabled: false });
  archive.record({ ...data, id: `${operationId}-request`, kind: "model.request",
    parentId: operationId, payload, headers: { "x-workshop-operation-id": operationId, "x-custom": "captured" } });
  archive.record({ ...data, id: `${operationId}-http`, kind: "model.http",
    parentId: operationId, payload, url: "https://gateway.example.test/v1/llm/chat/completions",
    method: "POST", result: wireOutput, httpStatus: 200, bytes: 1234, digest: "captured-digest",
    responseHeaders: { "content-type": "text/event-stream", "x-response-field": "keep-me" } });
  archive.record({ ...data, id: `${operationId}-response`, kind: "model.response",
    parentId: operationId, message: assistant, status: "completed" });
}

test("paired detail hydrates the exact HTTP payload and response, with immutable raw records and explicit references", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paired-execution-"));
  let archive = createExecutionLog({ directory, scopeId: "paired" });
  t.after(async () => { await archive.close(); await rm(directory, { recursive: true, force: true }); });
  archive.record({ id: "root", kind: "story", jobId: "research", status: "completed" });
  model(archive, "turn-4", { jobId: "research", parentId: "root", turn: 4 });
  archive.record({ id: "sdk", kind: "model.sdk_payload", operationId: "turn-4", jobId: "research",
    payload: { messages: [{ role: "user", content: "This differs from the captured HTTP body." }] } });
  archive.record({ id: "chunk", kind: "model.provider_event", operationId: "turn-4", jobId: "research",
    event: wireOutput[0] });
  archive.record({ id: "wire-headers", kind: "model.http_response", operationId: "turn-4", jobId: "research",
    headers: { "x-workshop-operation-id": "turn-4", "x-provider-route": "observed-value" }, status: 200 });
  archive.record({ id: "write-result", kind: "mcp.call", jobId: "research", toolCallId: "write-4",
    tool: "write_story", result: { applied: true, storyId: "story" } });
  archive.record({ id: "tool-message", kind: "agent.message_end", jobId: "research",
    message: { role: "toolResult", toolCallId: "write-4", content: [{ type: "text", text: "Story saved" }] } });
  archive.record({ id: "unrelated-tool", kind: "mcp.call", jobId: "different-job",
    toolCallId: "write-4", result: { secretToOtherJob: "must not correlate" } });
  model(archive, "other-operation", { jobId: "different-job", parentId: "other-root" });
  await archive.flush();
  const originals = archive.readAll();
  const files = (await readdir(directory)).filter((file) => file.endsWith(".ndjson"));
  const bytes = await Promise.all(files.map((file) => readFile(join(directory, file))));
  const enriched = await archive.getExchange("turn-4");
  const exchange = correlatedExchange(enriched);
  assert.ok(exchange);
  assert.equal(exchange.derived, true);
  assert.deepEqual(exchange.request.http[0], {
    recordId: "turn-4-http", kind: "model.http", field: "payload", value: payload,
  });
  assert.deepEqual(exchange.response.http[0].value, wireOutput);
  assert.deepEqual(exchange.response.assistant[0].value, assistant);
  assert.deepEqual(exchange.response.chunks[0].value, wireOutput[0]);
  assert.equal(exchange.transport[0].value.bytes, 1234);
  assert.equal(exchange.transport[0].value.digest, "captured-digest");
  assert.equal(exchange.response.headers[1].value["x-provider-route"], "observed-value");
  assert.equal(exchange.request.headers[0].value["x-custom"], "captured");
  assert.match(exchange.boundary, /app gateway.*routing may be added downstream/);
  assert.deepEqual(exchange.relatedTools.map((entry) => entry.recordId), ["write-result", "tool-message"]);
  assert.equal(exchange.originalRecordIds.includes("other-operation-response"), false);
  assert.equal((await archive.get("turn-4")).exchange, undefined);
  assert.deepEqual(archive.readAll(), originals);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(join(directory, file)))), bytes);
  const page = executionPage(archive.list());
  const row = page.records.find((record) => record.id === "turn-4");
  assert.equal(row.rawCount, 7);
  assert.equal(row.finalExchange, true);
  assert.equal(row.exchange, undefined, "list responses contain no paired payload");
  assert.equal(JSON.stringify(page).includes("Full observed source"), false);
  assert.equal(archive.summary().requestCount, 2);
  await archive.clear();
  assert.deepEqual((await archive.getExchange("turn-4")).exchange, exchange);
  await archive.close();
  archive = createExecutionLog({ directory, scopeId: "paired" });
  assert.deepEqual((await archive.getExchange("turn-4")).exchange, exchange);
  assert.deepEqual(await archive.get("turn-4-request"), originals.find((record) => record.id === "turn-4-request"));
});

test("final means the last exchange of a terminal job, including research tool calls and independent resize/typography jobs", async (t) => {
  const archive = createExecutionLog();
  t.after(() => archive.close());
  archive.record({ id: "research-root", kind: "story", jobId: "research", status: "running" });
  for (let turn = 1; turn <= 4; turn++)
    model(archive, `research-${turn}`, { jobId: "research", parentId: "research-root", turn });
  assert.equal(archive.list().records.some((record) => record.finalExchange), false);
  assert.equal(exchangeStillCapturing(await archive.getExchange("research-4")), true);
  archive.update("research-root", { status: "completed", turn: 4 });
  archive.record({ id: "resize-root", kind: "story", jobId: "resize", status: "completed" });
  model(archive, "resize-1", { jobId: "resize", parentId: "resize-root", maxTurns: 1, requestKind: "resize" });
  archive.record({ id: "typography-root", kind: "editorial", status: "completed" });
  archive.record({ id: "typography-batch", kind: "editorial.batch", parentId: "typography-root", status: "complete" });
  model(archive, "typography-1", { parentId: "typography-batch", requestId: "typography-root", maxTurns: 1 });
  // Completion order and sparse finalTurn flags cannot replace request order.
  archive.update("research-1-http", { result: [{ delayedCapture: true }] });
  const rows = archive.list({ limit: 50, order: "asc" }).records;
  assert.deepEqual(rows.filter((record) => record.finalExchange).map((record) => record.id),
    ["research-4", "resize-1", "typography-1"]);
  const research = rows.find((record) => record.id === "research-4");
  assert.equal(research.exchangeCount, 4);
  assert.equal(research.exchangeIndex, 4);
  assert.equal(research.maxTurns, 10);
  assert.equal((await archive.get("research-4")).toolsDisabled, false);
  assert.equal(rows.find((record) => record.id === "resize-1").exchangeCount, 1);
  assert.equal(rows.find((record) => record.id === "typography-1").exchangeCount, 1);
  assert.equal(compactRecord(research).finalExchange, true);
  assert.equal(exchangeStillCapturing(await archive.getExchange("research-4")), false);
  archive.update("research-4-http", { status: "running" });
  assert.equal(exchangeStillCapturing(await archive.getExchange("research-4")), true,
    "late HTTP capture keeps the selected detail refreshing");
});

test("native decision request/http/response/span form one exchange with raw typed state, questions and answers", async (t) => {
  const archive = createExecutionLog();
  t.after(() => archive.close());
  const state = { title: "Workshop", stories: [{ id: "story", text: "Unchanged text" }] };
  const questions = { style: { type: "choice", choices: ["serif", "sans"] },
    tone: { type: "noul", description: "Assess tone" } };
  const answers = { style: { choice: "serif" }, tone: { value: 0.7 } };
  const body = JSON.stringify({ answers, model: "typesafe/jev" });
  archive.record({ id: "review", kind: "editorial", status: "completed" });
  const common = { operationId: "jev-op", requestId: "review", parentId: "review" };
  archive.record({ ...common, id: "jev", kind: "decision", status: "completed", state, questions, answers });
  archive.record({ ...common, id: "jev-request", kind: "decision.request", payload: { state, questions } });
  archive.record({ ...common, id: "jev-http", kind: "decision.http",
    url: "https://gateway.example.test/v1/services/decisions", payload: { state, questions },
    result: JSON.parse(body), httpStatus: 200 });
  archive.record({ ...common, id: "jev-response", kind: "decision.response", status: 200, body });
  assert.equal(archive.list().total, 2);
  assert.equal(archive.list({ view: "protocol" }).total, 5);
  assert.equal(archive.summary().requestCount, 1);
  assert.equal(archive.list({ query: "jev-http" }).records[0].id, "jev");
  const row = archive.list().records.find((record) => record.id === "jev");
  assert.equal(row.rawCount, 4);
  assert.equal(row.finalExchange, true);
  assert.equal(row.exchangeCount, 1);
  const { exchange } = await archive.getExchange("jev-response");
  assert.equal(exchange.originalRecordId, "jev-response");
  assert.deepEqual(exchange.decision.state[0].value, state);
  assert.deepEqual(exchange.decision.questions[0].value, questions);
  assert.deepEqual(exchange.decision.answers[0].value, answers);
  assert.equal(exchange.response.body[0].value, body);
  assert.deepEqual(exchange.response.http[0].value, JSON.parse(body));
  assert.equal((await archive.get("jev-response")).body, body);
});

test("missing HTTP capture stays explicit and broker-only metadata cannot invent upstream I/O", async (t) => {
  const archive = createExecutionLog();
  t.after(() => archive.close());
  archive.record({ id: "only-span", kind: "model", operationId: "missing", status: "completed", maxTurns: 1 });
  const { exchange } = await archive.getExchange("only-span");
  assert.deepEqual(exchange.request.http, []);
  assert.deepEqual(exchange.request.captured, []);
  assert.deepEqual(exchange.response.http, []);
  assert.deepEqual(exchange.response.assistant, []);
  assert.match(exchange.boundary, /not established/);
  assert.equal(await archive.getExchange("absent"), null);
});

test("a final row is visibly distinct and clicking it requests paired detail with colored I/O trees", async (t) => {
  const archive = createExecutionLog();
  t.after(() => archive.close());
  archive.record({ id: "root", kind: "story", jobId: "research", status: "completed" });
  archive.record({ id: "batch", kind: "editorial.batch", parentId: "root", operationId: "final-call",
    status: "complete", usage: { cost: 0.01 }, questionsCount: 2 });
  model(archive, "final-call", { jobId: "research", parentId: "batch", turn: 4, costUsd: 0.01 });
  const cacheDir = await mkdtemp(join(tmpdir(), "exchange-ui-"));
  const vite = await createServer({
    configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir,
    server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom",
  });
  t.after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
  const { Execution } = await vite.ssrLoadModule("/ui/src/shared/Execution.jsx");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const globals = {};
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root"));
  const client = new QueryClient();
  const filters = { view: "teaching", query: "", taskId: "" };
  client.setQueryData(["execution-page", "paper", filters, null], executionPage(archive.list(executionParams())));
  const calls = [];
  t.after(async () => {
    await act(() => root.unmount());
    client.clear();
    dom.window.close();
    for (const [key, descriptor] of Object.entries(globals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(() => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(Execution, {
      issueId: "paper",
      getExecutionRecord: async (id, signal, options) => {
        calls.push({ id, options });
        return options?.includeExchange ? archive.getExchange(id) : archive.get(id);
      },
    }))));
  const finalRow = dom.window.document.querySelector('[data-final-exchange="true"]');
  assert.ok(finalRow);
  assert.equal(finalRow.querySelector("button").style.borderLeftWidth, "6px");
  assert.match(finalRow.textContent, /Final request in this run/);
  assert.doesNotMatch(finalRow.textContent, /4\/10/);
  const overview = dom.window.document.querySelector(".workflow-overview details");
  assert.equal(overview.open, false);
  assert.match(overview.querySelector("summary").textContent, /Run total · 1 model request/);
  assert.match(overview.querySelector("summary").textContent, /reported across these requests/);
  assert.equal(dom.window.document.querySelectorAll(".request-button").length, 1,
    "batch cost does not produce another charged row");
  assert.match(finalRow.textContent, /2 judgments/);
  await act(async () => {
    finalRow.querySelector("button").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.deepEqual(calls, [{ id: "final-call", options: { includeExchange: true } }]);
  const dialog = dom.window.document.querySelector("dialog");
  assert.match(dialog.textContent, /HTTP request payload/);
  assert.match(dialog.textContent, /HTTP response/);
  assert.match(dialog.textContent, /Assembled assistant message/);
  assert.match(dialog.textContent, /Original selected record/);
  assert.match(dialog.textContent, /routing may be added downstream/);
  assert.ok(dialog.querySelectorAll(".json-tree").length >= 3);
  assert.equal(dialog.querySelectorAll("table").length, 0);
});
