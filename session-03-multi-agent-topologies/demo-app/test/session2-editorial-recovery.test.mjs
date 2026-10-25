import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEditorialAnswerAliases, buildEditorialInput, buildEditorialQuestions,
  createEditorial, validateEditorialDecision,
} from "../src/editorial.mjs";
import { createTrace } from "../src/trace.mjs";

const model = "fixture/general-editor";
const decisionModel = "typesafe/jev-1.13";
const nativeModel = `${decisionModel}-20260917`;
const storyId = "12345678-1234-4234-8234-123456789abc";
const deferred = () => Promise.withResolvers();

// Synthetic in-memory issue only. No provider, browser, files, or user data.
function setup({ stage = "editor", sentences = 3, gateway = {}, limit = 20 } = {}) {
  const state = {
    issue: {
      id: "synthetic-recovery", revision: 1, focus: "Supported claims", audience: "builders",
      sources: [{ id: "evidence", title: "Synthetic evidence", text: "A reported finding." }],
      stories: [{
        id: storyId, headline: "An attributed finding",
        body: Array.from({ length: sentences }, (_, i) => `This is sentence number ${i}.`).join(" "),
        sourceIds: ["evidence"], contentVersion: 1, locked: false, section: "news",
        frame: { x: 10, y: 20, width: 90, height: 120 },
      }],
      relationships: [],
    },
    settings: { stage, model, decisionModel },
    editorialHistory: [], suggestions: [],
  };
  const listeners = new Set();
  const snapshot = () => structuredClone(state);
  const notify = () => { for (const listener of listeners) listener(snapshot()); };
  const store = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    updateActivity(patch) { Object.assign(state, structuredClone(patch)); notify(); },
    update(mutator) { mutator(state.issue, state); state.issue.revision++; notify(); },
    change(mutator) { mutator(state); state.issue.revision++; notify(); },
  };
  const trace = createTrace();
  const calls = [];
  const adapter = {
    model, maxTokens: 4096,
    completeText(args) {
      calls.push(args);
      return chatReply(args, { operationId: `chat-${calls.length}`, usage: { cost: 0.001 } });
    },
    ...gateway,
  };
  return {
    store, trace, calls, gateway: adapter,
    editorial: createEditorial({ store, trace, gateway: adapter, config: { maxDecisionRequests: limit } }),
  };
}

function requestData(args) {
  const { state, questions } = JSON.parse(args.messages.at(-1).content);
  const mapping = args.messages.filter((message) => message.role === "system")
    .map((message) => { try { return JSON.parse(message.content); } catch { return null; } })
    .find((value) => value?.answerKeyFormat === "editorial.aliases.v1");
  assert.ok(mapping, "The exact answer-key mapping must be in the model request.");
  return { state, questions, aliases: mapping.questionAliases };
}

function answersFor(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
    question.type === "noul" ? { type: "noul", noul: 0.123456789 } : {
      type: "choice",
      choice: id.startsWith("style_") ? "medium_italic" :
        { layout: "newspaper", reaction: "keep", lead: storyId, layout_cleanup: "keep", layout_basis: "balanced_coverage" }[id],
    },
  ]));
}

function chatReply(args, extra = {}) {
  const { questions, aliases } = requestData(args);
  const canonical = answersFor(questions);
  const answers = Object.fromEntries(Object.entries(aliases).map(([alias, id]) => [alias, canonical[id]]));
  return { model: args.model, text: JSON.stringify({ answers }), simulated: true, ...extra };
}

test("short aliases cover every exact ID, are order-stable, and cannot collide with canonical IDs", () => {
  const { store } = setup({ sentences: 35 });
  const questions = buildEditorialQuestions(buildEditorialInput(store.snapshot()));
  const aliases = buildEditorialAnswerAliases(questions);
  assert.equal(Object.keys(aliases).length, 39);
  assert.deepEqual(Object.values(aliases).sort(), Object.keys(questions).sort());
  assert.ok(Object.keys(aliases).every((id) => /^q\d{1,2}$/u.test(id)));
  assert.deepEqual(buildEditorialAnswerAliases(Object.fromEntries(Object.entries(questions).reverse())), aliases);
  const collisions = { q1: {}, q3: {}, style_abc: {} };
  const disjoint = buildEditorialAnswerAliases(collisions);
  assert.ok(Object.keys(disjoint).every((id) => !Object.hasOwn(collisions, id)));
  assert.deepEqual(Object.values(disjoint).sort(), Object.keys(collisions).sort());
});

test("aliased chat batches map all sentences back and retain exact provider responses and cache provenance", async () => {
  const app = setup({ sentences: 35 });
  const before = app.store.snapshot().issue;
  const first = await app.editorial.review();
  const receipt = first.state.editorial;
  assert.equal(app.calls.length, 2);
  assert.equal(receipt.typographyQuestionCount, 35);
  assert.deepEqual(receipt.requestedOperationIds, ["chat-1", "chat-2"]);
  assert.equal(receipt.knownCostUsd, 0.002);
  const typography = first.state.issue.stories[0].typography;
  assert.equal(Object.keys(typography.styles).length, 35);
  assert.ok(Object.values(typography.styles).every((style) => style === "medium_italic"));
  assert.deepEqual(first.state.issue.stories[0].frame, before.stories[0].frame);
  assert.equal(first.state.issue.stories[0].body, before.stories[0].body);
  const record = app.trace.entries.find((entry) => entry.id === first.requestId);
  assert.equal(Object.keys(record.result.answers).length, 39);
  assert.deepEqual(Object.keys(record.result.answers).sort(),
    Object.keys(buildEditorialQuestions(buildEditorialInput({ issue: before }))).sort());
  for (const [index, args] of app.calls.entries()) {
    const { state, questions, aliases } = requestData(args);
    const batch = record.result.batches[index];
    const batchTrace = app.trace.entries.find((entry) => entry.id === batch.requestId);
    assert.deepEqual(batchTrace.questionAliases, aliases);
    assert.deepEqual(batchTrace.payload, { state, questions });
    assert.deepEqual(batch.response, chatReply(args, { operationId: `chat-${index + 1}`, usage: { cost: 0.001 } }));
    assert.deepEqual(Object.keys(JSON.parse(batch.response.text).answers), Object.keys(aliases));
  }
  const cached = await app.editorial.review();
  assert.equal(app.calls.length, 2);
  assert.equal(cached.cached, true);
  assert.equal(cached.state.editorial.sourceRequestId, first.requestId);
  assert.equal(cached.state.editorial.knownCostUsd, 0);
  assert.equal(cached.state.editorial.sourceKnownCostUsd, 0.002);
  assert.deepEqual(cached.state.editorial.sourceOperationIds, receipt.operationIds);
  assert.deepEqual(cached.state.editorial.requestedOperationIds, []);
});

test("missing, extra, mixed, mistyped, or invalid aliased answers never apply or trigger automatic repair", async (t) => {
  const mutations = {
    missing(answers) { delete answers.q1; },
    extra(answers) { answers.q999 = { type: "choice", choice: "keep" }; },
    mixed(answers, aliases) { answers[aliases.q1] = answers.q1; delete answers.q1; },
    duplicateIdentity(answers, aliases) { answers[aliases.q1] = answers.q1; },
    mistypedHash(answers, aliases) {
      const alias = Object.keys(aliases).find((key) => aliases[key].startsWith("style_"));
      answers[`${aliases[alias]}0`] = answers[alias];
      delete answers[alias];
    },
    unknownChoice(answers) { answers.q1.choice = "invented"; },
    wrongType(answers) { answers.q1.type = "noul"; },
    confidence(answers) { answers.q1.confidence = 0.9; },
    probabilities(answers) { answers.q1.probabilities = { keep: 1 }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    let calls = 0;
    const app = setup({ gateway: { completeText(args) {
      calls++;
      const raw = chatReply(args, { operationId: "charged-invalid", usage: { cost: 0.003 } });
      const parsed = JSON.parse(raw.text);
      mutate(parsed.answers, requestData(args).aliases);
      return { ...raw, text: JSON.stringify(parsed) };
    } } });
    const original = app.store.snapshot().issue;
    await assert.rejects(app.editorial.review(), { code: "EDITORIAL_RESPONSE" });
    assert.deepEqual(app.store.snapshot().issue, original);
    assert.equal(app.store.snapshot().editorial.knownCostUsd, 0.003);
    assert.equal(app.store.snapshot().editorial.retryable, true);
    assert.equal(app.store.snapshot().editorial.retryRequiresExplicit, true);
    await assert.rejects(app.editorial.review());
    app.store.change((state) => { state.issue.title = "Only the masthead changed"; });
    await assert.rejects(app.editorial.review());
    assert.equal(calls, 1);
  });
});

test("exact original hashes remain valid but a near-match is never repaired", () => {
  const { store } = setup();
  const questions = buildEditorialQuestions(buildEditorialInput(store.snapshot()));
  const original = answersFor(questions);
  const raw = { json: { answers: original }, model, operationId: "original" };
  const decision = validateEditorialDecision(raw, { backend: "chat", model, questions });
  assert.deepEqual(decision.answers, original);
  decision.answers.layout.choice = "changed by caller";
  assert.equal(original.layout.choice, "newspaper");
  const id = Object.keys(original).find((key) => key.startsWith("style_"));
  original[`${id.slice(0, -1)}9`] = original[id];
  delete original[id];
  assert.throws(() => validateEditorialDecision(raw, { backend: "chat", model, questions }), /different question set/);
});

test("explicit malformed-answer retry retains the first charge and caches only the validated result", async () => {
  let calls = 0;
  const app = setup({ gateway: { completeText(args) {
    calls++;
    return chatReply(args, {
      operationId: `attempt-${calls}`, usage: { cost: calls === 1 ? 0.003 : 0.002 },
      ...(calls === 1 ? { text: '{"answers":{}}' } : {}),
    });
  } } });
  await assert.rejects(app.editorial.review(), /different question set/);
  const failed = app.store.snapshot().editorial;
  const recovered = await app.editorial.review({ retry: true });
  assert.equal(calls, 2);
  assert.notEqual(recovered.requestId, failed.requestId);
  assert.equal(recovered.state.editorial.retryOfRequestId, failed.requestId);
  assert.equal(recovered.state.editorial.knownCostUsd, 0.002);
  assert.equal(recovered.state.editorial.cachedBatchCount, 0);
  assert.deepEqual(recovered.state.editorial.requestedOperationIds, ["attempt-2"]);
  assert.deepEqual(recovered.state.editorialHistory.find((entry) => entry.requestId === failed.requestId), failed);
  const failedTrace = app.trace.entries.find((entry) => entry.id === failed.requestId);
  assert.equal(failedTrace.result.batches[0].response.text, '{"answers":{}}');
  const cached = await app.editorial.review({ retry: true });
  assert.equal(calls, 2, "Retry must not force a new paid call after success.");
  assert.equal(cached.state.editorial.sourceRequestId, recovered.requestId);
  assert.equal(cached.state.editorial.sourceKnownCostUsd, 0.002);
});

test("transient failures allow explicit retry or a new stable revision, while same-revision polls stay free", async (t) => {
  for (const mode of ["explicit", "new revision"]) await t.test(mode, async () => {
    const response = deferred(), dispatched = deferred();
    let calls = 0;
    const app = setup({ gateway: { completeText(args) {
      calls++;
      if (calls === 1) throw Object.assign(new Error("Synthetic concurrency denial"), {
        code: "RATE_LIMITED", retryable: true, operationId: "failed-concurrency", usage: { cost: 0 },
      });
      dispatched.resolve(args);
      return response.promise;
    } } });
    await assert.rejects(app.editorial.review(), /concurrency/);
    const failed = app.store.snapshot().editorial;
    assert.equal(failed.retryable, true);
    for (let poll = 0; poll < 3; poll++) await assert.rejects(app.editorial.review());
    assert.equal(calls, 1);
    if (mode === "new revision") app.store.change((state) => { state.issue.title = "New masthead"; });
    const pending = app.editorial.review({ retry: mode === "explicit" });
    const args = await dispatched.promise;
    assert.equal(app.editorial.review({ retry: true }), pending);
    response.resolve(chatReply(args, { operationId: "recovery", usage: { cost: 0.001 } }));
    const recovered = await pending;
    assert.equal(recovered.state.editorial.retryOfRequestId, failed.requestId);
    assert.equal(recovered.state.editorial.status, "complete");
    assert.equal(calls, 2);
    assert.equal(recovered.state.editorialHistory.find((entry) => entry.requestId === failed.requestId).knownCostUsd, 0);
  });
});

test("provider retryable:false overrides status heuristics and explicit retries", async (t) => {
  for (const metadata of [
    { code: "HTTP_429", retryable: false },
    { code: "HTTP_503", details: { recovery: { failure: { retryable: false } } } },
    { code: "COST_LIMIT" },
    { code: "MODEL_CHANGED" },
  ]) await t.test(metadata.code, async () => {
    let calls = 0;
    const app = setup({ gateway: { completeText() {
      calls++;
      throw Object.assign(new Error("Synthetic permanent denial"), metadata, {
        operationId: "denial", usage: { cost: 0 },
      });
    } } });
    await assert.rejects(app.editorial.review());
    assert.equal(app.store.snapshot().editorial.retryable, false);
    await assert.rejects(app.editorial.review({ retry: true }));
    app.store.change((state) => { state.issue.title = "Another masthead"; });
    await assert.rejects(app.editorial.review({ retry: true }));
    assert.equal(calls, 1);
    assert.equal(app.store.snapshot().editorial.phase, "reused_failure");
    assert.deepEqual(app.store.snapshot().editorial.requestedOperationIds, []);
  });
});

test("bootstrap timeout can be explicitly retried without manufacturing a paid attempt", async () => {
  let bootstraps = 0;
  const app = setup({ gateway: { ready() {
    if (++bootstraps === 1) throw Object.assign(new Error("Synthetic bootstrap timeout"), { code: "HTTP_503" });
    return { model };
  } } });
  await assert.rejects(app.editorial.review());
  const failed = app.store.snapshot().editorial;
  assert.equal(failed.requestedBatchCount, 0);
  assert.equal(failed.knownCostUsd, 0);
  assert.equal(failed.unreportedCostCount, 0);
  await app.editorial.review({ retry: true });
  assert.equal(bootstraps, 2);
  assert.equal(app.calls.length, 1);
});

test("retry reuses completed native batches, retains uncertain failures, and respects the total request ceiling", async () => {
  const calls = [];
  const app = setup({ stage: "research", sentences: 45, limit: 3, gateway: {
    decide(args) {
      calls.push(args);
      if (calls.length === 2) throw Object.assign(new Error("Synthetic timeout after dispatch"), {
        code: "ETIMEDOUT", operationId: "uncertain-2", model: nativeModel, usage: null,
      });
      return {
        answers: answersFor(args.questions), model: nativeModel, requestedModel: decisionModel,
        operationId: `native-${calls.length}`, usage: { cost: 0.001 }, simulated: true,
      };
    },
  } });
  const original = app.store.snapshot().issue;
  await assert.rejects(app.editorial.review(), /timeout/);
  const failed = app.store.snapshot().editorial;
  assert.deepEqual(app.store.snapshot().issue, original);
  assert.equal(failed.completedBatchCount, 1);
  assert.equal(failed.knownCostUsd, 0.001);
  assert.equal(failed.unreportedCostCount, 1);
  const recovered = await app.editorial.review({ retry: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].questions, calls[1].questions);
  const receipt = recovered.state.editorial;
  assert.equal(receipt.model, nativeModel);
  assert.equal(receipt.retryOfRequestId, failed.requestId);
  assert.equal(receipt.cachedBatchCount, 1);
  assert.equal(receipt.requestedBatchCount, 1);
  assert.equal(receipt.knownCostUsd, 0.001);
  assert.equal(receipt.sourceKnownCostUsd, 0.001);
  assert.deepEqual(receipt.requestedOperationIds, ["native-3"]);
  assert.deepEqual(receipt.sourceOperationIds, ["native-1"]);
  assert.equal(recovered.state.editorialHistory.find((entry) => entry.requestId === failed.requestId).unreportedCostCount, 1);
  assert.equal(recovered.state.issue.stories[0].factCheck.probability, 0.123456789);
  assert.equal(recovered.state.issue.stories[0].factCheck.model, nativeModel);
  assert.equal(recovered.state.settings.stage, "research");
  app.store.change((state) => { state.issue.stories[0].frame.x++; });
  await assert.rejects(app.editorial.review(), /remaining request allowance/);
  assert.equal(calls.length, 3);
});

test("multiple failed explicit retries keep distinct receipts and never reset the request ceiling", async () => {
  let calls = 0;
  const app = setup({ limit: 2, gateway: { completeText() {
    calls++;
    throw Object.assign(new Error("Synthetic temporary outage"), {
      retryable: true, operationId: `outage-${calls}`, usage: { cost: 0.001 },
    });
  } } });
  await assert.rejects(app.editorial.review());
  const first = app.store.snapshot().editorial;
  await assert.rejects(app.editorial.review({ retry: true }));
  const second = app.store.snapshot().editorial;
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(second.retryOfRequestId, first.requestId);
  await assert.rejects(app.editorial.review({ retry: true }), /remaining request allowance/);
  assert.equal(calls, 2);
  const charged = app.store.snapshot().editorialHistory.filter((entry) => entry.requestedBatchCount);
  assert.deepEqual(charged.map((entry) => entry.knownCostUsd), [0.001, 0.001]);
  assert.deepEqual(charged.flatMap((entry) => entry.requestedOperationIds), ["outage-1", "outage-2"]);
});

test("cancellation aborts the active batch without poisoning a later review of the same input", async () => {
  const dispatched = deferred(), response = deferred();
  let calls = 0;
  const app = setup({ gateway: { completeText(args) {
    calls++;
    if (calls === 1) { dispatched.resolve(args); return response.promise; }
    return chatReply(args, { operationId: "after-cancel", usage: { cost: 0.001 } });
  } } });
  const pending = app.editorial.review();
  const args = await dispatched.promise;
  app.editorial.cancel();
  assert.equal(args.signal.aborted, true);
  response.reject(Object.assign(new Error("Synthetic cancelled operation"), {
    operationId: "cancelled-charge", usage: { cost: 0.002 },
  }));
  assert.equal((await pending).superseded, true);
  const cancelled = app.store.snapshot().editorialHistory.at(-1);
  assert.equal(cancelled.knownCostUsd, 0.002);
  assert.equal(app.store.snapshot().issue.stories[0].typography, undefined);
  const recovered = await app.editorial.review();
  assert.equal(recovered.state.editorial.status, "complete");
  assert.equal(recovered.state.editorial.retryOfRequestId, cancelled.requestId);
  assert.equal(calls, 2);
});

test("cancel during bootstrap retires queued work and performs no paid call until a new review", async () => {
  const started = deferred(), bootstrap = deferred();
  const app = setup({ gateway: { ready() { started.resolve(); return bootstrap.promise; } } });
  const first = app.editorial.review();
  await started.promise;
  app.store.change((state) => { state.issue.focus = "New scope"; });
  const queued = app.editorial.review();
  app.editorial.cancel();
  bootstrap.resolve({ model });
  assert.equal((await first).superseded, true);
  assert.equal((await queued).superseded, true);
  assert.equal(app.calls.length, 0);
  const recovered = await app.editorial.review();
  assert.equal(recovered.state.editorial.status, "complete");
  assert.equal(app.calls.length, 1);
});

test("a valid late response after cancellation retains its charge and can be reused only by a new review", async () => {
  const dispatched = deferred(), response = deferred();
  let calls = 0;
  const app = setup({ gateway: { completeText(args) {
    calls++; dispatched.resolve(args); return response.promise;
  } } });
  const pending = app.editorial.review();
  const args = await dispatched.promise;
  app.editorial.cancel();
  response.resolve(chatReply(args, { operationId: "late-valid", usage: { cost: 0.002 } }));
  assert.equal((await pending).superseded, true);
  const cancelled = app.store.snapshot().editorialHistory.at(-1);
  assert.equal(app.store.snapshot().issue.stories[0].typography, undefined);
  const recovered = await app.editorial.review();
  assert.equal(recovered.state.editorial.status, "complete");
  assert.equal(recovered.cached, true);
  assert.equal(recovered.state.editorial.sourceRequestId, cancelled.requestId);
  assert.equal(recovered.state.editorial.knownCostUsd, 0);
  assert.equal(recovered.state.editorial.sourceKnownCostUsd, 0.002);
  assert.deepEqual(recovered.state.editorial.sourceOperationIds, ["late-valid"]);
  assert.equal(calls, 1);
});

test("typography cache requires complete input parity, including position, evidence, focus, and frame size", async () => {
  const app = setup();
  const first = await app.editorial.review({ movedStoryId: storyId });
  app.store.change((state) => { state.issue.title = "Unrelated masthead"; });
  const reused = await app.editorial.review({ movedStoryId: storyId });
  assert.equal(app.calls.length, 1);
  assert.equal(reused.state.issue.stories[0].typography.sourceRequestId, first.requestId);
  for (const change of [
    (state) => { state.issue.stories[0].frame.x++; },
    (state) => { state.issue.sources[0].text = "Revised evidence"; },
    (state) => { state.issue.focus = "A different audience goal"; },
    (state) => { state.issue.stories[0].frame.width++; },
  ]) {
    app.store.change(change);
    const beforeCalls = app.calls.length;
    const changed = await app.editorial.review({ movedStoryId: storyId });
    assert.equal(app.calls.length, beforeCalls + 1);
    assert.equal(changed.cached, false);
    assert.equal(changed.state.editorial.typographyQuestionCount, 3);
    const { questions } = requestData(app.calls.at(-1));
    assert.equal(Object.keys(questions).filter((id) => id.startsWith("style_")).length, 3);
  }
});
