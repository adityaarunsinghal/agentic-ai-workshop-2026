import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWorkshop } from "../agent/workshop.mjs";
import { createLocalWorkshop } from "../local/workshop.mjs";
import { createApplication, createBudget } from "../agent/app.mjs";
import { userMessage } from "../agent/pi-mini.mjs";
import { emptyUserPreferences } from "../support/user-preferences.mjs";
import { textFrame } from "../local/fixture.mjs";

const env = {
  WORKSHOP_DEVELOPMENT_URL: "https://workshop.example/api/development",
  WORKSHOP_DEVELOPMENT_TOKEN: "synthetic-development-token",
  OPENROUTER_API_KEY: "unused-personal-key",
  OPENROUTER_MODEL: "unused/personal-model",
};
const modelId = "openai/gpt-6-luna";
const profileId = "luna-auto";
const bootstrap = (patch = {}) => ({
  contractVersion: "workshop.app.v1",
  mode: "development",
  runId: "development-grant-1",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  inference: { selection: { modelId, profileId }, fundingMode: "class" },
  services: {},
  storage: { schema: "chat.v1", visitorBytes: 0 },
  ...patch,
});
const headers = {
  "x-workshop-inference-binding": "profile-v1",
  "x-workshop-recovery": "recovery-v1",
};
async function result(stream) {
  for await (const _event of stream) { /* Drain the real stream assembler. */ }
  return stream.result();
}
function operation(id, maxAttempts) {
  return {
    version: "workshop.inference-operation.v1",
    operationId: id,
    phase: "completed",
    modelId,
    profileId,
    maxAttempts,
    attemptsUsed: 1,
    attempts: [{
      index: 1,
      operationId: `${id}-attempt`,
      state: "settled",
      dispatched: true,
      provider: "synthetic",
      actualCostUsd: "0.001",
      reservedUsd: "0",
    }],
    nextRetryAt: null,
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    responseAvailable: true,
    usage: { knownCostUsd: "0.001", reservedUsd: "0", unsettledRequests: 0 },
    failure: null,
  };
}

test("development uses prefixed broker requests, selected profiles, full replay and recovery accounting", async (t) => {
  const requests = [], operations = new Map();
  const workshop = createLocalWorkshop({
    mode: "development", env, storeFile: ":memory:",
    fetcher: async (url, init) => {
      const path = new URL(url).pathname;
      assert.equal(new URL(url).origin, "https://workshop.example");
      assert.ok(path.startsWith("/api/development/v1/"));
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, `Bearer ${env.WORKSHOP_DEVELOPMENT_TOKEN}`);
      requests.push({ path, ...init });
      if (path.endsWith("/bootstrap")) return Response.json(bootstrap(), { headers });
      if (path.includes("/operations/"))
        return Response.json({ operation: operations.get(path.split("/").at(-1)) });
      assert.equal(path, "/api/development/v1/llm/chat/completions");
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, modelId);
      assert.equal(init.headers["x-workshop-expected-profile"], profileId);
      assert.equal(init.headers["x-workshop-contract-version"], "workshop.app.v1");
      const id = init.headers["x-workshop-operation-id"];
      operations.set(id, operation(id, Number(init.headers["x-workshop-attempt-limit"])));
      return new Response(
        `data: ${JSON.stringify({ choices: [{
          index: 0, delta: { content: "A bounded reply.", reasoning_content: "opaque replay" },
          finish_reason: "stop",
        }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  t.after(() => workshop.close());
  const boot = await workshop.bootstrap();
  assert.equal(boot.mode, "development");
  assert.equal(boot.runId, "development-grant-1");
  assert.equal(workshop.runtimeMode, "development");
  assert.equal(workshop.recoverySupported, true);
  assert.equal(requests.length, 1);
  const visit = { used: 0 }, budget = createBudget(visit, false);
  const initial = { messages: [{ role: "system", content: "Use supplied context." }, userMessage("Hello.")] };
  const signal = new AbortController().signal;
  const stream = workshop.stream({ budget, role: "producer" });
  const first = await result(stream({ id: modelId }, initial, { signal }));
  assert.equal(visit.used, 1);
  assert.equal(first.providerReplay.reasoning_content, "opaque replay");
  await result(stream({ id: modelId }, {
    messages: [...initial.messages, first, userMessage("Continue.")],
  }, { signal }));
  assert.equal(visit.used, 2);
  const posts = requests.filter((request) => request.method === "POST");
  assert.deepEqual(
    JSON.parse(posts[1].body).messages.find((message) => message.role === "assistant"),
    first.providerReplay,
  );
  const originalId = posts[0].headers["x-workshop-operation-id"];
  const resumed = workshop.stream({ budget, role: "producer", resumeOperationId: originalId });
  await result(resumed({ id: modelId }, initial, { signal }));
  const replayed = requests.filter((request) => request.method === "POST").at(-1);
  assert.equal(replayed.headers["x-workshop-operation-id"], originalId);
  assert.equal(replayed.body, posts[0].body);
  assert.equal(visit.used, 2, "A cached replay must not reserve another attempt.");
  assert.equal((await workshop.operation(originalId)).attemptsUsed, 1);
  assert.ok(!JSON.stringify(requests).includes(env.OPENROUTER_API_KEY));
});

test("a development token for another data schema keeps HN preferences local", async (t) => {
  const paths = [];
  const workshop = createLocalWorkshop({
    mode: "development", env, storeFile: ":memory:",
    fetcher: async (url) => {
      paths.push(new URL(url).pathname);
      assert.ok(paths.at(-1).endsWith("/bootstrap"));
      return Response.json(bootstrap({
        storage: { schema: "another-app.v1", visitorBytes: 1024 * 1024 },
      }), { headers });
    },
  });
  t.after(() => workshop.close());
  await workshop.bootstrap();
  assert.equal(await workshop.loadUserPreferences(), null);
  const value = emptyUserPreferences();
  const saved = await workshop.saveUserPreferences(value, null);
  assert.deepEqual(saved.value, value);
  assert.equal(paths.length, 1);
});

test("development without source or storage scope uses real local MCP and a separate preference store", async (t) => {
  const paths = [], observations = [];
  const workshop = createLocalWorkshop({
    mode: "development",
    env: { ...env, WORKSHOP_DEVELOPMENT_URL: `${env.WORKSHOP_DEVELOPMENT_URL}/` },
    storeFile: ":memory:",
    fetcher: async (url, init) => {
      paths.push(String(url));
      if (new URL(url).pathname === "/api/development/v1/bootstrap")
        return Response.json(bootstrap(), {
          headers: { "x-workshop-inference-binding": "profile-v1" },
        });
      if (new URL(url).pathname === "/api/development/v1/llm/chat/completions") {
        assert.equal(JSON.parse(init.body).model, modelId);
        assert.equal(init.headers.authorization, `Bearer ${env.WORKSHOP_DEVELOPMENT_TOKEN}`);
        return new Response(textFrame("A bounded development reply."), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (String(url).endsWith("/v0/topstories.json")) return Response.json([123]);
      if (String(url).endsWith("/v0/item/123.json"))
        return Response.json({ id: 123, type: "story", title: "Observed source", time: 1700000000 });
      assert.fail(`Unexpected route: ${url}`);
    },
  });
  const app = createApplication({ workshop });
  t.after(() => app.close());
  await app.initialize();
  assert.equal(app.view.state.runtimeMode, "development");
  assert.equal(app.view.state.fundingMode, "class");
  assert.deepEqual(app.view.state.model, { id: modelId, profileId });
  assert.equal(app.view.state.phase, "idle");
  assert.equal(paths.length, 1, "Initialization must not make an inference request.");
  assert.ok(paths[0].endsWith("/api/development/v1/bootstrap"));
  const source = await workshop.listStories(
    { category: "top", count: 1 }, undefined,
    { notify: (entry) => observations.push(entry) },
  );
  assert.equal(source.structuredContent.records[0].upstreamId, "123");
  assert.ok(observations.every((entry) => entry.transport === "in-memory"));
  const value = emptyUserPreferences();
  value.preferences.topic = "Retained locally";
  const saved = await workshop.saveUserPreferences(value, null);
  assert.deepEqual((await workshop.loadUserPreferences()).value, value);
  await assert.rejects(async () => workshop.saveUserPreferences(value, null), /changed after/);
  assert.equal((await workshop.loadUserPreferences()).etag, saved.etag);
  assert.equal(paths.length, 3);
  assert.equal(app.view.state.requestsUsed, 0);
  await app.action({
    id: randomUUID(), type: "run",
    data: {
      sessionId: app.view.state.sessionId, text: "Recap one source.",
      options: { control: "fixed", count: 1 },
    },
  });
  await app.idle;
  assert.equal(app.view.state.lastOutcome.status, "completed");
  assert.equal(app.view.state.requestsUsed, 1);
  assert.equal(app.view.state.sources[0].upstreamId, "123");
});

test("development refuses hosted bootstrap, invalid contracts and identity changes", async (t) => {
  let next = bootstrap();
  const workshop = createWorkshop({
    mode: "development", env,
    fetcher: async () => Response.json(next, { headers }),
  });
  t.after(() => workshop.close());
  for (const patch of [
    { mode: "hosted" }, { mode: "readiness" }, { runId: "" },
    { contractVersion: "other" }, { simulated: true },
    { inference: { selection: { modelId }, fundingMode: "class" } },
  ]) {
    next = bootstrap(patch);
    await assert.rejects(workshop.bootstrap());
    assert.equal(workshop.current, undefined);
  }
  next = bootstrap();
  await workshop.bootstrap();
  next = bootstrap({ runId: "another-development-grant" });
  await assert.rejects(workshop.bootstrap(), { code: "CONTRACT" });
  assert.equal(workshop.current.runId, "development-grant-1");
});

test("development has no personal-key or hosted-configuration fallback", async () => {
  for (const configuration of [
    {}, { OPENROUTER_API_KEY: "personal-only" },
    { ...env, WORKSHOP_DEVELOPMENT_TOKEN: "" },
    { ...env, WORKSHOP_DEVELOPMENT_URL: "https://workshop.example" },
    ...["WORKSHOP_RUN_TOKEN", "WORKSHOP_RUN_ID", "WORKSHOP_BROKER_URL"].map(
      (name) => ({ ...env, [name]: "hosted-configuration" }),
    ),
    { ...env, WORKSHOP_RUNTIME: "hosted" },
  ])
    assert.throws(() => createLocalWorkshop({
      mode: "development", env: configuration, storeFile: ":memory:",
    }));
  const hosted = createWorkshop({
    env, fetcher: () => { assert.fail("Hosted startup must not adopt a development token."); },
  });
  await assert.rejects(hosted.bootstrap(), { code: "SETUP" });
  await hosted.close();
});

test("advertised development services retain their scope and do not fall back after an error", async (t) => {
  const paths = [];
  const workshop = createLocalWorkshop({
    mode: "development", env, storeFile: ":memory:",
    fetcher: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/bootstrap"))
        return Response.json(bootstrap({
          services: { hn: { url: "/api/development/mcp/hn" } },
          storage: { schema: "chat.v1", visitorBytes: 1024 },
        }), { headers });
      return Response.json({ error: { code: "UNAVAILABLE", message: "Synthetic unavailable." } }, { status: 503 });
    },
  });
  t.after(() => workshop.close());
  await workshop.bootstrap();
  await assert.rejects(workshop.discover());
  await assert.rejects(workshop.loadUserPreferences());
  assert.ok(paths.includes("/api/development/mcp/hn"));
  assert.ok(paths.includes("/api/development/v1/storage/objects/hn-memory"));
  assert.ok(paths.every((path) => path.startsWith("/api/development/")));
});

test("legacy development bootstrap changes are rejected before reserving or dispatching inference", async (t) => {
  let reads = 0;
  const workshop = createWorkshop({
    mode: "development", env,
    fetcher: async (url, init) => {
      assert.equal(new URL(url).pathname, "/api/development/v1/bootstrap");
      assert.equal(init.method, "GET");
      return Response.json(bootstrap(++reads === 1 ? {} : {
        inference: { selection: { modelId, profileId: "another-profile" }, fundingMode: "personal" },
      }));
    },
  });
  t.after(() => workshop.close());
  await workshop.bootstrap();
  const visit = { used: 0 };
  const stream = workshop.stream({ budget: createBudget(visit, false), role: "producer" });
  await assert.rejects(result(stream(
    { id: modelId }, { messages: [userMessage("Hello.")] },
    { signal: new AbortController().signal },
  )), { code: "MODEL_CHANGED" });
  assert.equal(visit.used, 0);
  assert.equal(reads, 2);
});
