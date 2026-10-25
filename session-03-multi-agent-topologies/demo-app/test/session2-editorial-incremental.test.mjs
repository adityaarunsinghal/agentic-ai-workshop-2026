import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  buildEditorialInput, buildEditorialQuestions, buildEditorialBatches, createEditorial, TYPOGRAPHY_POLICY,
} from "../src/editorial.mjs";
import { projectEditorialInput, sentenceQuestionId, verificationQuestionId, editorialModelFamily } from "../src/editorial-scope.mjs";
import { sentenceSegments, storySentences, styledSentences, sentenceCss } from "../src/presentation.mjs";
import { createTrace } from "../src/trace.mjs";

const story = (id, body = `Finding ${id}. Context for ${id}.`) => ({
  id, slotId: id, headline: `Story ${id}`, body, contentVersion: 1,
  sourceIds: [id], section: "news", locked: false,
  frame: { x: 12, y: 44, width: 90, height: 100 },
});
function setup({ stage = "final", decisionLimits, ready, prepare = () => {} } = {}) {
  const state = {
    documentVersion: 1, issue: {
      id: "fixture", revision: 1, focus: "Research", audience: "builders",
      stories: [story("a"), story("b")], layoutTemplate: "newspaper", relationships: [],
      sources: ["a", "b", "c"].map((id) => ({
        id, title: `Source ${id}`, evidenceLevel: "full-text", text: `Evidence ${id}. `.repeat(50),
      })),
    },
    settings: { stage, model: "fixture/general", decisionModel: "typesafe/jev-1.13" },
    jobs: [], editorialHistory: [], suggestions: [],
  };
  prepare(state);
  const listeners = new Set(), calls = [];
  const store = {
    snapshot: () => structuredClone(state),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    updateActivity(patch) { Object.assign(state, structuredClone(patch)); for (const fn of listeners) fn(); },
    update(fn) { fn(state.issue, state); state.issue.revision++; for (const fn of listeners) fn(); },
  };
  const answer = (args) => {
    calls.push(structuredClone({ model: args.model, state: args.state, questions: args.questions }));
    for (const question of Object.values(args.questions))
      if (question.type === "choice") assert.ok(Object.keys(question.criteria).length >= 2);
    return {
      model: args.model, operationId: `fixture-operation-${calls.length}`, usage: { cost: 0.001 },
      answers: Object.fromEntries(Object.entries(args.questions).map(([id, question]) => [id,
        question.type === "noul" ? { type: "noul", noul: 0.2 } : {
          type: "choice", choice: {
            layout: "newspaper", lead: "a", reaction: "keep", layout_cleanup: "offer_tidy",
            layout_basis: "balanced_coverage",
          }[id] ?? "large_bold",
        },
      ])),
    };
  };
  const gateway = {
    model: "fixture/general", maxTokens: 4096, decisionLimits, ready,
    decide: answer,
    completeText(args) {
      const response = answer({ ...JSON.parse(args.messages.at(-1).content), model: args.model });
      return { ...response, json: { answers: response.answers } };
    },
  };
  return { store, calls, gateway, editorial: createEditorial({ store, gateway, trace: createTrace(), config: { maxDecisionRequests: 100 } }) };
}
const styles = (questions) => Object.keys(questions).filter((id) => id.startsWith("style_"));
const checks = (questions) => Object.keys(questions).filter((id) => id.startsWith("check_"));

test("position changes, additions and stages using the same model preserve unchanged story decisions", async () => {
  const app = setup();
  await app.editorial.review();
  assert.equal(app.calls.length, 1);
  const original = app.store.snapshot().issue.stories;
  app.store.update((issue) => { issue.stories[1].frame.x += 10; });
  const moved = await app.editorial.review({ movedStoryId: "b" });
  assert.equal(moved.state.editorial.typographyQuestionCount, 0);
  assert.deepEqual(checks(app.calls.at(-1).questions), []);
  assert.ok(Object.values(app.calls.at(-1).state.items).every((item) => !Object.hasOwn(item, "copy")));
  assert.deepEqual(moved.state.issue.stories.map((s) => [s.typography, s.factCheck]),
    original.map((s) => [s.typography, s.factCheck]));

  app.store.update((issue) => issue.stories.push(story("c")));
  const added = await app.editorial.review({ movedStoryId: "c" });
  assert.deepEqual(styles(app.calls.at(-1).questions), sentenceSegments(story("c").body)
    .map((s) => sentenceQuestionId("c", s.id)));
  assert.deepEqual(checks(app.calls.at(-1).questions), [verificationQuestionId("c")]);
  assert.equal(app.calls.at(-1).state.items.c.copy, story("c").body);
  assert.equal(app.calls.at(-1).state.items.a.copy, undefined);
  assert.deepEqual(added.state.issue.stories[0].typography, original[0].typography);
  app.store.update((_issue, state) => { state.settings.stage = "research"; });
  const switched = await app.editorial.review();
  assert.deepEqual(styles(app.calls.at(-1).questions), []);
  assert.deepEqual(switched.state.issue.stories.map((s) => [s.typography, s.factCheck]),
    added.state.issue.stories.map((s) => [s.typography, s.factCheck]));
});

test("width/height changes keep typography; evidence-only changes request Noul without restyling", async () => {
  const app = setup();
  await app.editorial.review();
  const before = app.store.snapshot().issue.stories;
  app.store.update((issue) => { issue.stories[1].frame.width += 12; issue.stories[1].frame.height += 20; });
  await app.editorial.reviewDraft({ reason: "Review resized story", movedStoryId: "b" });
  assert.deepEqual(styles(app.calls.at(-1).questions), []);
  assert.deepEqual(checks(app.calls.at(-1).questions), []);
  assert.deepEqual(app.store.snapshot().issue.stories[0].typography, before[0].typography);
  assert.deepEqual(app.store.snapshot().issue.stories[1].typography, before[1].typography);
  assert.deepEqual(app.store.snapshot().issue.stories[1].factCheck, before[1].factCheck);
  app.store.update((issue) => { issue.sources[1].text = "Changed evidence."; });
  await app.editorial.review();
  assert.deepEqual(checks(app.calls.at(-1).questions), [verificationQuestionId("b")]);
  assert.deepEqual(styles(app.calls.at(-1).questions), []);
  assert.deepEqual(app.store.snapshot().issue.stories[1].typography, before[1].typography);

  app.store.update((issue) => { issue.stories[1].body += " Newly fitted copy."; issue.stories[1].contentVersion++; });
  await app.editorial.reviewDraft({ reason: "Review resized copy and typography", movedStoryId: "b" });
  assert.equal(styles(app.calls.at(-1).questions).length, 3);
  assert.ok(styles(app.calls.at(-1).questions).every((id) => id.startsWith(sentenceQuestionId("b", ""))));
  assert.deepEqual(checks(app.calls.at(-1).questions), [verificationQuestionId("b")]);
});

test("valid previous typography signatures upgrade without re-requesting styles on restart", async () => {
  const first = setup();
  await first.editorial.review();
  const saved = first.store.snapshot(), input = buildEditorialInput(saved);
  for (const item of Object.values(input.items)) {
    const previousBasis = {
      policy: "story-typography.v2", id: item.id, focus: input.focus, audience: input.audience,
      headline: item.headline, copy: item.copy,
      evidence: item.evidence.map(({ retrievedAt, ...source }) => source),
      section: item.section, width: item.frame.width, height: item.frame.height,
    };
    saved.issue.stories.find((s) => s.id === item.id).typography.basisDigest =
      createHash("sha256").update(JSON.stringify(previousBasis)).digest("hex");
  }
  const restarted = setup({ prepare(state) { Object.assign(state, structuredClone(saved)); } });
  await restarted.editorial.review();
  assert.deepEqual(styles(restarted.calls.at(-1).questions), []);
  assert.deepEqual(checks(restarted.calls.at(-1).questions), []);
  for (const item of restarted.store.snapshot().issue.stories) {
    const previous = saved.issue.stories.find((s) => s.id === item.id).typography;
    assert.deepEqual(item.typography.styles, previous.styles);
    assert.equal(item.typography.requestId, previous.requestId);
  }
});

test("restoring earlier copy reuses its story and evidence decisions with original provenance", async () => {
  const app = setup();
  await app.editorial.review();
  const old = app.store.snapshot().issue.stories[1];
  app.store.update((issue) => {
    const s = issue.stories[1]; s.body = "A changed account. Another detail."; s.contentVersion++;
    delete s.typography; s.factCheck = { status: "pending", probability: null };
  });
  await app.editorial.review();
  app.store.update((issue) => {
    const s = issue.stories[1]; s.body = old.body; s.contentVersion++;
    delete s.typography; s.factCheck = { status: "pending", probability: null };
  });
  const restored = await app.editorial.review();
  assert.equal(restored.state.editorial.typographyQuestionCount, 0);
  assert.equal(restored.state.editorial.noulCount, 0);
  const result = restored.state.issue.stories[1];
  assert.equal(result.typography.requestId, old.typography.requestId);
  assert.equal(result.factCheck.requestId, old.factCheck.requestId);
  assert.equal(result.typography.contentVersion, result.contentVersion);
  assert.equal(result.factCheck.contentVersion, result.contentVersion);
  assert.deepEqual(result.typography.styles, old.typography.styles);
});

test("approved template is application-owned, and cleanup never starts another review", async () => {
  const app = setup();
  await app.editorial.review();
  app.store.update((issue) => { issue.layoutTemplate = "side_by_side"; });
  const id = app.editorial.layout.beginTemplate({ id: "approval", kind: "template" }, []);
  await app.editorial.layout.finishTemplate(id, async () => {});
  assert.equal(app.calls.at(-1).questions.layout, undefined);
  const state = app.store.snapshot();
  assert.equal(state.settings.editorLayout, "side_by_side");
  assert.equal(state.editorial.answers.layout, undefined);
  assert.equal(state.editorial.approvedTemplate, "side_by_side");
  assert.equal(state.editorial.layoutAuthority, "human_approved");
  const before = app.calls.length;
  app.editorial.layout.cleanup({ id, kind: "tidy" });
  assert.equal((await app.editorial.review()).layoutSettled, true);
  assert.equal(app.calls.length, before);
});

test("locked typography survives a changed frame", async () => {
  const app = setup();
  await app.editorial.review();
  const before = app.store.snapshot().issue.stories[1].typography;
  app.store.update((issue) => { issue.stories[1].locked = true; issue.stories[1].frame.width += 30; });
  await app.editorial.review();
  assert.deepEqual(app.store.snapshot().issue.stories[1].typography, before);
  assert.deepEqual(styles(app.calls.at(-1).questions), []);
});

test("saved styles keep original IDs and offsets while blank chunks receive no questions or render styles", async () => {
  const app = setup({ prepare(state) {
    const item = state.issue.stories[0];
    const chunks = ["Repeated finding.\n", "\n", "Repeated finding."];
    item.body = chunks.join("");
    let end = 0;
    item.typography = {
      contentVersion: item.contentVersion, model: "typesafe/jev-1.13-20260917", requestId: "original-style",
      styles: { s0: "large_bold", s1: "small_italic", s2: "medium_regular" },
      sentences: chunks.map((text, index) => {
        const part = { id: `s${index}`, start: end, end: end + text.length }; end += text.length; return part;
      }),
    };
  } });
  const before = app.store.snapshot().issue.stories[0];
  await app.editorial.review();
  const current = app.store.snapshot().issue.stories[0], typography = current.typography;
  assert.deepEqual(typography, before.typography);
  assert.equal(typography.requestId, "original-style");
  assert.deepEqual(storySentences(current).map(({ id }) => id), ["s0", "s2"]);
  const rendered = styledSentences(current);
  assert.equal(rendered.map((part) => part.text).join(""), current.body);
  assert.equal(rendered.find((part) => part.id === "s0").style.bold, true);
  assert.equal(rendered.find((part) => part.id === "s2").style.bold, false);
  assert.deepEqual(sentenceCss(rendered.find((part) => !part.text.trim()).style), {});
  assert.ok(styles(app.calls.at(-1).questions).every((id) => !id.startsWith(sentenceQuestionId("a", ""))));
});

test("sentence chunks contain real text and preserve all original whitespace and offsets", () => {
  const body = "\n  First sentence.\n\n\nSecond sentence. \n\n  ";
  const parts = sentenceSegments(body);
  assert.ok(parts.every((part) => part.text.trim()));
  assert.ok(parts.every((part) => part.text === body.slice(part.start, part.end)));
  assert.equal(styledSentences({ body }).map((part) => part.text).join(""), body);
  assert.deepEqual(sentenceSegments(" \n\t\n"), []);
});

test("invalid stored offsets cannot apply old style IDs to different text", () => {
  const item = story("a", "First sentence. Second sentence.");
  item.typography = {
    contentVersion: item.contentVersion, styles: { s0: "large_bold", s1: "large_bold" },
    sentences: [{ id: "s0", start: 0, end: 5 }, { id: "s1", start: 16, end: item.body.length }],
  };
  assert.ok(styledSentences(item).filter((part) => part.text.trim())
    .every((part) => part.style.size === "medium" && part.style.bold === false));
});

test("a first story's 22 native questions fit one request; Choice semantics are backend-independent", async () => {
  let resolved = false;
  const app = setup({
    ready() { resolved = true; return { model: "fixture/general" }; },
    decisionLimits() {
      assert.equal(resolved, true);
      return { contextTokens: 65536, maxRequestBytes: 61440, maxQuestions: 128, maxChoices: 32 };
    },
  });
  app.store.update((issue) => { issue.stories = [story("a", Array.from({ length: 16 }, (_, n) => `Finding ${n}.`).join(" "))]; });
  await app.editorial.review();
  assert.equal(app.calls.length, 1);
  assert.equal(Object.keys(app.calls[0].questions).length, 22);
  const input = buildEditorialInput(app.store.snapshot());
  const general = buildEditorialQuestions(input), native = buildEditorialQuestions(input, { noulBars: true });
  assert.deepEqual(Object.fromEntries(Object.entries(native).filter(([, q]) => q.type === "choice")), general);
  assert.deepEqual(projectEditorialInput(input, general, TYPOGRAPHY_POLICY),
    projectEditorialInput(input, native, TYPOGRAPHY_POLICY));
});

test("focused batches honor supplied limits and retain every answer without sending unneeded full stories", () => {
  const app = setup();
  const input = buildEditorialInput(app.store.snapshot());
  const questions = buildEditorialQuestions(input, { noulBars: true });
  const projectState = (questions) => projectEditorialInput(input, questions, TYPOGRAPHY_POLICY);
  const batches = buildEditorialBatches(questions, {
    backend: "decisions", model: "typesafe/jev-1.13", projectState,
    limits: { contextTokens: 65536, maxRequestBytes: 12000, maxQuestions: 3, maxChoices: 32 },
  });
  assert.deepEqual(Object.assign({}, ...batches), questions);
  assert.ok(batches.every((batch) => Object.keys(batch).length <= 3));
  assert.ok(batches.every((batch) => Buffer.byteLength(JSON.stringify({
    model: "typesafe/jev-1.13", state: projectState(batch), questions: batch,
  })) <= 12000 - 1024));
  assert.throws(() => buildEditorialBatches(questions, {
    backend: "decisions", projectState, limits: { maxChoices: 2 },
  }), /supported choice count/);
});

test("chat defaults to 32768 output capacity while respecting a negotiated lower ceiling", () => {
  const app = setup();
  app.store.update((issue) => {
    issue.stories = [story("a", Array.from({ length: 45 }, (_, n) => `Finding ${n}.`).join(" "))];
  });
  const questions = buildEditorialQuestions(buildEditorialInput(app.store.snapshot()));
  assert.equal(buildEditorialBatches(questions, { backend: "chat" }).length, 1);
  assert.ok(buildEditorialBatches(questions, { backend: "chat", maxTokens: 4096 }).length > 1);
});

async function settledKeep(app) {
  for (let tick = 0; tick < 20; tick++) {
    const receipt = app.store.snapshot().editorial;
    if (receipt?.reason === "Auto research kept revised copy" && receipt.status === "complete") return receipt;
    await new Promise(setImmediate);
  }
  assert.fail("The committed research copy did not receive its editorial review.");
}
function keepCopy(item, body) {
  item.body = body;
  item.contentVersion++;
  delete item.typography;
  item.factCheck = { ...item.factCheck, status: "stale" };
  item.research = { runId: `research-${item.id}`, contentVersion: item.contentVersion };
}

test("a committed auto-research Keep automatically reviews only its affected story once", async () => {
  const app = setup({ stage: "research" });
  await app.editorial.review();
  const before = app.store.snapshot().issue.stories[0];
  const calls = app.calls.length;
  // Mirrors applyResearchRevision's research_copy_kept domain mutation.
  app.store.update((issue) => keepCopy(issue.stories[1], "A newly supported finding. Important qualification."));
  const receipt = await settledKeep(app);
  assert.equal(app.calls.length, calls + 1);
  assert.deepEqual(receipt.scope.typographyStoryIds, ["b"]);
  assert.deepEqual(receipt.scope.verificationStoryIds, ["b"]);
  assert.deepEqual(app.store.snapshot().issue.stories[0].typography, before.typography);
  assert.deepEqual(app.store.snapshot().issue.stories[0].factCheck, before.factCheck);
  app.store.updateActivity({ jobs: [{ id: "research-b", phase: "research" }] });
  await new Promise(setImmediate);
  assert.equal(app.calls.length, calls + 1);
});

test("simultaneous Keeps coalesce, and cancellation retires a queued Keep review", async () => {
  const app = setup({ stage: "research" });
  await app.editorial.review();
  const calls = app.calls.length;
  app.store.update((issue) => keepCopy(issue.stories[0], "Updated first account."));
  app.store.update((issue) => keepCopy(issue.stories[1], "Updated second account."));
  const receipt = await settledKeep(app);
  assert.equal(app.calls.length, calls + 1);
  assert.deepEqual(receipt.scope.typographyStoryIds, ["a", "b"]);
  app.store.update((issue) => keepCopy(issue.stories[1], "A later saved account."));
  app.editorial.cancel();
  await new Promise(setImmediate);
  assert.equal(app.calls.length, calls + 1);
});

test("a retained-copy completion can advance content version without restyling identical copy", async () => {
  const app = setup();
  await app.editorial.review();
  const original = app.store.snapshot().issue.stories[1];
  app.store.update((issue) => {
    const item = issue.stories[1];
    item.contentVersion++;
    delete item.typography;
    item.factCheck = { ...item.factCheck, status: "pending" };
    item.fit = { status: "fit" };
  });
  const result = await app.editorial.reviewDraft({ reason: "Review resized copy and typography", movedStoryId: "b" });
  assert.equal(result.state.editorial.typographyQuestionCount, 0);
  assert.equal(result.state.editorial.noulCount, 0);
  const item = result.state.issue.stories[1];
  assert.equal(item.typography.requestId, original.typography.requestId);
  assert.equal(item.factCheck.requestId, original.factCheck.requestId);
  assert.equal(item.typography.contentVersion, item.contentVersion);
  assert.deepEqual(item.typography.styles, original.typography.styles);
});

test("general to Jev repeats shared Choice work, while Stage 3 to 4 and switching back reuse model-specific styles", async () => {
  const app = setup({ stage: "editor" });
  const general = await app.editorial.review();
  const generalQuestions = app.calls[0].questions;
  const generalStyles = general.state.issue.stories.map((s) => s.typography);
  const originalDecide = app.gateway.decide;
  app.gateway.decide = (args) => {
    const response = originalDecide(args);
    response.model = "typesafe/jev-1.13-20260917";
    for (const id of styles(args.questions)) response.answers[id].choice = "medium_italic";
    return response;
  };
  app.store.update((_issue, state) => { state.settings.stage = "final"; });
  app.editorial.cancel("Stage changed");
  const native = await app.editorial.review();
  assert.equal(app.calls.length, 2);
  assert.equal(native.state.editorial.typographyQuestionCount, 4);
  assert.equal(native.state.editorial.inputDigest, general.state.editorial.inputDigest);
  assert.equal(native.state.editorial.choiceQuestionDigest, general.state.editorial.choiceQuestionDigest);
  assert.deepEqual(Object.fromEntries(Object.entries(app.calls[1].questions)
    .filter(([, question]) => question.type === "choice")), generalQuestions);
  assert.deepEqual(app.calls[1].state, app.calls[0].state);
  const nativeStyles = native.state.issue.stories.map((s) => s.typography);
  assert.ok(nativeStyles.every((s) => s.model === "typesafe/jev-1.13-20260917"));

  app.store.update((_issue, state) => { state.settings.stage = "research"; });
  app.editorial.cancel("Stage changed");
  const fourth = await app.editorial.review();
  assert.equal(app.calls.length, 2);
  assert.equal(fourth.cached, true);
  assert.deepEqual(fourth.state.issue.stories.map((s) => s.typography), nativeStyles);

  app.store.update((_issue, state) => { state.settings.stage = "editor"; });
  app.editorial.cancel("Stage changed");
  const back = await app.editorial.review();
  assert.equal(app.calls.length, 2);
  assert.deepEqual(back.state.issue.stories.map((s) => s.typography), generalStyles);
  app.store.update((_issue, state) => { state.settings.stage = "final"; });
  const nativeAgain = await app.editorial.review();
  assert.equal(app.calls.length, 2);
  assert.deepEqual(nativeAgain.state.issue.stories.map((s) => s.typography), nativeStyles);
});

test("bootstrap model resolution replans styling before dispatch, rather than reusing the saved model's cache", async () => {
  const app = setup({ stage: "editor" });
  const first = await app.editorial.review();
  const earlier = first.state.issue.stories.map((s) => s.typography);
  app.gateway.model = null;
  app.gateway.ready = () => {
    app.gateway.model = "fixture/other-general";
    const state = app.store.snapshot();
    app.store.updateActivity({ settings: { ...state.settings, model: app.gateway.model } });
    return { model: app.gateway.model };
  };
  const changed = await app.editorial.review({ explicit: true });
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].model, "fixture/other-general");
  assert.equal(styles(app.calls[1].questions).length, 4);
  assert.equal(changed.state.editorial.scope.modelFamily, "fixture/other-general");
  assert.ok(changed.state.issue.stories.every((s) => s.typography.model === "fixture/other-general"));

  app.gateway.ready = undefined;
  app.gateway.model = "fixture/general";
  app.store.update((_issue, state) => { state.settings.model = app.gateway.model; });
  const restored = await app.editorial.review();
  assert.equal(app.calls.length, 2);
  assert.deepEqual(restored.state.issue.stories.map((s) => s.typography), earlier);
});

test("model-family matching collapses only accepted native dated snapshots", () => {
  assert.equal(editorialModelFamily("decisions", "typesafe/jev-1.13-20260917"), "typesafe/jev-1.13");
  assert.equal(editorialModelFamily("decisions", "typesafe/jev-1.13-20261317"), "typesafe/jev-1.13-20261317");
  assert.equal(editorialModelFamily("chat", "fixture/model-20260917"), "fixture/model-20260917");
  assert.equal(editorialModelFamily("chat", null), null);
});
