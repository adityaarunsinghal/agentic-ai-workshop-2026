import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "../gateway.mjs";
import { offlineTrace } from "./helpers.mjs";

function setup(text, finishReason) {
  const trace = offlineTrace((_url, init) => {
    const payload = JSON.parse(init.body);
    return new Response(`data: ${JSON.stringify({
      id: "fixture-json-recovery", model: payload.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }],
      usage: { prompt_tokens: 100, completion_tokens: 4096, cost: 0.001 },
    })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  return { trace, gateway: createGateway({ trace, config: {
    mode: "local", apiKey: "offline-key", maxRequestCostUsd: 0.05,
  } }) };
}

test("a complete repeated JSON candidate is recovered without another paid request or changed raw text", async () => {
  const candidate = JSON.stringify({ headline: "Synthetic headline", body: "Supported synthetic copy.", sourceIds: ["source-1"] });
  const text = `${candidate}\n(Only JSON!)\n${candidate}\n(JSON ONLY.)\n${candidate.slice(0, 25)}`;
  const { trace, gateway } = setup(text, "length");
  const result = await gateway.completeText({
    jsonOnly: true, jobId: "run-1", requestId: "step-2", parentId: "experiment",
    messages: [{ role: "user", content: "Revise the supplied copy." }],
  });
  assert.deepEqual(result.json, JSON.parse(candidate));
  assert.equal(result.text, text);
  assert.equal(result.outputLimitReached, true);
  assert.equal(result.stopReason, "length");
  assert.equal(result.jsonRecovery.kind, "identical_json_repetitions");
  assert.equal(trace.requests.length, 1);
  const recovery = trace.entries.find((entry) => entry.kind === "model.json_recovery");
  assert.equal(recovery.operationId, result.operationId);
  assert.equal(recovery.jobId, "run-1");
  assert.equal(recovery.status, "recovered");
  assert.equal(trace.entries.find((entry) => entry.kind === "model.response").message.content[0].text, text);
  assert.equal(gateway.budget.knownCostUsd, 0.001);
});

test("an incomplete output limit preserves the response for caller-owned repair and is not a context error", async () => {
  const text = '{"headline":"Partial","body":"unfinished';
  const { trace, gateway } = setup(text, "length");
  await assert.rejects(gateway.completeText({
    jsonOnly: true, messages: [{ role: "user", content: "Return a candidate." }],
  }), (error) => {
    assert.equal(error.code, "OUTPUT_LIMIT");
    assert.equal(error.text, text);
    assert.equal(error.stopReason, "length");
    assert.equal(error.usage.cost, 0.001);
    assert.equal(typeof error.operationId, "string");
    return true;
  });
  assert.equal(trace.requests.length, 1);
  assert.equal(trace.entries.some((entry) => entry.kind === "model.json_recovery"), false);
});
