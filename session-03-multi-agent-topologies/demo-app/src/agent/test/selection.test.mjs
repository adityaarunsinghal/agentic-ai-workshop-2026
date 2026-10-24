import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { configuration } from "../../config.mjs";
import { createApplication } from "../../server.mjs";
import { createIssueStore } from "../../domain/store.mjs";
import { createGateway } from "../gateway.mjs";
import { createResearchAgent } from "../runtime.mjs";
import { deferred, offlineTrace } from "./helpers.mjs";

const model = "z-ai/glm-5.3-flash", profileId = "synthetic-glm-profile";
const bootstrap = { inference: { selection: { modelId: model, profileId }, fundingMode: "personal" } };

test("workshop configuration has no provisional model; standalone defaults and overrides remain available", () => {
  assert.equal(configuration({}).model, "openai/gpt-6-luna");
  assert.equal(configuration({ OPENROUTER_API_KEY: "synthetic", OPENROUTER_MODEL: "synthetic/local" }).model, "synthetic/local");
  for (const mode of ["hosted", "development"])
    assert.equal(configuration({ SESSION2_MODE: mode, OPENROUTER_MODEL: "synthetic/stale-default" }).model, null);
});

test("unresolved workshop selection blocks jobs and conversation reservations, then overrides stale settings before enqueue", async () => {
  for (const mode of ["hosted", "development"]) {
    const trace = offlineTrace(() => new Response(JSON.stringify(bootstrap)));
    const store = await createIssueStore({ trace, config: { mode: "development" } });
    const gateway = createGateway({ trace, config: {
      mode, model: "openai/gpt-6-luna", token: "synthetic-token", brokerUrl: "http://127.0.0.1:1",
      onSelection: (selection) => store.applyInferenceSelection(selection),
    } });
    const runtime = createResearchAgent({ store, trace, gateway, mcp: { listTools: async () => [], callTool: async () => {} } });
    try {
      const slot = store.reserveStory({ prompt: "Synthetic commission" });
      assert.equal(gateway.model, null);
      assert.throws(() => runtime.requestStory({ slotId: slot.slotId, prompt: "Synthetic commission" }), { code: "SELECTION_PENDING" });
      assert.throws(() => runtime.requestBriefing({ prompt: "Synthetic briefing" }), { code: "SELECTION_PENDING" });
      const budget = gateway.budget;
      assert.throws(() => gateway.createConversation(), { code: "SELECTION_PENDING" });
      assert.deepEqual(gateway.budget, budget);
      assert.equal(store.snapshot().jobs.length, 0);
      assert.equal(trace.requests.length, 0);
      await gateway.ready();
      assert.equal(store.snapshot().settings.model, model);
      assert.equal(store.snapshot().inferenceSelection.model, model);
      assert.throws(() => gateway.createConversation({ model: "openai/gpt-6-luna" }), { code: "MODEL_CHANGED" });
      // Even a stale caller snapshot cannot override the workshop selection.
      store.update((_issue, state) => { state.settings.model = "openai/gpt-6-luna"; }, { history: false });
      const job = runtime.requestStory({ slotId: slot.slotId, prompt: "Synthetic commission" });
      assert.equal(job.model, model);
      assert.equal(job.profileId, profileId);
      runtime.cancelStory(job.id);
      assert.equal(trace.requests.length, 1, "only the synthetic bootstrap read ran");
    } finally { await runtime.close(); }
  }
});

test("a stalled bootstrap leaves state and reads available while model actions wait for selection", async () => {
  const entered = deferred(), release = deferred(), payloads = [], paths = [];
  const broker = createServer(async (request, response) => {
    paths.push(request.url);
    if (request.method === "GET" && request.url === "/v1/bootstrap") {
      entered.resolve();
      await release.promise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(bootstrap));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/llm/chat/completions") {
      let body = "";
      for await (const part of request) body += part;
      const payload = JSON.parse(body);
      payloads.push(payload);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({
        id: "synthetic-response", model: payload.model,
        choices: [{ index: 0, delta: { content: "No source was read for this synthetic request." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 },
      })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(400).end("Unexpected synthetic request.");
  });
  await new Promise((done) => broker.listen(0, "127.0.0.1", done));
  let app, requested;
  const starting = createApplication({
    mode: "development", model: "openai/gpt-6-luna", token: "synthetic-token", maxTurns: 1,
    maxInferenceCostUsd: 1, maxRequestCostUsd: 0.05,
    brokerUrl: `http://127.0.0.1:${broker.address().port}`, modelTimeoutMs: 5000,
  }).then((value) => { app = value; return value; });
  try {
    await starting;
    await entered.promise;
    const initial = await (await app.app.request("/api/state")).json();
    assert.equal(initial.settings.model, null);
    assert.equal(initial.inferenceSelection?.model ?? null, null);
    assert.equal(initial.issue.revision, 0);
    assert.equal(await (await app.app.request("/healthz")).text(), "ok");
    assert.equal((await app.app.request("/api/mcp/tools")).status, 200);
    let actionSettled = false;
    requested = app.app.request("/api/mcp/tools/request_briefing", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { prompt: "Synthetic briefing" } }),
    }).then((response) => { actionSettled = true; return response.json(); });
    await new Promise((done) => setImmediate(done));
    assert.equal(actionSettled, false);
    assert.equal(app.store.snapshot().jobs.length, 0);
    assert.equal(payloads.length, 0);
    release.resolve();
    assert.notEqual((await requested).isError, true);
    const selected = await (await app.app.request("/api/state")).json();
    assert.equal(selected.settings.model, model);
    assert.equal(selected.inferenceSelection.model, model);
    assert.equal(selected.jobs[0].model, model);
    const slot = app.store.reserveStory({ prompt: "Synthetic commission" });
    const story = app.agent.requestStory({ slotId: slot.slotId, prompt: "Synthetic commission" });
    assert.equal(story.model, model);
    await app.agent.waitForIdle();
    assert.equal(payloads.length, 2, JSON.stringify(app.store.snapshot().jobs.map(({ status, error }) => ({ status, error }))));
    assert.ok(payloads.every((payload) => payload.model === model));
    assert.ok(payloads.some((payload) => JSON.stringify(payload.messages).includes("Story request:")));
    assert.ok(payloads.some((payload) => JSON.stringify(payload.messages).includes("Briefing request:")));
    assert.equal(JSON.stringify(app.store.snapshot()).includes('"requestedModel":"openai/gpt-6-luna"'), false);
    assert.deepEqual(paths, ["/v1/bootstrap", "/v1/llm/chat/completions", "/v1/llm/chat/completions"]);
  } finally {
    release.resolve();
    await starting.catch(() => {});
    await requested?.catch(() => {});
    await app?.close();
    await new Promise((done) => broker.close(done));
  }
});

test("bootstrap times out independently of chat and permits a later free selection read", async () => {
  let attempts = 0;
  const trace = offlineTrace((_url, { signal }) => {
    if (++attempts > 1) return new Response(JSON.stringify(bootstrap));
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const gateway = createGateway({ trace, config: {
    mode: "development", token: "synthetic-token", brokerUrl: "http://127.0.0.1:1",
    modelTimeoutMs: 360_000, bootstrapTimeoutMs: 20,
  } });
  // AbortSignal's deadline is unreferenced; keep this isolated fake transport alive.
  const timer = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(gateway.ready(), { name: "TimeoutError" });
    assert.equal(gateway.model, null);
    assert.equal(gateway.budget.reservedUsd, 0);
    assert.equal((await gateway.ready()).model, model);
    assert.equal(trace.requests.length, 2);
    assert.ok(trace.requests.every(({ url, init }) => url.endsWith("/v1/bootstrap") && !init.body));
  } finally { clearTimeout(timer); }
});
