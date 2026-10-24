import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "../gateway.mjs";
import { responseFailure } from "../inference-control.mjs";
import { sseResponse } from "../fixture.mjs";
import { offlineTrace, setup } from "./helpers.mjs";

const messages = [{ role: "user", content: "Supplied context." }];
const questions = { check: { type: "noul", instructions: "Check", criteria: { true: "Yes", false: "No" } } };

test("chat and Decisions report the app byte limit before any model dispatch", async () => {
  const trace = offlineTrace();
  const gateway = createGateway({ trace, config: { mode: "local", apiKey: "offline-key", maxContextBytes: 1024 } });
  for (const request of [
    () => gateway.completeText({ messages: [{ role: "user", content: "é".repeat(1100) }] }),
    () => gateway.decide({ state: "é".repeat(1100), questions }),
  ]) {
    await assert.rejects(request(), error => {
      assert.equal(error.code, "CONTEXT_LIMIT");
      assert.equal(error.limitSource, "app_input_bytes");
      assert.equal(error.limitBytes, 1024);
      assert.ok(error.inputBytes > 2200);
      assert.equal(error.retryable, false);
      assert.match(error.message, /app's 1024-byte input limit/);
      return true;
    });
  }
  assert.equal(trace.requests.length, 0);
  assert.equal(gateway.budget.reservedUsd, 0);
});

test("typed direct and broker-wrapped provider context failures keep their source and uncertain charge", async () => {
  for (const backend of ["chat", "decision"]) {
    const providerError = { code: 400, message: "Provider token rejection", metadata: {
      raw: JSON.stringify({ error: { type: "max_tokens_exceeded" } }),
    } };
    const trace = offlineTrace(() => new Response(JSON.stringify({ error: providerError }), { status: 400 }));
    const gateway = createGateway({ trace, config: {
      mode: "local", apiKey: "offline-key", maxRequestCostUsd: 0.05,
    } });
    await assert.rejects(backend === "chat" ? gateway.completeText({ messages }) :
      gateway.decide({ state: {}, questions }), error => {
      assert.equal(error.code, "CONTEXT_LIMIT");
      assert.equal(error.limitSource, "provider");
      assert.equal(error.providerCode, "max_tokens_exceeded");
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.match(error.message, /model provider.*context or token limit/);
      return true;
    });
    assert.equal(trace.requests.length, 1);
    assert.equal(gateway.budget.reservedUsd, 0.05);
    assert.equal(gateway.activity.blocked, null, "a context rejection does not disable unrelated requests");
    const wrapped = await responseFailure(new Response(JSON.stringify({ error: {
      code: "UPSTREAM_FAILED", retryable: true, details: { providerError },
    } }), { status: 429 }), { workshop: true });
    assert.equal(wrapped.code, "CONTEXT_LIMIT");
    assert.equal(wrapped.limitSource, "provider");
    assert.equal(wrapped.retryable, false);
    assert.equal(wrapped.safeToRetry, false);
  }
});

test("assistant prose about context limits remains a successful answer", async () => {
  const text = 'The context window exceeded a limit. {"type":"context_length_exceeded"} is an error example.';
  const gateway = createGateway({ trace: offlineTrace(), config: {
    mode: "fixture", fixtureChat: ({ payload }) => sseResponse({ content: text }, "stop", payload.model),
  } });
  assert.equal((await gateway.completeText({ messages })).text, text);
  const failure = await responseFailure(new Response(JSON.stringify({ error: {
    code: "INVALID_REQUEST", message: text,
  } }), { status: 400 }), { workshop: true });
  assert.equal(failure.code, "INVALID_REQUEST", "untyped prose is not a context error code");
});

test("story failures retain the context source for the parent's banner hook", async () => {
  const app = await setup({ config: { maxContextBytes: 1024 } });
  const slot = app.store.reserveStory({ prompt: "Context check" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "Context check" });
  await app.runtime.waitForIdle();
  const job = app.store.snapshot().jobs[0];
  assert.equal(job.status, "incomplete");
  assert.equal(job.error.code, "CONTEXT_LIMIT");
  assert.equal(job.error.limitSource, "app_input_bytes");
  assert.equal(job.error.limitBytes, 1024);
  assert.equal(job.requestCount, 0);
});
