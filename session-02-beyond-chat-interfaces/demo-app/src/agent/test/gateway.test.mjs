import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createGateway } from "../gateway.mjs";
import { fixtureDecisions, sseResponse } from "../fixture.mjs";
import { offlineTrace, deferred } from "./helpers.mjs";
import { SENTENCE_STYLE_CRITERIA } from "../../presentation.mjs";

const questions = {
  reaction: { type: "choice", instructions: "Choose an observed reaction.", criteria: { keep: "Keep.", pair: "Pair." } },
  check: { type: "noul", instructions: "Does this treatment need more verification?", criteria: { true: "Unsupported.", false: "Supported." } },
};

test("native availability recovers from a cached refusal without changing the chat selection", async () => {
  let reads = 0;
  const trace = offlineTrace((url, init) => Response.json(url.endsWith("/v1/bootstrap") ? {
    inference: { selection: { modelId: ++reads === 1 ? "original-chat" : "different-chat", profileId: "chat-profile" } },
    decisions: { version: "decisions-v1", url: "/v1/llm/decisions", models: [
      { id: "typesafe/jev-1.13", profileId: "native-profile", enabled: reads > 1, quoteFresh: reads > 1 },
    ] },
  } : { ...fixtureDecisions(JSON.parse(init.body)), usage: { cost: 0.001 } }));
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999", token: "offline-token", maxRequestCostUsd: 0.05,
  } });
  await gateway.ready();
  await gateway.decide({ state: {}, questions });
  assert.equal(reads, 2, "a free metadata refresh recovers before paid dispatch");
  assert.equal(gateway.model, "original-chat");
  assert.equal(gateway.profileId, "chat-profile");
  assert.equal(trace.requests.filter((entry) => entry.init.method === "POST").length, 1);
  assert.equal(trace.requests.at(-1).init.headers["x-workshop-expected-profile"], "native-profile");
});

test("parallel native availability refreshes share one read and retain the decision limit", async () => {
  const refreshing = deferred(), release = deferred();
  let reads = 0;
  const trace = offlineTrace(async (url, init) => {
    if (url.endsWith("/v1/bootstrap")) {
      reads++;
      if (reads > 1) { refreshing.resolve(); await release.promise; }
      return Response.json({
        inference: { selection: { modelId: "original-chat", profileId: "chat-profile" } },
        decisions: { version: "decisions-v1", url: "/v1/llm/decisions", models: [
          { id: "typesafe/jev-1.13", profileId: "native-profile", enabled: reads > 1, quoteFresh: reads > 1 },
        ] },
      });
    }
    return Response.json({ ...fixtureDecisions(JSON.parse(init.body)), usage: { cost: 0.001 } });
  });
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999", token: "offline-token",
    maxRequestCostUsd: 0.05, maxDecisionRequests: 1,
  } });
  await gateway.ready();
  const calls = Promise.allSettled([
    gateway.decide({ state: {}, questions }), gateway.decide({ state: {}, questions }),
  ]);
  await refreshing.promise;
  release.resolve();
  const results = await calls;
  assert.equal(reads, 2);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.find((entry) => entry.status === "rejected").reason.code, "DECISION_LIMIT");
  assert.equal(trace.requests.filter((entry) => entry.init.method === "POST").length, 1);
});

test("native availability still refused after refresh dispatches nothing and reserves nothing", async () => {
  const trace = offlineTrace(() => Response.json({
    inference: { selection: { modelId: "original-chat", profileId: "chat-profile" } },
    decisions: { version: "decisions-v1", models: [] },
  }));
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999", token: "offline-token",
  } });
  await gateway.ready();
  await assert.rejects(gateway.decide({ state: {}, questions }), { code: "DECISIONS_UNAVAILABLE" });
  assert.equal(trace.requests.length, 2);
  assert.equal(trace.requests.every((entry) => !entry.init.method || entry.init.method === "GET"), true);
  assert.equal(gateway.decisionsUsed, 0);
  assert.equal(gateway.budget.reservedUsd, 0);
});

test("native decisions bind the exact state, approved model, operation and profile", async () => {
  const trace = offlineTrace((url, init) => new Response(JSON.stringify(
    String(url).endsWith("/v1/bootstrap") ? {
      inference: { selection: { modelId: "deepseek/deepseek-v4.1-flash", profileId: "fixture-profile" } },
      decisions: { version: "decisions-v1", url: "/v1/llm/decisions", models: [
        { id: "typesafe/jev-1.13", profileId: "fixture-decisions", enabled: true, quoteFresh: true },
      ] },
    } : {
      ...fixtureDecisions(JSON.parse(init.body)),
      usage: { input_tokens: 123, output_tokens: 4, cost: 0.001 },
    },
  )));
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999",
    token: "offline-token", profileId: "fixture-profile",
  } });
  const state = { revision: 7, sources: ["known-source"], text: "Supplied evidence." };
  const result = await gateway.decide({ state, questions });
  assert.equal(trace.requests.length, 2);
  const request = trace.requests[1];
  assert.equal(request.url, "http://127.0.0.1:9999/v1/llm/decisions");
  assert.deepEqual(JSON.parse(request.init.body), { model: "typesafe/jev-1.13", state, questions });
  assert.equal(request.init.headers["x-workshop-operation-id"], result.operationId);
  assert.equal(request.init.headers["x-workshop-attempt-limit"], "1");
  assert.equal(request.init.headers["x-workshop-expected-profile"], "fixture-decisions");
  assert.equal(result.answers.check.noul, 0.5);
  assert.equal("confidence" in result.answers.check, false);
  assert.equal(result.usage.input_tokens, 123);
});

test("an unapproved model and a failed native call cannot trigger fallback or retries", async () => {
  const trace = offlineTrace(() => new Response("Synthetic unavailable", { status: 503 }));
  const gateway = createGateway({ trace, config: { mode: "local", apiKey: "offline-key" } });
  await assert.rejects(gateway.decide({ state: {}, questions, model: "unknown/model" }), { code: "MODEL_NOT_ALLOWED" });
  assert.equal(trace.requests.length, 0);
  await assert.rejects(gateway.decide({ state: {}, questions }), { code: "HTTP_503" });
  assert.equal(trace.requests.length, 1);
  assert.equal(trace.requests[0].url, "https://openrouter.ai/api/alpha/decisions");
});

test("development bootstrap retains its full decisions route without repeating the gateway prefix", async () => {
  const trace = offlineTrace((url, init) => new Response(JSON.stringify(
    String(url).endsWith("/v1/bootstrap") ? {
      inference: { selection: { modelId: "deepseek/deepseek-v4.1-flash", profileId: "fixture-profile" } },
      decisions: {
        version: "decisions-v1", url: "/api/development/v1/llm/decisions",
        models: [{ id: "typesafe/jev-1.13", profileId: "fixture-decisions", enabled: true, quoteFresh: true }],
      },
    } : fixtureDecisions(JSON.parse(init.body)),
  )));
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999/api/development",
    token: "offline-token",
  } });
  await gateway.decide({ state: {}, questions });
  assert.equal(trace.requests[0].url, "http://127.0.0.1:9999/api/development/v1/bootstrap");
  assert.equal(trace.requests[1].url, "http://127.0.0.1:9999/api/development/v1/llm/decisions");
});

test("workshop native routes need an advertised model, native profile, and supported version before reservation", async () => {
  const route = { id: "typesafe/jev-1.13", profileId: "fixture-decisions", enabled: true, quoteFresh: true };
  const capability = { version: "decisions-v1", url: "/v1/llm/decisions", models: [route] };
  const cases = [
    { name: "missing capability" },
    { name: "missing model", decisions: { ...capability, models: [] } },
    { name: "missing profile", decisions: { ...capability, models: [{ ...route, profileId: undefined }] } },
    { name: "empty profile", decisions: { ...capability, models: [{ ...route, profileId: " " }] } },
    { name: "chat profile", decisions: { ...capability, models: [{ ...route, profileId: "fixture-profile" }] } },
    { name: "unknown version", decisions: { ...capability, version: "decisions-v2" } },
    { name: "missing version", decisions: { ...capability, version: undefined } },
    { name: "explicit profile without advertisement", config: { decisionProfileId: "fixture-decisions" } },
    { name: "explicit model profile without advertisement", decisions: { ...capability, models: [] },
      config: { decisionProfiles: { [route.id]: route.profileId } } },
  ];
  for (const mode of ["development", "hosted"]) for (const example of cases) {
    const trace = offlineTrace((url, init) => {
      assert.ok(String(url).endsWith("/v1/bootstrap"), example.name);
      assert.equal(init.method ?? "GET", "GET");
      return new Response(JSON.stringify({
        inference: { selection: { modelId: "fixture-selected/general", profileId: "fixture-profile" } },
        decisions: example.decisions,
      }));
    });
    const gateway = createGateway({ trace, config: {
      mode, brokerUrl: "http://127.0.0.1:9999", token: "offline-token",
      profileId: "fixture-profile", ...example.config,
    } });
    const before = gateway.budget;
    assert.equal(trace.requests.length, 0);
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(gateway.decide({ state: {}, questions }), { code: "DECISIONS_UNAVAILABLE" }, example.name);
    assert.equal(trace.requests.length, 2, `${example.name}: the second attempt refreshes metadata once`);
    assert.equal(gateway.decisionsUsed, 0, example.name);
    assert.deepEqual(gateway.budget, before, example.name);
    assert.equal(trace.entries.some((entry) =>
      ["decision", "decision.request", "inference.reserved"].includes(entry.kind)), false, example.name);
  }
});

test("disabled or stale workshop native routes cannot consume a reservation or be enabled by configured profiles", async () => {
  for (const mode of ["development", "hosted"]) for (const flags of [
    { enabled: false, quoteFresh: true },
    { enabled: true, quoteFresh: false },
    { quoteFresh: true },
    { enabled: true },
  ]) {
    const trace = offlineTrace((url) => {
      assert.ok(String(url).endsWith("/v1/bootstrap"));
      return new Response(JSON.stringify({
        inference: { selection: { modelId: "fixture-selected/general", profileId: "fixture-profile" } },
        decisions: {
          version: "decisions-v1", url: "/v1/llm/decisions",
          models: [{ id: "typesafe/jev-1.13", profileId: "fixture-decisions", ...flags }],
        },
      }));
    });
    const gateway = createGateway({ trace, config: {
      mode, brokerUrl: "http://127.0.0.1:9999", token: "offline-token",
      decisionProfiles: { "typesafe/jev-1.13": "fixture-decisions" },
    } });
    const before = gateway.budget;
    await assert.rejects(gateway.decide({ state: {}, questions }), { code: "DECISIONS_UNAVAILABLE" });
    assert.equal(trace.requests.length, 1);
    assert.equal(gateway.decisionsUsed, 0);
    assert.deepEqual(gateway.budget, before);
    assert.equal(trace.entries.some((entry) =>
      ["decision", "decision.request", "inference.reserved"].includes(entry.kind)), false);
  }
});

test("explicit native profiles remain pins and never silently become the main pricing profile", async () => {
  for (const config of [
    { decisionProfileId: "fixture-decisions" },
    { decisionProfiles: { "typesafe/jev-1.13": "fixture-decisions" } },
    { decisionProfileId: "mismatched-profile" },
    { decisionProfiles: { "typesafe/jev-1.13": "mismatched-profile" } },
  ]) {
    const trace = offlineTrace((url, init) => new Response(JSON.stringify(
      String(url).endsWith("/v1/bootstrap") ? {
        inference: { selection: { modelId: "fixture-selected/general", profileId: "fixture-profile" } },
        decisions: {
          version: "decisions-v1", url: "/v1/llm/decisions",
          models: [{ id: "typesafe/jev-1.13", profileId: "fixture-decisions", enabled: true, quoteFresh: true }],
        },
      } : fixtureDecisions(JSON.parse(init.body)),
    )));
    const gateway = createGateway({ trace, config: {
      mode: "development", brokerUrl: "http://127.0.0.1:9999", token: "offline-token", ...config,
    } });
    const configuredProfile = config.decisionProfiles?.["typesafe/jev-1.13"] ?? config.decisionProfileId;
    if (configuredProfile === "mismatched-profile") {
      const before = gateway.budget;
      await assert.rejects(gateway.decide({ state: {}, questions }), { code: "MODEL_CHANGED" });
      assert.equal(trace.requests.length, 1);
      assert.equal(gateway.decisionsUsed, 0);
      assert.deepEqual(gateway.budget, before);
    } else {
      await gateway.decide({ state: {}, questions });
      assert.equal(trace.requests.length, 2);
      const sent = trace.requests[1].init.headers["x-workshop-expected-profile"];
      assert.equal(sent, configuredProfile);
      assert.notEqual(sent, gateway.profileId);
    }
  }
  const local = createGateway({ trace: offlineTrace(), config: {
    mode: "fixture", profileId: "fixture-chat", decisionProfileId: "fixture-native",
  } });
  const result = await local.decide({ state: {}, questions });
  assert.equal((await local.operation(result.operationId)).profileId, "fixture-native");
});

test("Choice cannot select an undeclared operation; Noul cannot invent confidence", async () => {
  for (const invalid of [
    { reaction: { type: "choice", choice: "invented" }, check: { type: "noul", noul: 0.2 } },
    { reaction: { type: "choice", choice: "keep" }, check: { type: "noul", noul: 0.2, confidence: 0.9 } },
  ]) {
    const trace = offlineTrace();
    const gateway = createGateway({ trace, config: {
      mode: "fixture", fixtureDecide: () => ({ answers: invalid }),
    } });
    await assert.rejects(gateway.decide({ state: {}, questions }), { code: "DECISIONS_RESPONSE" });
  }
});

test("native sentence Choices accept 128 questions and reject oversized or invalid question IDs before admission", async () => {
  let calls = 0;
  const gateway = createGateway({ trace: offlineTrace(), config: {
    mode: "fixture", maxTokens: 2048,
    fixtureDecide: (payload) => { calls++; return fixtureDecisions(payload); },
  } });
  const question = {
    type: "choice", instructions: "Choose the sentence presentation.",
    criteria: SENTENCE_STYLE_CRITERIA,
  };
  const batch = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`sentence_${index}`, question]));
  const result = await gateway.decide({ state: {}, questions: batch });
  assert.equal(Object.keys(result.answers).length, 128);
  assert.equal(gateway.maxTokens, 2048);
  assert.equal(calls, 1);
  const before = gateway.budget;
  for (const invalid of [
    { ...batch, overflow: question },
    { ["q".repeat(65)]: question },
    { "sentence.invalid": question },
    { "0sentence": question },
  ]) await assert.rejects(gateway.decide({ state: {}, questions: invalid }));
  assert.equal(calls, 1);
  assert.equal(gateway.decisionsUsed, 1);
  assert.deepEqual(gateway.budget, before);
});

test("Stage 2 uses one tool-free Pi call, returns optional JSON, and emits no synthetic Noul", async () => {
  const trace = offlineTrace();
  const gateway = createGateway({ trace, config: { mode: "fixture" } });
  const notifications = [];
  const result = await gateway.completeText({
    jsonOnly: true, notify: (event) => notifications.push(event),
    messages: [{ role: "user", content: JSON.stringify({ questions }) }],
  });
  assert.equal(result.simulated, true);
  assert.equal(result.json.answers.reaction.choice, "keep");
  assert.equal("check" in result.json.answers, false);
  const request = trace.entries.find((entry) => entry.kind === "model.request");
  assert.equal(request.payload.tool_choice, "none");
  assert.equal(request.payload.tools, undefined);
  assert.deepEqual(request.payload.response_format, { type: "json_object" });
  assert.equal(notifications.some((event) => event.type === "text_delta"), true);
  assert.equal(trace.entries.filter((entry) => entry.kind === "model.request").length, 1);
  assert.equal(trace.requests.length, 0);
});

test("Pi continuations retain the original ten-turn allowance, including the final tool-free dispatch", async () => {
  const payloads = [];
  const trace = offlineTrace();
  const gateway = createGateway({ trace, config: {
    mode: "fixture",
    fixtureChat: ({ payload, turn }) => {
      payloads.push(payload);
      return payload.tool_choice === "none" ?
        sseResponse({ content: "Simulated final response." }, "stop", payload.model) :
        sseResponse({ tool_calls: [{
          index: 0, id: `call-${turn}`, type: "function",
          function: { name: "lookup", arguments: "{}" },
        }] }, "tool_calls", payload.model);
    },
  } });
  const conversation = gateway.createConversation();
  const agent = new Agent({
    initialState: { model: conversation.model, tools: [{
      name: "lookup", label: "Fixture lookup", description: "Synthetic observation.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: "text", text: "Synthetic evidence." }], details: {} }),
    }] },
    streamFn: conversation.streamFn,
    finishTurn: () => ({ action: "end" }),
  });
  await agent.prompt("Continue the synthetic investigation.");
  for (let index = 1; index < 10; index++) await agent.continue();
  assert.equal(conversation.turns, 10);
  assert.equal(conversation.requests, 10);
  assert.equal(payloads.length, 10);
  assert.equal(payloads[9].tool_choice, "none");
  assert.equal(payloads[9].tools, undefined);
  const rejected = conversation.streamFn(conversation.model, normalizeContext({ messages: agent.state.messages }));
  assert.equal((await rejected.result()).stopReason, "error");
  assert.equal(payloads.length, 10);
});

test("an empty SDK response is surfaced once without an SDK retry", async () => {
  let dispatched = 0;
  const gateway = createGateway({ trace: offlineTrace(), config: {
    mode: "fixture", fixtureChat: ({ payload }) => {
      dispatched++;
      return sseResponse({ content: "" }, "stop", payload.model);
    },
  } });
  await assert.rejects(gateway.completeText({ messages: [{ role: "user", content: "Synthetic request." }] }), {
    code: "EMPTY_RESPONSE",
  });
  assert.equal(dispatched, 1);
});

test("native responses permit dated snapshots only within the requested approved family", async () => {
  for (const [model, snapshot] of [
    ["typesafe/jev-1.13", "typesafe/jev-1.13-20260917"],
    ["perplexity/pplx-decider-v1.1-27b", "perplexity/pplx-decider-v1.1-27b-20261006"],
  ]) {
    const gateway = createGateway({ trace: offlineTrace(), config: {
      mode: "fixture", fixtureDecide: (payload) => ({ ...fixtureDecisions(payload), model: snapshot }),
    } });
    const result = await gateway.decide({ model, state: {}, questions });
    assert.equal(result.model, snapshot);
    assert.equal(result.requestedModel, model);
  }
  const gateway = createGateway({ trace: offlineTrace(), config: {
    mode: "fixture", fixtureDecide: (payload) => ({ ...fixtureDecisions(payload), model: "typesafe/jev-1.14-20260917" }),
  } });
  await assert.rejects(gateway.decide({ state: {}, questions }), { code: "MODEL_CHANGED" });
});

test("a development token and gateway resolve the main model/profile lazily through bootstrap", async () => {
  const trace = offlineTrace((_url, init) => init.body ?
    sseResponse({ content: "Simulated bootstrap-bound response." }, "stop", JSON.parse(init.body).model) :
    new Response(JSON.stringify({ inference: {
      selection: { modelId: "fixture-selected/main-model", profileId: "bootstrap-profile" },
      fundingMode: "personal",
    } })));
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999", token: "offline-token",
  } });
  assert.equal(trace.requests.length, 0);
  const result = await gateway.completeText({ messages: [{ role: "user", content: "Synthetic request." }] });
  assert.equal(result.model, "fixture-selected/main-model");
  assert.equal(trace.requests[0].url, "http://127.0.0.1:9999/v1/bootstrap");
  assert.equal(trace.requests[1].init.headers.get("x-workshop-expected-profile"), "bootstrap-profile");
  await gateway.ready();
  assert.equal(trace.requests.length, 3);
  assert.ok(trace.requests[2].url.endsWith(`/v1/llm/operations/${result.operationId}`));
  assert.equal(trace.requests[2].init.body, undefined, "an unpriced response triggers only a status read");
  assert.equal(trace.requests.filter((request) => request.url.endsWith("/v1/bootstrap")).length, 1);
});

test("unknown failed charges retain the shared ceiling and block another paid dispatch", async () => {
  const trace = offlineTrace(() => new Response("Synthetic failure", { status: 503 }));
  const gateway = createGateway({ trace, config: { mode: "local", apiKey: "offline-key" } });
  await assert.rejects(gateway.decide({ state: {}, questions }), { code: "HTTP_503" });
  assert.equal(gateway.budget.knownCostUsd, 0);
  assert.equal(gateway.budget.reservedUsd, 1);
  assert.equal(gateway.budget.unsettledOperations.length, 1);
  await assert.rejects(gateway.completeText({ messages: [{ role: "user", content: "Synthetic request." }] }), { code: "COST_LIMIT" });
  assert.equal(trace.requests.length, 1);
  const denied = trace.entries.filter((entry) => entry.kind === "model").at(-1);
  assert.equal(denied.dispatched, false);
  assert.equal(denied.errorCode, "COST_LIMIT");
  assert.match(denied.error, /No model request was sent/);
});

test("restart recovery settles only matching completed charges and never dispatches inference", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "session2-charge-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerFile = join(directory, "ledger.json");
  const pending = ["settled", "uncertain", "wrong-model", "wrong-profile", "wrong-id"];
  await writeFile(ledgerFile, JSON.stringify({
    schemaVersion: "session2.inference.v1", issueId: "recovery-issue",
    operations: pending.map((operationId) => ({
      operationId, model: "typesafe/jev-1.13", kind: "decision",
      profileId: "original-native-profile",
      reservationUsd: 0.05, boundKnown: true, settled: false, costUsd: null,
    })),
  }));
  const trace = offlineTrace((url, init) => {
    assert.equal(init.body, undefined, "recovery only performs reads");
    if (url.endsWith("/v1/bootstrap")) return Response.json({
      inference: { selection: { modelId: "fixture-chat", profileId: "current-chat-profile" } },
    });
    const id = url.split("/").at(-1);
    assert.equal(init.headers["x-workshop-expected-profile"], "original-native-profile");
    return Response.json({ operation: {
      operationId: id === "wrong-id" ? "another-operation" : id, phase: "failed",
      modelId: id === "wrong-model" ? "another-model" : "typesafe/jev-1.13-20260917",
      profileId: id === "wrong-profile" ? "another-profile" : "original-native-profile",
      usage: { unsettledRequests: id === "uncertain" ? 1 : 0, knownCostUsd: "0.001242276" },
    } });
  });
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999", token: "offline-token",
    issueId: "recovery-issue", inferenceLedgerFile: ledgerFile,
    maxInferenceCostUsd: 0.5, maxRequestCostUsd: 0.05,
  } });
  await gateway.ready();
  assert.equal(gateway.budget.knownCostUsd, 0.001242276);
  assert.equal(gateway.budget.reservedUsd, 0.2);
  assert.equal(gateway.budget.unsettledOperations.length, 4);
  const saved = JSON.parse(await readFile(ledgerFile, "utf8"));
  assert.equal(saved.operations.find((entry) => entry.operationId === "settled").settled, true);
  assert.equal(saved.operations.find((entry) => entry.operationId === "uncertain").settled, false);
  await gateway.ready();
  assert.equal(trace.requests.length, 6, "repeated ready calls do not poll each charge again immediately");
});

test("low allowance uses the reserved final response before the ten-turn limit", async () => {
  const payloads = [];
  const trace = offlineTrace((_url, init) => {
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    return new Response(`data: ${JSON.stringify({
      id: "synthetic-budget-response", model: payload.model,
      choices: [{ index: 0, delta: { content: "Supported synthetic answer." }, finish_reason: "stop" }],
      usage: { cost: 0.01 },
    })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  const gateway = createGateway({ trace, config: {
    mode: "local", apiKey: "offline-key", maxInferenceCostUsd: 0.10, maxRequestCostUsd: 0.05,
  } });
  const conversation = gateway.createConversation();
  const context = normalizeContext({
    messages: [{ role: "user", content: "Synthetic bounded research." }],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }],
  });
  assert.equal(conversation.finalTurnNeeded, false);
  await conversation.streamFn(conversation.model, context).result();
  assert.equal(conversation.finalTurnNeeded, true);
  assert.equal(conversation.finalTurnReason, "remaining_allowance");
  const final = await conversation.streamFn(conversation.model, context).result();
  assert.equal(final.stopReason, "stop");
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].tool_choice, "none");
  assert.equal(payloads[1].tools, undefined);
  assert.equal(conversation.finalSent, true);
  assert.equal(gateway.budget.finalAnswerReservedUsd, 0);
  assert.equal(gateway.budget.knownCostUsd, 0.02);
  await conversation.streamFn(conversation.model, context).result();
  assert.equal(payloads.length, 2, "the final allowance cannot be spent twice");
  conversation.close();
});

test("independent chat and Decisions calls enter together while one conversation cannot overlap itself", { timeout: 2000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  t.after(() => release.resolve());
  const trace = offlineTrace(async (url, init) => {
    if (++calls === 4) entered.resolve();
    await release.promise;
    const payload = JSON.parse(init.body);
    return url.endsWith("/decisions") ? new Response(JSON.stringify(fixtureDecisions(payload))) :
      sseResponse({ content: "Independent result" }, "stop", payload.model);
  });
  const gateway = createGateway({ trace, config: { mode: "local", apiKey: "offline-key", maxRequestCostUsd: 0.05 } });
  const conversation = gateway.createConversation({ requestKind: "editorial" });
  const context = normalizeContext({ messages: [{ role: "user", content: "Context" }] });
  const first = conversation.streamFn(conversation.model, context);
  const overlap = await conversation.streamFn(conversation.model, context).result();
  assert.equal(overlap.errorCode, "CONVERSATION_BUSY");
  assert.equal(conversation.turns, 1);
  const others = [gateway.completeText({ messages: [{ role: "user", content: "Other" }] }),
    gateway.decide({ state: {}, questions }), gateway.decide({ state: {}, questions })];
  await entered.promise;
  assert.equal(gateway.activity.active, 4);
  assert.equal(gateway.activity.queued, 0);
  release.resolve();
  await Promise.all([first.result(), ...others]);
  assert.equal(gateway.activity.active, 0);
  assert.equal(calls, 4);
});

test("parallel requests retain the shared cost and request-count ceilings", async () => {
  for (const caps of [
    { maxRequestCostUsd: 0.05, maxInferenceCostUsd: 0.10, code: "COST_LIMIT" },
    { maxRequestCostUsd: 0.05, maxDecisionRequests: 2, code: "DECISION_LIMIT" },
  ]) {
    const trace = offlineTrace((_url, init) =>
      sseResponse({ content: "Unpriced result" }, "stop", JSON.parse(init.body).model));
    const gateway = createGateway({ trace, config: { mode: "local", apiKey: "offline-key", ...caps } });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
      gateway.completeText({ messages: [{ role: "user", content: "Independent bounded work" }] })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
    assert.equal(trace.requests.length, 2);
    assert.ok(results.filter(result => result.status === "rejected").every(result => result.reason.code === caps.code));
    assert.equal(gateway.budget.reservedUsd, 0.10);
  }
});

test("main and native inference share the same verified USD ceiling", async () => {
  const trace = offlineTrace((url, init) => {
    const payload = JSON.parse(init.body);
    if (String(url).endsWith("/decisions"))
      return new Response(JSON.stringify({ ...fixtureDecisions(payload), usage: { cost: 0.01 } }));
    return new Response(`data: ${JSON.stringify({
      id: "fixture-cost-response", model: payload.model,
      choices: [{ index: 0, delta: { content: "Synthetic response." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
    })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  const gateway = createGateway({ trace, config: {
    mode: "local", apiKey: "offline-key", maxInferenceCostUsd: 0.025, maxRequestCostUsd: 0.01,
  } });
  await gateway.decide({ state: {}, questions });
  await gateway.completeText({ messages: [{ role: "user", content: "Synthetic request." }] });
  assert.equal(gateway.budget.knownCostUsd, 0.02);
  await assert.rejects(gateway.decide({ state: {}, questions }), { code: "COST_LIMIT" });
  assert.equal(trace.requests.length, 2);
});

test("failed editorial responses retain correlation, model identity, and provider-reported usage", async () => {
  for (const backend of ["chat", "decisions"]) {
    const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cost: 0.0042 };
    const nativeModel = "typesafe/jev-1.13-20260917";
    const trace = offlineTrace((_url, init) => {
      const payload = JSON.parse(init.body);
      if (backend === "decisions") {
        const result = fixtureDecisions(payload);
        result.answers.check.noul = 2;
        return new Response(JSON.stringify({ ...result, model: nativeModel, usage }));
      }
      return new Response(`data: ${JSON.stringify({
        id: "synthetic-invalid-json", model: payload.model, usage,
        choices: [{ index: 0, delta: { content: "Not JSON." }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const gateway = createGateway({ trace, config: {
      mode: "local", apiKey: "offline-key",
      modelMetadata: { cost: { input: 9000, output: 9000, cacheRead: 0, cacheWrite: 0 } },
    } });
    const correlation = { parentId: "editorial-receipt", requestId: "editorial-receipt" };
    let failure;
    await assert.rejects(backend === "chat"
      ? gateway.completeText({
        ...correlation, jsonOnly: true, messages: [{ role: "user", content: "Synthetic editorial request." }],
      })
      : gateway.decide({ ...correlation, state: {}, questions }),
    (error) => {
      failure = error;
      assert.equal(error.code, backend === "chat" ? "JSON_RESPONSE" : "DECISIONS_RESPONSE");
      assert.equal(error.model, backend === "chat" ? gateway.model : nativeModel);
      assert.deepEqual(error.usage, usage);
      assert.equal(typeof error.operationId, "string");
      return true;
    });
    const operation = await gateway.operation(failure.operationId);
    assert.equal(operation.parentId, correlation.parentId);
    assert.equal(operation.requestId, correlation.requestId);
    assert.deepEqual(operation.usage, usage);
    assert.equal(gateway.budget.knownCostUsd, usage.cost);
    assert.equal(trace.requests.length, 1);
  }
});
