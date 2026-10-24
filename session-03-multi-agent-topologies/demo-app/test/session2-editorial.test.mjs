import assert from "node:assert/strict";
import test from "node:test";
import { createEditorial, buildEditorialInput, buildEditorialQuestions, buildEditorialBatches } from "../src/editorial.mjs";
import { sentenceSegments, SENTENCE_STYLE_CRITERIA } from "../src/presentation.mjs";
import { createTrace } from "../src/trace.mjs";

const generalModel = "fixture/broker-selected-general";
const decisionModel = "typesafe/jev-1.13";
const nativeSnapshot = "typesafe/jev-1.13-20260917";
const deferred = () => Promise.withResolvers();

// No files, network, provider SDKs, or user issue data are used by this store.
function setup(stage = "editor", trace = createTrace()) {
  const state = {
    issue: {
      id: "test-issue", revision: 7, focus: "Independent scrutiny", audience: "builders",
      sources: [{ id: "source", title: "Supplied evidence", text: "One reported result." }],
      stories: ["a", "b"].map((id, index) => ({
        id, headline: `Story ${id}`, body: `Attributed copy ${id}.`,
        sourceIds: ["source"], section: "news", locked: index === 0,
        frame: { x: 12 + index * 90, y: 46, width: 84, height: 78 },
        contentVersion: 3, factCheck: { status: "pending", probability: null },
      })),
      relationships: [{ id: "manual", kind: "related", storyIds: ["a", "b"], suggested: false }],
    },
    settings: { stage, model: "openai/gpt-6-luna", decisionModel },
    suggestions: [], editorialHistory: [],
  };
  const listeners = new Set();
  const snapshot = () => structuredClone(state);
  const notify = () => { for (const listener of listeners) listener(snapshot()); };
  const store = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    updateActivity(patch) {
      assert.equal(Object.hasOwn(patch, "issue"), false);
      Object.assign(state, structuredClone(patch));
      notify();
      return snapshot();
    },
    update(mutator) {
      mutator(state.issue, state);
      state.issue.revision++;
      notify();
      return snapshot();
    },
    change(mutator, { revision = true } = {}) {
      mutator(state);
      if (revision) state.issue.revision++;
      notify();
    },
  };
  trace.subscribe?.(notify);
  return { store, trace };
}

function answersFor(questions, { reaction = "keep", layoutCleanup = "keep" } = {}) {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name,
    question.type === "noul" ? { type: "noul", noul: 0.37123456789 } :
      { type: "choice", choice: { layout: "newspaper", reaction, lead: "a", layout_cleanup: layoutCleanup, layout_basis: "balanced_coverage" }[name] ?? "large_bold" },
  ]));
}

function chatResult(args, extra = {}) {
  const { questions } = JSON.parse(args.messages.at(-1).content);
  return {
    text: JSON.stringify({ answers: answersFor(questions) }),
    model: args.model, operationId: "chat-operation", ...extra,
  };
}

test("tools and empty issues do not resolve bootstrap or dispatch editorial inference", async () => {
  const { store, trace } = setup("tools");
  const unexpected = () => { throw new Error("Unexpected gateway call"); };
  const editorial = createEditorial({ store, trace,
    gateway: { ready: unexpected, completeText: unexpected, decide: unexpected } });
  assert.equal((await editorial.review()).disabled, true);
  store.change((state) => { state.settings.stage = "editor"; state.issue.stories = []; });
  assert.equal((await editorial.review()).empty, true);
  assert.equal(store.snapshot().editorial, undefined);
});

test("running is observable through bootstrap and inference; identical requests share the selected model call", async () => {
  const { store, trace } = setup();
  const selection = deferred(), dispatched = deferred(), response = deferred();
  let bootstrapCalls = 0, calls = 0, selected = "openai/gpt-6-luna";
  const gateway = {
    get model() { return selected; },
    async ready() {
      bootstrapCalls++;
      await selection.promise;
      selected = generalModel;
      store.change((state) => { state.settings.model = selected; }, { revision: false });
      return { model: selected };
    },
    completeText(args) { calls++; dispatched.resolve(args); return response.promise; },
  };
  const editorial = createEditorial({ store, trace, gateway });
  assert.equal(bootstrapCalls, 0);
  const observed = [];
  store.subscribe((state) => observed.push(state.editorial));
  const original = store.snapshot().issue;
  const first = editorial.review({ parentId: "copy-completed" });
  assert.equal(store.snapshot().editorial.status, "running");
  assert.equal(store.snapshot().editorial.model, null);
  assert.equal(store.snapshot().editorial.questionsCount, 6);
  assert.equal(store.snapshot().editorial.choiceCount, 6);
  assert.equal(store.snapshot().editorial.noulCount, 0);
  assert.equal(store.snapshot().editorial.typographyQuestionCount, 1);
  assert.equal(store.snapshot().editorial.sentenceCount, 2);
  assert.equal(store.snapshot().editorial.lockedSentenceCount, 1);
  assert.match(store.snapshot().editorial.choiceQuestionDigest, /^[a-f0-9]{64}$/);
  assert.equal(store.snapshot().issue.revision, original.revision);
  assert.equal(editorial.review(), first);
  selection.resolve();
  const args = await dispatched.promise;
  assert.equal(args.model, generalModel);
  assert.equal(store.snapshot().editorial.status, "running");
  assert.equal(store.snapshot().editorial.phase, "inference");
  assert.equal(store.snapshot().editorial.model, generalModel);
  assert.equal(args.requestId, store.snapshot().editorial.requestId);
  assert.equal(trace.entries.find((entry) => entry.id === args.parentId).parentId, args.requestId);
  assert.equal(store.snapshot().editorial.requestedBatchCount, 1);
  assert.equal(editorial.review(), first);
  const raw = chatResult(args, {
    usage: { input_tokens: 12, cost: "0.0007" },
    sdkUsage: { cost: { total: 99 } },
  });
  response.resolve(raw);
  const result = await first;
  const receipt = result.state.editorial;
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.backend, "chat");
  assert.equal(receipt.knownCostUsd, 0.0007);
  assert.equal(receipt.operationId, "chat-operation");
  assert.deepEqual(receipt.requestedOperationIds, ["chat-operation"]);
  assert.deepEqual(receipt.sourceOperationIds, []);
  assert.equal(receipt.sourceKnownCostUsd, 0);
  assert.equal(receipt.resultRevision, original.revision + 1);
  assert.ok(receipt.durationMs >= receipt.bootstrapMs);
  assert.ok(observed.some((entry) => entry?.status === "running"));
  assert.equal(observed.at(-1).status, "complete");
  assert.equal(calls, 1);
  assert.deepEqual(result.state.issue.stories.map(({ factCheck, typography, ...story }) => story),
    original.stories.map(({ factCheck, typography, ...story }) => story));
  assert.equal(result.state.issue.stories[0].typography, undefined);
  assert.deepEqual(result.state.issue.stories[1].typography.styles, { s0: "large_bold" });
  assert.deepEqual(result.state.issue.stories[1].typography.sentences,
    sentenceSegments(original.stories[1].body).map(({ id, start, end }) => ({ id, start, end })));
  assert.equal(result.state.issue.stories[1].typography.contentVersion, 3);
  assert.equal(result.state.issue.stories[1].typography.model, generalModel);
  assert.equal(result.state.issue.stories[1].typography.requestId, receipt.requestId);
  assert.ok(result.state.issue.stories.every((story) => story.factCheck.probability === null));
  const record = trace.entries.find((entry) => entry.id === receipt.requestId);
  assert.equal(record.parentId, "copy-completed");
  assert.deepEqual(record.payload, JSON.parse(args.messages.at(-1).content));
  assert.deepEqual(record.result, raw);
  assert.equal("payload" in receipt, false);
  assert.equal("usage" in receipt, false);
});

test("unrelated source and job progress revisions keep the same pending editorial input and apply at the actual revision", async () => {
  const { store, trace } = setup();
  const started = deferred(), response = deferred();
  let calls = 0;
  const editorial = createEditorial({ store, trace, gateway: {
    model: generalModel,
    completeText(args) { calls++; started.resolve(args); return response.promise; },
  } });
  const inputRevision = store.snapshot().issue.revision;
  const input = buildEditorialInput(store.snapshot(), { movedStoryId: "b" });
  const pending = editorial.review({ movedStoryId: "b" });
  const args = await started.promise;
  for (const change of [
    (state) => state.issue.sources.push({ id: "unrelated", title: "Other research", text: "Not cited by the current stories." }),
    (state) => {
      state.jobs = [{ id: "other-job", phase: "queued" }];
      state.issue.stories.push({
        id: "empty-slot", headline: "", body: "", sourceIds: ["unrelated"],
        contentVersion: 0, locked: false, frame: { x: 192, y: 46, width: 84, height: 78 },
        status: "queued",
      });
    },
    (state) => {
      state.jobs[0].phase = "reading";
      state.issue.stories.at(-1).status = "researching";
      state.issue.sources.at(-1).text = "More unrelated research.";
    },
  ]) {
    store.change(change);
    assert.deepEqual(buildEditorialInput(store.snapshot(), { movedStoryId: "b" }), input);
    assert.equal(store.snapshot().editorial.status, "running");
    assert.equal(editorial.review({ movedStoryId: "b" }), pending);
  }
  const beforeApply = store.snapshot().issue.revision;
  response.resolve(chatResult(args));
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.superseded, undefined);
  assert.equal(result.state.editorial.status, "complete");
  assert.equal(result.state.editorial.inputRevision, inputRevision);
  assert.equal(result.state.editorial.resultRevision, beforeApply + 1);
  assert.equal(result.state.issue.revision, beforeApply + 1);
  assert.equal(result.state.editorial.movedStoryId, "b");
  assert.equal(result.state.issue.stories[1].typography.styles.s0, "large_bold");
  assert.equal(result.state.jobs[0].phase, "reading");
  assert.equal(result.state.issue.sources.at(-1).text, "More unrelated research.");
});

test("chat and native share Choice inputs; native probabilities, identity, provenance, and manual geometry survive caching", async () => {
  const { store, trace } = setup();
  let chatInput, nativeInput, nativeRaw, chatCalls = 0, nativeCalls = 0;
  const gateway = {
    model: generalModel,
    completeText(args) {
      chatCalls++;
      chatInput = JSON.parse(args.messages.at(-1).content);
      return chatResult(args);
    },
    decide(args) {
      nativeCalls++;
      nativeInput = args;
      nativeRaw = {
        model: nativeSnapshot, requestedModel: decisionModel, operationId: "native-operation",
        usage: { cost: 0.0002 }, answers: answersFor(args.questions, { reaction: "counterpoint_b" }),
      };
      nativeRaw.answers.layout = {
        type: "choice", choice: "side_by_side", confidence: 0.76,
        probabilities: { breaking_news: 0.1, newspaper: 0.14, side_by_side: 0.76 },
        providerDetail: "kept only in Execution ".repeat(1000),
      };
      return nativeRaw;
    },
  };
  const editorial = createEditorial({ store, trace, gateway });
  const chatReceipt = (await editorial.review({ movedStoryId: "a" })).state.editorial;
  assert.equal(chatReceipt.model, generalModel);
  store.change((state) => { state.settings.stage = "final"; });
  const before = store.snapshot().issue;
  const result = await editorial.review({ movedStoryId: "a" });
  assert.deepEqual(nativeInput.state, chatInput.state);
  assert.deepEqual(Object.fromEntries(Object.entries(nativeInput.questions)
    .filter(([, question]) => question.type === "choice")), chatInput.questions);
  assert.equal(nativeInput.questions.check_a.type, "noul");
  assert.match(nativeInput.questions.check_a.instructions, /additional factual verification/);
  const { editorial: receipt, issue } = result.state;
  assert.equal(receipt.inputDigest, chatReceipt.inputDigest);
  assert.equal(receipt.choiceQuestionDigest, chatReceipt.choiceQuestionDigest);
  assert.notEqual(receipt.questionDigest, chatReceipt.questionDigest);
  assert.equal(chatReceipt.choiceQuestionDigest, chatReceipt.questionDigest);
  assert.deepEqual(
    [chatReceipt.questionsCount, chatReceipt.choiceCount, chatReceipt.noulCount],
    [6, 6, 0],
  );
  assert.deepEqual([receipt.questionsCount, receipt.choiceCount, receipt.noulCount], [8, 6, 2]);
  assert.equal(receipt.model, nativeSnapshot);
  assert.equal(receipt.operationId, "native-operation");
  assert.deepEqual(receipt.answers.layout.probabilities, nativeRaw.answers.layout.probabilities);
  assert.equal("providerDetail" in receipt.answers.layout, false);
  assert.equal("providerDetail" in result.decisions.layout, false);
  assert.ok(JSON.stringify(receipt).length < 3000);
  assert.equal(issue.stories[0].factCheck.probability, 0.37123456789);
  assert.equal(issue.stories[0].factCheck.model, nativeSnapshot);
  assert.equal(issue.stories[0].factCheck.requestId, receipt.requestId);
  assert.match(issue.stories[0].factCheck.meaning, /not a certification/);
  assert.equal(issue.stories[0].factCheck.contentVersion, 3);
  assert.deepEqual(issue.stories.map(({ factCheck, typography, ...story }) => story),
    before.stories.map(({ factCheck, typography, ...story }) => story));
  assert.equal(issue.stories[1].typography.model, nativeSnapshot);
  assert.equal(issue.stories[1].typography.styles.s0, "large_bold");
  assert.deepEqual(issue.relationships[0], before.relationships[0]);
  assert.equal(result.state.suggestions[0].kind, "counterpoint");
  assert.equal(trace.entries.find((entry) => entry.id === receipt.requestId).result.answers.layout.providerDetail,
    nativeRaw.answers.layout.providerDetail);

  // Neither a caller nor the gateway can poison the private, validated cache.
  result.decisions.check_a.noul = 7;
  nativeRaw.answers.check_a.noul = 9;
  const cached = await editorial.review({ movedStoryId: "a" });
  assert.equal(cached.cached, true);
  assert.equal(cached.state.editorial.cached, true);
  assert.equal(cached.state.editorial.sourceRequestId, receipt.requestId);
  assert.equal(cached.state.editorial.operationId, "native-operation");
  assert.equal(cached.state.editorial.knownCostUsd, 0);
  assert.equal(cached.state.editorial.sourceKnownCostUsd, 0.0002);
  assert.deepEqual(cached.state.editorial.requestedOperationIds, []);
  assert.deepEqual(cached.state.editorial.sourceOperationIds, ["native-operation"]);
  assert.equal(cached.state.editorial.choiceQuestionDigest, receipt.choiceQuestionDigest);
  assert.equal(cached.state.editorial.questionDigest, receipt.questionDigest);
  assert.deepEqual(
    [cached.state.editorial.questionsCount, cached.state.editorial.choiceCount, cached.state.editorial.noulCount],
    [8, 6, 2],
  );
  assert.ok(cached.state.editorialHistory.every((entry) => entry.choiceQuestionDigest === receipt.choiceQuestionDigest));
  assert.equal(cached.decisions.check_a.noul, 0.37123456789);
  assert.equal(cached.state.issue.revision, issue.revision);
  const historyLength = cached.state.editorialHistory.length;
  for (let poll = 0; poll < 5; poll++) await editorial.review({ movedStoryId: "a" });
  assert.equal(store.snapshot().editorialHistory.length, historyLength);
  assert.equal(chatCalls, 1);
  assert.equal(nativeCalls, 1);

  // A new revision with identical treatment can reuse the answer without losing its source.
  store.change((state) => { state.issue.title = "New masthead"; });
  const reapplied = await editorial.review({ movedStoryId: "a" });
  assert.equal(reapplied.cached, true);
  assert.equal(reapplied.state.issue.stories[0].factCheck.cached, true);
  assert.equal(reapplied.state.issue.stories[0].factCheck.sourceRequestId, receipt.requestId);
  assert.equal(reapplied.state.issue.stories[0].factCheck.requestId, reapplied.requestId);
  assert.equal(nativeCalls, 1);
});

test("invalid answers fail before caching/applying, and no-op polls cannot redispatch a failed request", async () => {
  for (const invalid of ["probabilities", "unknown choice", "sentence style", "question set", "model"]) {
    const { store, trace } = setup();
    let calls = 0;
    const gateway = { model: generalModel, completeText(args) {
      calls++;
      const result = chatResult(args);
      const body = JSON.parse(result.text);
      if (invalid === "probabilities") body.answers.layout.confidence = 0.9;
      if (invalid === "unknown choice") body.answers.layout.choice = "rewrite_everything";
      if (invalid === "sentence style")
        body.answers[Object.keys(body.answers).find((id) => id.startsWith("style_"))].choice = "invented_style";
      if (invalid === "question set") body.answers.extra = { type: "noul", noul: 0.2 };
      if (invalid === "model") result.model = "fixture/different-general";
      return { ...result, text: JSON.stringify(body), usage: { cost: 0.0001 } };
    } };
    const editorial = createEditorial({ store, trace, gateway });
    const before = store.snapshot().issue;
    await assert.rejects(editorial.review());
    assert.equal(store.snapshot().editorial.status, "failed", invalid);
    assert.equal(store.snapshot().editorial.knownCostUsd, 0.0001);
    assert.deepEqual(store.snapshot().issue, before);
    for (let poll = 0; poll < 3; poll++) await assert.rejects(editorial.review());
    store.change((state) => { state.issue.title = "Unchanged treatment"; });
    await assert.rejects(editorial.review());
    assert.equal(calls, 1);
    assert.equal(store.snapshot().editorial.phase, "reused_failure");
    assert.equal(store.snapshot().editorial.knownCostUsd, 0);
    assert.equal(store.snapshot().editorial.sourceKnownCostUsd, 0.0001);
    assert.equal(store.snapshot().editorial.unreportedCostCount, 0);
  }
});

test("a rejected native call reports running then failed without treating SDK cost estimates as charges", async () => {
  const { store, trace } = setup("final");
  const started = deferred(), response = deferred();
  const editorial = createEditorial({ store, trace, gateway: {
    decide(args) { started.resolve(args); return response.promise; },
  } });
  const pending = editorial.review();
  const failure = assert.rejects(pending, /Synthetic rejected request/);
  await started.promise;
  assert.equal(store.snapshot().editorial.status, "running");
  response.reject(Object.assign(new Error("Synthetic rejected request"), {
    operationId: "failed-operation", model: nativeSnapshot,
    usage: { input_tokens: 12 }, sdkUsage: { cost: { total: 100 } },
  }));
  await failure;
  const receipt = store.snapshot().editorial;
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.operationId, "failed-operation");
  assert.equal(receipt.model, nativeSnapshot);
  assert.equal("knownCostUsd" in receipt, false);
  assert.equal(store.snapshot().issue.revision, 7);
});

test("pending results are rejected after input, issue identity, stage, or selected model changes, including switches back", async () => {
  const inputChanges = ["copy", "frame", "lock", "focus", "evidence"];
  for (const change of [...inputChanges, "issue identity", "stage", "chat model", "decision model", "gateway model", "stage back"]) {
    const { store, trace } = setup();
    const started = deferred(), response = deferred();
    const gateway = {
      model: generalModel,
      completeText(args) { started.resolve(args); return response.promise; },
    };
    const editorial = createEditorial({ store, trace, gateway });
    const pending = editorial.review();
    const args = await started.promise;
    store.change((state) => {
      if (change === "copy") state.issue.stories[0].body = "Human revision.";
      if (change === "frame") state.issue.stories[1].frame.x += 5;
      if (change === "lock") state.issue.stories[1].locked = true;
      if (change === "focus") state.issue.focus = "Changed editorial focus";
      if (change === "evidence") state.issue.sources[0].text = "The cited evidence changed.";
      if (change === "issue identity") state.issue.id = "another-issue";
      if (change.startsWith("stage")) state.settings.stage = "tools";
      if (change === "chat model") state.settings.model = "fixture/new-general";
      if (change === "decision model") state.settings.decisionModel = "perplexity/pplx-decider-v1.1-27b";
      if (change === "gateway model") gateway.model = "fixture/new-selection";
    }, { revision: inputChanges.includes(change) });
    if (change === "stage back")
      store.change((state) => { state.settings.stage = "editor"; }, { revision: false });
    assert.equal(store.snapshot().editorial.status, "superseded", change);
    const preserved = store.snapshot().issue;
    response.resolve(chatResult(args));
    assert.equal((await pending).superseded, true, change);
    assert.deepEqual(store.snapshot().issue, preserved);
    assert.equal(store.snapshot().settings.editorLayout, undefined);
  }
});

test("only the newest queued revision executes, while history stays bounded and stale completion cannot replace pending UI", async () => {
  const { store, trace } = setup();
  const firstStarted = deferred(), lastStarted = deferred(), firstResponse = deferred(), lastResponse = deferred();
  const calls = [];
  const editorial = createEditorial({ store, trace, gateway: {
    model: generalModel,
    completeText(args) {
      calls.push(args);
      if (calls.length === 1) { firstStarted.resolve(args); return firstResponse.promise; }
      lastStarted.resolve(args); return lastResponse.promise;
    },
  } });
  const first = editorial.review();
  const firstArgs = await firstStarted.promise;
  const queued = [];
  for (let index = 0; index < 15; index++) {
    store.change((state) => { state.issue.focus = `Changed focus ${index}`; });
    queued.push(editorial.review());
  }
  const latestId = store.snapshot().editorial.requestId;
  assert.equal(store.snapshot().editorial.phase, "queued");
  assert.equal(store.snapshot().editorial.status, "running");
  assert.equal(editorial.review(), queued.at(-1));
  assert.equal(calls.length, 1);
  firstResponse.resolve(chatResult(firstArgs));
  assert.equal((await first).superseded, true);
  const latestArgs = await lastStarted.promise;
  assert.equal(store.snapshot().editorial.requestId, latestId);
  assert.equal(store.snapshot().editorial.status, "running");
  assert.equal(JSON.parse(latestArgs.messages.at(-1).content).state.focus, "Changed focus 14");
  lastResponse.resolve(chatResult(latestArgs));
  const results = await Promise.all(queued);
  assert.ok(results.slice(0, -1).every((result) => result.superseded));
  assert.equal(results.at(-1).state.editorial.status, "complete");
  assert.equal(calls.length, 2);
  assert.equal(store.snapshot().editorialHistory.length, 12);
});

test("diagnostic capture failures do not interrupt valid decisions, cache reuse, or activity notifications", async () => {
  for (const failedMethod of ["start", "record", "finish"]) {
    const trace = {
      start() {
        if (failedMethod === "start") throw new Error("Synthetic diagnostic storage failure");
        return { id: "synthetic-span", finish() {
          if (failedMethod === "finish") throw new Error("Synthetic diagnostic summary failure");
        } };
      },
      record() { if (failedMethod === "record") throw new Error("Synthetic diagnostic cache failure"); },
    };
    const { store } = setup("editor", trace);
    let calls = 0;
    const editorial = createEditorial({ store, trace, gateway: {
      model: generalModel, completeText(args) { calls++; return chatResult(args); },
    } });
    assert.equal((await editorial.review()).state.editorial.status, "complete");
    assert.equal((await editorial.review()).cached, true);
    assert.equal(calls, 1);
  }
});

test("Choice questions depend on the moved story and native adds only the verification proposition", () => {
  const { store } = setup();
  const input = buildEditorialInput(store.snapshot(), { movedStoryId: "a" });
  const chat = buildEditorialQuestions(input);
  const native = buildEditorialQuestions(input, { noulBars: true });
  assert.deepEqual(Object.keys(chat).slice(0, 3), ["layout", "reaction", "lead"]);
  const styleQuestions = Object.entries(chat).filter(([id]) => id.startsWith("style_"));
  assert.equal(styleQuestions.length, 1);
  assert.deepEqual(styleQuestions[0][1].criteria, SENTENCE_STYLE_CRITERIA);
  assert.equal(Object.keys(styleQuestions[0][1].criteria).length, 24);
  assert.match(styleQuestions[0][1].instructions, /available frame/);
  assert.match(styleQuestions[0][1].instructions, /visibly expressive, readable hierarchy/);
  assert.ok(chat.reaction.criteria.related_b);
  assert.ok(chat.reaction.criteria.counterpoint_b);
  assert.equal(chat.reaction.criteria.related_a, undefined);
  assert.deepEqual(native.layout, chat.layout);
  assert.deepEqual(native.reaction, chat.reaction);
  assert.deepEqual(native.lead, chat.lead);
  assert.deepEqual(native.layout_cleanup, chat.layout_cleanup);
  assert.deepEqual(native.layout_basis, chat.layout_basis);
  assert.deepEqual(Object.keys(chat.layout_cleanup.criteria), ["keep", "offer_tidy"]);
  assert.equal(native.check_a.type, "noul");
  assert.match(native.check_a.criteria.true, /additional factual verification/);
  assert.equal("correctness" in native.check_a.criteria, false);
});

test("batch plans cover the whole question set within native limits and the chat answer budget", () => {
  const { store } = setup();
  store.change((state) => {
    state.issue.stories[1].body = Array.from({ length: 130 }, (_, index) => `This is sentence number ${index}.`).join(" ");
  });
  const input = buildEditorialInput(store.snapshot());
  const shared = buildEditorialQuestions(input);
  const native = buildEditorialQuestions(input, { noulBars: true });
  const chatBatches = buildEditorialBatches(shared, { backend: "chat", maxTokens: 4096 });
  const nativeBatches = buildEditorialBatches(native, { backend: "decisions" });
  assert.equal(Object.keys(shared).length, 134);
  assert.equal(Object.keys(native).length, 136);
  assert.ok(nativeBatches.length > 2);
  assert.ok(chatBatches.length > nativeBatches.length);
  assert.deepEqual(Object.assign({}, ...chatBatches), shared);
  assert.deepEqual(Object.assign({}, ...nativeBatches), native);
  for (const batch of [...chatBatches, ...nativeBatches]) {
    assert.ok(Object.keys(batch).length <= 128);
    assert.ok(Object.keys(batch).every((id) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(id)));
  }
  for (const batch of chatBatches)
    assert.ok(Buffer.byteLength(JSON.stringify({ answers: answersFor(batch) })) < 4096);
});

test("batched typography retains all offsets, actual operations and partial cost knowledge, and remains cached", async () => {
  const { store, trace } = setup("final");
  store.change((state) => {
    state.issue.stories[1].body = Array.from({ length: 45 }, (_, index) => `This is sentence number ${index}.`).join(" ");
    state.issue.stories[1].contentVersion++;
    state.issue.stories[0].typography = {
      contentVersion: 3, styles: { s0: "small_underline" },
      sentences: sentenceSegments(state.issue.stories[0].body).map(({ id, start, end }) => ({ id, start, end })),
    };
  });
  const before = store.snapshot().issue;
  const starts = [deferred(), deferred()], responses = [deferred(), deferred()], calls = [];
  const editorial = createEditorial({ store, trace, gateway: {
    decide(args) {
      const index = calls.length;
      calls.push(args); starts[index].resolve(args);
      return responses[index].promise;
    },
  } });
  const pending = editorial.review();
  const first = await starts[0].promise;
  assert.equal(store.snapshot().editorial.batchCount, 2);
  assert.equal(store.snapshot().editorial.status, "running");
  assert.ok(Object.keys(first.questions).length < 128);
  responses[0].resolve({
    answers: answersFor(first.questions), model: nativeSnapshot, operationId: "native-1",
    usage: { input_tokens: 100, cost: 0.0002 },
  });
  const second = await starts[1].promise;
  assert.equal(store.snapshot().editorial.completedBatchCount, 1);
  assert.equal(store.snapshot().editorial.requestedBatchCount, 2);
  assert.deepEqual(store.snapshot().issue, before);
  responses[1].resolve({
    answers: answersFor(second.questions), model: nativeSnapshot, operationId: "native-2",
    usage: { input_tokens: 101 },
  });
  const result = await pending, receipt = result.state.editorial;
  const typography = result.state.issue.stories[1].typography;
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.typographyQuestionCount, 45);
  assert.equal(receipt.completedBatchCount, 2);
  assert.deepEqual(receipt.operationIds, ["native-1", "native-2"]);
  assert.equal(receipt.operationId, undefined);
  assert.equal(receipt.knownCostUsd, 0.0002);
  assert.equal(receipt.unreportedCostCount, 1);
  assert.equal(Object.keys(typography.styles).length, 45);
  assert.equal(typography.contentVersion, before.stories[1].contentVersion);
  assert.deepEqual(typography.sentences,
    sentenceSegments(before.stories[1].body).map(({ id, start, end }) => ({ id, start, end })));
  assert.equal(typography.sentences[0].start, 0);
  assert.equal(typography.sentences.at(-1).end, before.stories[1].body.length);
  assert.ok(typography.sentences.every((sentence) => !Object.hasOwn(sentence, "text")));
  assert.deepEqual(result.state.issue.stories[0].typography, before.stories[0].typography);
  assert.equal(Object.keys(receipt.answers).some((id) => id.startsWith("style_")), false);
  const record = trace.entries.find((entry) => entry.id === receipt.requestId);
  assert.equal(record.result.batching, "editorial.v1");
  assert.equal(record.result.batches.length, 2);
  assert.equal(Object.keys(record.result.answers).length, 52);
  const cached = await editorial.review();
  assert.equal(cached.cached, true);
  assert.equal(cached.state.editorial.cachedBatchCount, 2);
  assert.equal(cached.state.editorial.requestedBatchCount, 0);
  assert.deepEqual(cached.state.editorial.operationIds, ["native-1", "native-2"]);
  assert.deepEqual(cached.state.editorial.requestedOperationIds, []);
  assert.equal(cached.state.editorial.knownCostUsd, 0);
  assert.equal(cached.state.editorial.sourceKnownCostUsd, 0.0002);
  assert.equal(cached.state.editorial.unreportedCostCount, 0);
  assert.equal(cached.state.editorial.sourceUnreportedCostCount, 1);
  const cachedRecord = trace.entries.find((entry) => entry.id === cached.requestId);
  assert.equal(cachedRecord.usage.perOperation[0].usage.cost, 0.0002);
  assert.equal(cachedRecord.usage.perOperation[1].usage.input_tokens, 101);
  assert.ok(cachedRecord.usage.perOperation.every((operation) => operation.cached && !operation.requested));
  assert.equal(calls.length, 2);
});

test("a substantive input change stops later batches and reuses a validated batch when the input is restored", async () => {
  const { store, trace } = setup("final");
  store.change((state) => {
    state.issue.stories[1].body = Array.from({ length: 45 }, (_, index) => `This is sentence number ${index}.`).join(" ");
  });
  const started = deferred(), firstResponse = deferred(), calls = [];
  const editorial = createEditorial({ store, trace, gateway: {
    decide(args) {
      calls.push(args);
      if (calls.length === 1) { started.resolve(args); return firstResponse.promise; }
      return { answers: answersFor(args.questions), model: nativeSnapshot, operationId: "native-next", usage: { cost: 0.0001 } };
    },
  } });
  const firstReview = editorial.review(), first = await started.promise;
  const originalX = store.snapshot().issue.stories[1].frame.x;
  store.change((state) => { state.issue.stories[1].frame.x = originalX + 1; });
  store.change((state) => { state.issue.stories[1].frame.x = originalX; });
  firstResponse.resolve({ answers: answersFor(first.questions), model: nativeSnapshot, operationId: "native-old", usage: { cost: 0.0001 } });
  assert.equal((await firstReview).superseded, true);
  assert.equal(calls.length, 1);
  assert.equal(store.snapshot().issue.stories[1].typography, undefined);
  const next = await editorial.review();
  assert.equal(next.state.editorial.status, "complete");
  assert.equal(next.state.editorial.cachedBatchCount, 1);
  assert.equal(next.state.editorial.requestedBatchCount, 1);
  assert.deepEqual(next.state.editorial.operationIds, ["native-old", "native-next"]);
  assert.deepEqual(next.state.editorial.requestedOperationIds, ["native-next"]);
  assert.deepEqual(next.state.editorial.sourceOperationIds, ["native-old"]);
  assert.equal(next.state.editorial.knownCostUsd, 0.0001);
  assert.equal(next.state.editorial.sourceKnownCostUsd, 0.0001);
  assert.equal(next.state.editorial.unreportedCostCount, 0);
  assert.equal(calls.length, 2);
});

test("a failed later batch retains earlier costs and blocks no-op paid retries without applying partial typography", async () => {
  const { store, trace } = setup("final");
  store.change((state) => {
    state.issue.stories[1].body = Array.from({ length: 45 }, (_, index) => `This is sentence number ${index}.`).join(" ");
  });
  const before = store.snapshot().issue;
  let calls = 0;
  const editorial = createEditorial({ store, trace, gateway: {
    decide(args) {
      calls++;
      if (calls === 1)
        return { answers: answersFor(args.questions), model: nativeSnapshot, operationId: "completed-batch", usage: { cost: 0.0002 } };
      throw Object.assign(new Error("Synthetic later batch failed"), {
        model: nativeSnapshot, operationId: "failed-batch", usage: null,
      });
    },
  } });
  await assert.rejects(editorial.review(), /Synthetic later batch failed/);
  const receipt = store.snapshot().editorial;
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.completedBatchCount, 1);
  assert.equal(receipt.batchCount, 2);
  assert.deepEqual(receipt.operationIds, ["completed-batch", "failed-batch"]);
  assert.equal(receipt.knownCostUsd, 0.0002);
  assert.equal(receipt.unreportedCostCount, 1);
  assert.deepEqual(store.snapshot().issue, before);
  await assert.rejects(editorial.review(), /Synthetic later batch failed/);
  store.change((state) => { state.issue.title = "Same treatment"; });
  await assert.rejects(editorial.review(), /Synthetic later batch failed/);
  assert.equal(calls, 2);
  assert.deepEqual(store.snapshot().editorial.operationIds, receipt.operationIds);
  assert.equal(store.snapshot().editorial.knownCostUsd, 0);
  assert.equal(store.snapshot().editorial.sourceKnownCostUsd, receipt.knownCostUsd);
  assert.equal(store.snapshot().editorial.unreportedCostCount, 0);
  assert.equal(store.snapshot().editorial.sourceUnreportedCostCount, 1);
  assert.deepEqual(store.snapshot().editorial.requestedOperationIds, []);
});

test("layout cleanup is an actual common model choice with provenance; keep clears it without changing geometry", async () => {
  for (const stage of ["editor", "final"]) {
    const { store, trace } = setup(stage);
    let cleanup = "offer_tidy";
    const editorial = createEditorial({ store, trace, gateway: {
      model: generalModel,
      completeText(args) {
        const { questions } = JSON.parse(args.messages.at(-1).content);
        return { text: JSON.stringify({ answers: answersFor(questions, { layoutCleanup: cleanup }) }), model: generalModel };
      },
      decide({ questions }) {
        return { answers: answersFor(questions, { layoutCleanup: cleanup }), model: nativeSnapshot };
      },
    } });
    const frames = store.snapshot().issue.stories.map((story) => story.frame);
    const offered = await editorial.review();
    assert.equal(offered.state.settings.layoutCleanup, "offer_tidy");
    assert.equal(offered.state.settings.layoutCleanupRequestId, offered.requestId);
    assert.equal(offered.state.settings.layoutCleanupSourceRequestId, offered.requestId);
    assert.equal(offered.state.settings.layoutCleanupInputRevision, offered.state.editorial.inputRevision);
    assert.deepEqual(offered.state.issue.stories.map((story) => story.frame), frames);
    const captured = trace.entries.find((entry) => entry.id === offered.requestId);
    assert.equal(captured.payload.state.items.b.wordCount, 3);
    assert.equal(captured.payload.state.items.b.characterCount, Array.from("Attributed copy b.").length);
    cleanup = "keep";
    store.change((state) => { state.issue.focus = "Review the current spacing"; });
    const kept = await editorial.review();
    assert.equal(kept.state.settings.layoutCleanup, "keep");
    assert.equal(kept.state.settings.layoutCleanupRequestId, null);
    assert.equal(kept.state.settings.layoutCleanupSourceRequestId, null);
    assert.deepEqual(kept.state.issue.stories.map((story) => story.frame), frames);
  }
});

test("rapid moves and a stage switch discard old batches and eventually apply the latest native input", async () => {
  const { store, trace } = setup("editor");
  store.change((state) => {
    state.issue.stories[1].body = Array.from({ length: 45 }, (_, index) => `This is sentence number ${index}.`).join(" ");
  });
  const chatStarted = deferred(), chatResponse = deferred(), nativeCalls = [];
  let chatCalls = 0;
  const editorial = createEditorial({ store, trace, gateway: {
    model: generalModel, maxTokens: 4096,
    completeText(args) { chatCalls++; chatStarted.resolve(args); return chatResponse.promise; },
    decide(args) {
      nativeCalls.push(args);
      return {
        answers: answersFor(args.questions), model: nativeSnapshot,
        operationId: `latest-native-${nativeCalls.length}`, usage: { cost: 0.0001 },
      };
    },
  } });
  const oldReview = editorial.review({ movedStoryId: "b" });
  const oldArgs = await chatStarted.promise;
  const queued = [];
  store.change((state) => { state.settings.stage = "final"; });
  queued.push(editorial.review({ movedStoryId: "b" }));
  for (const x of [110, 120, 130, 140, 150]) {
    store.change((state) => { state.issue.stories[1].frame.x = x; });
    queued.push(editorial.review({ movedStoryId: "b" }));
  }
  const latestId = store.snapshot().editorial.requestId;
  chatResponse.resolve(chatResult(oldArgs));
  assert.equal((await oldReview).superseded, true);
  const results = await Promise.all(queued);
  assert.ok(results.slice(0, -1).every((result) => result.superseded));
  const latest = results.at(-1).state;
  assert.equal(latest.editorial.requestId, latestId);
  assert.equal(latest.editorial.status, "complete");
  assert.equal(latest.editorial.backend, "decisions");
  assert.equal(latest.editorial.cached, false);
  assert.equal(latest.editorial.requestedBatchCount, 2);
  assert.equal(chatCalls, 1);
  assert.equal(nativeCalls.length, 2);
  assert.ok(nativeCalls.every((args) => args.state.items.b.frame.x === 150));
  assert.equal(latest.issue.stories[1].frame.x, 150);
  assert.equal(Object.keys(latest.issue.stories[1].typography.styles).length, 45);
});


test("native batches obey model context sizing without dropping questions or state", () => {
  const questions = Object.fromEntries(Array.from({ length: 72 }, (_, i) => [`q${i}`,
    { type: "noul", instructions: "x".repeat(1600) }]));
  const state = { article: "x".repeat(10000) };
  const batches = buildEditorialBatches(questions, { backend: "decisions", state, model: "typesafe/jev-1.13" });
  assert.ok(batches.length > 1);
  assert.deepEqual(Object.assign({}, ...batches), questions);
  for (const batch of batches) assert.ok(Buffer.byteLength(JSON.stringify({ state, questions: batch })) < 64000 - 4096);
  assert.throws(() => buildEditorialBatches(questions, { backend: "decisions", state: "x".repeat(64000) }), /too large/);
});
