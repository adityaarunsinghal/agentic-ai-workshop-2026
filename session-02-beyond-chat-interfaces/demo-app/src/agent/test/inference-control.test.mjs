import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createGateway } from "../gateway.mjs";
import { recoveryReceipt, retryAfterMs, createInferenceControl, responseFailure } from "../inference-control.mjs";
import { sseResponse, fixtureDecisions } from "../fixture.mjs";
import { offlineTrace, deferred } from "./helpers.mjs";

const model = "openai/gpt-6-luna", profileId = "luna-auto";
const selection = { inference: { selection: { modelId: model, profileId } },
  decisions: { version: "decisions-v1", models: [{ id: "typesafe/jev-1.13", profileId: "jev-native", enabled: true, quoteFresh: true }] } };
const config = { mode: "hosted", brokerUrl: "http://127.0.0.1:9999", token: "offline-token", model,
  maxInferenceCostUsd: 1, maxRequestCostUsd: 0.05 };
function refusal(init, { retryable = true, mismatch = false, unknown = false,
  code = "RATE_LIMITED", details = {}, headers = {} } = {}) {
  const h = new Headers(init.headers), operationId = h.get("x-workshop-operation-id");
  return new Response(JSON.stringify({ error: { code, message: "Synthetic refusal", retryable,
    details: { ...details, recovery: { version: "workshop.inference-operation.v1", operationId: mismatch ? "other" : operationId,
      modelId: JSON.parse(init.body).model, profileId: h.get("x-workshop-expected-profile"), phase: "failed",
      attempts: [], attemptsUsed: 0, usage: { knownCostUsd: "0", reservedUsd: unknown ? "0.05" : "0", unsettledRequests: unknown ? 1 : 0 } } } } }),
    { status: 429, headers });
}
function fixture(fetcher, overrides = {}) {
  const trace = offlineTrace((url, init) => String(url).endsWith("/bootstrap")
    ? new Response(JSON.stringify(selection)) : fetcher(url, init));
  return { trace, gateway: createGateway({ trace, config: { ...config, retrySleep: async () => {}, ...overrides } }) };
}
const messages = [{ role: "user", content: "A synthetic request." }];

test("bound zero-charge refusal retries with a fresh ID in the same turn", async () => {
  let calls = 0; const ids = [];
  const { gateway, trace } = fixture((url, init) => {
    ids.push(new Headers(init.headers).get("x-workshop-operation-id"));
    if (++calls === 1) return refusal(init);
    return sseResponse({ content: "Recovered synthetic answer." }, "stop", model);
  });
  await gateway.ready();
  const conversation = gateway.createConversation({ requestKind: "editorial", maxTurns: 2 });
  const stream = conversation.streamFn(conversation.model, normalizeContext({ messages }));
  for await (const _ of stream) { /* Real Pi parsing. */ }
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(conversation.turns, 1); assert.equal(calls, 2); assert.notEqual(ids[0], ids[1]);
  // The synthetic successful stream omits a cost receipt; its separate hold
  // must remain. Only the proven refused attempt is released.
  assert.equal(gateway.budget.reservedUsd, 0.05);
  assert.equal(gateway.budget.unsettledOperations.length, 1);
  assert.equal(trace.entries.filter(x => x.kind === "inference.retry_wait").length, 1);
});

test("permanent run cap clears its zero-cost hold and prevents repeated dispatch", async () => {
  let calls = 0; const { gateway } = fixture((url, init) => { calls++; return refusal(init, { retryable: false }); });
  await assert.rejects(gateway.completeText({ messages }), { code: "RUN_REQUEST_LIMIT" });
  assert.equal(gateway.budget.reservedUsd, 0);
  await assert.rejects(gateway.completeText({ messages }), { code: "RUN_REQUEST_LIMIT" });
  assert.equal(calls, 1); assert.equal(gateway.activity.blocked.code, "RUN_REQUEST_LIMIT");
});

test("mismatched and uncertain receipts never release holds or replay", async () => {
  for (const failure of [{ mismatch: true }, { unknown: true }]) {
    let calls = 0; const { gateway } = fixture((url, init) => { calls++; return refusal(init, failure); });
    await assert.rejects(gateway.completeText({ messages }), { code: "RATE_LIMITED" });
    assert.equal(calls, 1); assert.equal(gateway.budget.reservedUsd, 0.05);
  }
});

test("a retryable service failure permits deliberate recovery without automatic replay", async () => {
  let calls = 0;
  const { gateway } = fixture(() => {
    calls++;
    return new Response(JSON.stringify({ error: { code: "HTTP_503", message: "Synthetic busy service",
      retryable: true } }), { status: 503 });
  });
  await assert.rejects(gateway.completeText({ messages }), { code: "HTTP_503", retryable: true });
  assert.equal(calls, 1);
  assert.equal(gateway.budget.reservedUsd, 0.05);
});

test("Decisions share safe rejection recovery and accounting", async () => {
  let calls = 0; const ids = [];
  const { gateway } = fixture((url, init) => {
    ids.push(new Headers(init.headers).get("x-workshop-operation-id"));
    if (++calls === 1) return refusal(init);
    return new Response(JSON.stringify(fixtureDecisions(JSON.parse(init.body))));
  });
  const result = await gateway.decide({ state: {}, questions: { check: {
    type: "noul", instructions: "Synthetic check", criteria: { true: "yes", false: "no" },
  } } });
  assert.equal(result.answers.check.noul, 0.5); assert.equal(calls, 2);
  assert.notEqual(ids[0], ids[1]); assert.equal(gateway.budget.reservedUsd, 0);
});

test("status GET omits POST-only header and settles interrupted accounting", async () => {
  const { gateway, trace } = fixture((url, init) => {
    if (!url.includes("/operations/")) throw new Error("Synthetic connection interruption");
    const h = new Headers(init.headers), operationId = url.split("/").at(-1);
    assert.equal(h.has("x-workshop-attempt-limit"), false);
    assert.equal(h.get("x-workshop-operation-id"), operationId);
    return new Response(JSON.stringify({ operation: { operationId, modelId: model, profileId,
      phase: "failed", usage: { knownCostUsd: "0", reservedUsd: "0", unsettledRequests: 0 } } }));
  });
  await assert.rejects(gateway.completeText({ messages }));
  assert.equal(gateway.budget.reservedUsd, 0.05);
  await gateway.operation(gateway.budget.unsettledOperations[0]);
  assert.equal(gateway.budget.reservedUsd, 0);
  assert.equal(trace.requests.filter(x => x.init.method === "POST").length, 1);
});

test("independent requests have no shared two-slot throttle", async () => {
  const control = createInferenceControl({ trace: offlineTrace() });
  const releases = await Promise.all(Array.from({ length: 6 }, () => control.acquire()));
  assert.equal(control.snapshot().active, 6);
  assert.equal(control.snapshot().queued, 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(control.acquire({ signal: abort.signal }));
  for (const release of releases) { release(); release(); }
  assert.equal(control.snapshot().active, 0);
});

test("cancelling a cooldown sends no retry and retains confirmed zero cost", async () => {
  for (const backend of ["chat", "decision"]) {
    const abort = new AbortController(), seen = deferred();
    let calls = 0;
    const { gateway } = fixture((url, init) => { calls++; return refusal(init); }, {
      retrySleep: () => { seen.resolve(); return new Promise(() => {}); },
    });
    const result = backend === "chat" ? gateway.completeText({ messages, signal: abort.signal }) :
      gateway.decide({ state: {}, questions: { check: {
        type: "noul", instructions: "Synthetic check", criteria: { true: "Yes", false: "No" },
      } }, signal: abort.signal });
    await seen.promise; abort.abort();
    await assert.rejects(result, { code: "ABORTED" });
    assert.equal(calls, 1); assert.equal(gateway.budget.reservedUsd, 0); assert.equal(gateway.activity.active, 0);
  }
});

test("provider Retry-After waits only its request and keeps the existing four-retry bound", { timeout: 2000 }, async () => {
  const waiting = deferred(), release = deferred(), delays = [];
  let refusedCalls = 0, otherCalls = 0;
  const { gateway, trace } = fixture((_url, init) => {
    if (JSON.parse(init.body).messages.some(message => message.content === "Other work")) {
      otherCalls++;
      return sseResponse({ content: "Independent answer" }, "stop", model);
    }
    refusedCalls++;
    return refusal(init, { code: "UPSTREAM_FAILED", details: { providerError: {
      code: 429, metadata: { error_type: "rate_limit_exceeded" },
    } }, headers: { "retry-after": "3" } });
  }, { retrySleep: async ms => { delays.push(ms); waiting.resolve(); await release.promise; } });
  const refused = assert.rejects(gateway.completeText({ messages }), error => {
    assert.equal(error.code, "UPSTREAM_FAILED");
    assert.equal(error.operationId, trace.entries.filter(entry => entry.kind === "inference.rejected").at(-1).operationId);
    return true;
  });
  await waiting.promise;
  try {
    assert.equal((await gateway.completeText({ messages: [{ role: "user", content: "Other work" }] })).text, "Independent answer");
    assert.equal(otherCalls, 1);
  } finally { release.resolve(); }
  await refused;
  assert.equal(refusedCalls, 5);
  assert.deepEqual(delays, [3000, 4000, 8000, 16000]);
  assert.equal(trace.entries.filter(entry => entry.kind === "inference.retry_wait").length, 4);
  assert.equal(gateway.budget.reservedUsd, 0.05, "only the independent unpriced success retains a hold");
});

test("long or invalid cooldowns and permanent provider refusals never replay or masquerade as a visit cap", async () => {
  for (const options of [
    { headers: { "retry-after": "61" } }, { headers: { "retry-after": "invalid" } },
    { details: { retryGuidanceInvalid: true } }, { retryable: false },
  ]) {
    let calls = 0;
    const { gateway } = fixture((_url, init) => {
      calls++;
      return refusal(init, { code: "UPSTREAM_FAILED", ...options });
    });
    await assert.rejects(gateway.completeText({ messages }), error => {
      assert.equal(error.code, "UPSTREAM_FAILED");
      assert.match(error.message, /model provider.*429/);
      assert.match(error.message, /Synthetic refusal/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(gateway.budget.reservedUsd, 0);
    assert.equal(gateway.activity.blocked, null);
  }
});

test("broker concurrency and provider rate refusals retain separate explanations", async () => {
  for (const [code, message] of [
    ["CONCURRENCY_LIMIT", /broker.*concurrency/], ["UPSTREAM_FAILED", /model provider.*429/],
    ["RATE_LIMITED", /inference service.*429/],
  ]) {
    const error = await responseFailure(new Response(JSON.stringify({
      error: { code, message: "Exact refusal reason", retryable: true },
    }), { status: 429 }), { workshop: true });
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.match(error.message, /Exact refusal reason/);
    assert.equal(error.safeToRetry, false);
  }
});

test("Retry-After parsing and recovery validation reject missing monetary evidence", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("Thu, 15 Oct 2026 00:00:05 GMT", Date.parse("2026-10-15T00:00:00Z")), 5000);
  assert.equal(retryAfterMs("nonsense"), null);
  assert.equal(retryAfterMs("-1"), null);
  assert.equal(retryAfterMs("9".repeat(400)), null);
  assert.equal(recoveryReceipt({ version: "workshop.inference-operation.v1", operationId: "a", modelId: model,
    profileId, phase: "failed", usage: { knownCostUsd: "0", reservedUsd: "", unsettledRequests: 0 } },
  { operationId: "a", model, profileId }), null);
});
