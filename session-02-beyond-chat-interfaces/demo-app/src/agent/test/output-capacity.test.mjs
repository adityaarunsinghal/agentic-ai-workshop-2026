import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "../gateway.mjs";
import { offlineTrace } from "./helpers.mjs";

function response(payload) {
  return new Response(`data: ${JSON.stringify({
    id: "fixture-output-capacity", model: payload.model,
    choices: [{ index: 0, delta: { content: "Complete response." }, finish_reason: "stop" }],
    usage: { cost: 0.001 },
  })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("local generative requests default to 32,768 output tokens", async () => {
  const payloads = [];
  const gateway = createGateway({ trace: offlineTrace((_url, init) => {
    const payload = JSON.parse(init.body); payloads.push(payload); return response(payload);
  }), config: { mode: "local", apiKey: "offline-key", maxRequestCostUsd: 0.05 } });
  await gateway.completeText({ messages: [{ role: "user", content: "A small synthetic request." }] });
  assert.equal(gateway.requestedMaxTokens, 32768);
  assert.equal(payloads[0].max_tokens, 32768);
});

test("an older broker stays usable and a metadata refresh raises only future conversation ceilings", async (t) => {
  let time = 1000, advertised = 4096, reads = 0;
  t.mock.method(Date, "now", () => time);
  const payloads = [];
  const selections = [];
  const trace = offlineTrace((url, init) => {
    if (url.endsWith("/v1/bootstrap")) {
      reads++;
      return Response.json({
        inference: {
          selection: { modelId: "original-chat", profileId: "chat-profile" },
          profiles: [{ id: "chat-profile", modelId: "original-chat", maxOutputTokens: advertised }],
        },
        decisions: { version: "decisions-v1", models: [
          { id: "typesafe/jev-1.13", profileId: "native-profile", enabled: true, quoteFresh: true, contextTokens: 262144 },
        ] },
      });
    }
    const payload = JSON.parse(init.body); payloads.push(payload); return response(payload);
  });
  const gateway = createGateway({ trace, config: {
    mode: "development", brokerUrl: "http://127.0.0.1:9999", token: "offline-token", maxRequestCostUsd: 0.05,
    onSelection: (selection) => selections.push(selection),
  } });
  const initial = await gateway.ready();
  assert.equal(initial.requestedOutputTokens, 32768);
  assert.equal(initial.effectiveOutputTokens, 4096);
  const existing = gateway.createConversation();
  advertised = 32768; time += 31000;
  await gateway.ready();
  assert.equal(gateway.maxTokens, 32768);
  assert.deepEqual(selections.map((selection) => selection.effectiveOutputTokens), [4096, 32768]);
  assert.equal(existing.model.maxTokens, 4096);
  await existing.streamFn(existing.model, { messages: [{ role: "user", content: "Existing work." }], tools: [] }).result();
  await gateway.completeText({ messages: [{ role: "user", content: "New work." }] });
  assert.deepEqual(payloads.map((payload) => payload.max_tokens), [4096, 32768]);
  assert.equal(reads, 2);
  assert.equal(gateway.model, "original-chat");
  assert.equal(gateway.decisionLimits().maxRequestBytes, 262144 - 4096);
});

test("one-option native questions fail locally before a reservation or request", async () => {
  const trace = offlineTrace();
  const gateway = createGateway({ trace, config: { mode: "fixture" } });
  await assert.rejects(gateway.decide({ state: {}, questions: {
    layout: { type: "choice", instructions: "Keep the approved value.", criteria: { newspaper: "Already approved." } },
  } }), { code: "DECISIONS" });
  assert.equal(gateway.decisionsUsed, 0);
  assert.equal(gateway.budget.reservedUsd, 0);
  assert.equal(trace.requests.length, 0);
});
