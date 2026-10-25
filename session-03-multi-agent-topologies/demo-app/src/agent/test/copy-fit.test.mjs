import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sseResponse } from "../fixture.mjs";
import { deferred, setup, storyRequest } from "./helpers.mjs";

const captured = JSON.parse(await readFile(new URL("./fixtures/dance-resize-overflow.json", import.meta.url)));
const correction = {
  headline: captured.headline,
  body: "AI dance projects offer several ways to preserve human creative control. MIT Media Lab’s Open Dance Lab uses principles from Pichet Klunchun’s analysis of Mae Bot Yai to animate a virtual dancer. Its platform offers 59 annotated 3D poses and generates sequences grounded in that vocabulary. The project treats digital preservation as a basis for experimentation, while recognizing that motion capture alone cannot record cultural context or tacit knowledge.\n\nA 2024 UC Santa Barbara prototype lets choreographers generate sequences from text and edit the motion in a web interface. Six choreographers assessed it; that small evaluation provides feedback, not proof of broad effectiveness. A 2025 preprint explores a different interaction: dancers’ movements influence the selection and combination of prerecorded music clips. Its pilot analysis suggests communication between dancer and system, without establishing a general-purpose agent.\n\nThese examples favor domain knowledge, editable results and human control. They invite cautious evaluation rather than claims that an AI choreographer can replace a person’s creative role.",
  sourceIds: captured.sourceIds,
};

async function setupResize(t, fixtureChat, { maxTurns = 10, maxWords = 248, onDraftComplete } = {}) {
  const app = await setup({ config: {
    maxTurns, measureStoryBudget: () => ({ maxWords }), fixtureChat,
  }, onDraftComplete });
  t.after(() => app.runtime.close());
  app.store.setStage("editor");
  app.store.addSources(captured.sourceIds.map((id) => ({
    id, title: "Recorded source reference", text: captured.body, evidenceLevel: "article-text",
  })));
  const slot = app.store.reserveStory({ prompt: "Dance and AI", frame: { x: 12, y: 44, width: 180, height: 120 } });
  app.store.editStory(slot.id, { headline: captured.headline, body: captured.body });
  app.store.update((issue) => {
    const current = issue.stories.find(story => story.slotId === slot.slotId);
    current.sourceIds = captured.sourceIds;
    current.typography = { contentVersion: current.contentVersion, styles: { s0: "large_bold" } };
  }, { history: false });
  const original = app.store.getStory(slot.id);
  const request = () => app.runtime.requestStory({
    slotId: slot.slotId, prompt: slot.prompt,
    resize: { headline: original.headline, body: original.body, sourceIds: original.sourceIds, frame: original.frame },
  });
  return { ...app, slot, original, request };
}

test("captured 281/248 resize is not committed until a bounded copy-only correction fits", async (t) => {
  let requests = 0, reviews = 0, app;
  app = await setupResize(t, ({ payload }) => {
    requests++;
    assert.equal((payload.tools ?? []).length, 0);
    assert.equal(app.store.getStory(app.slot.id).body, app.original.body);
    assert.deepEqual(app.store.getStory(app.slot.id).typography, app.original.typography);
    if (requests > 1)
      assert.match(JSON.stringify(payload.messages), /contains 281 words; this slot permits 248/);
    return sseResponse({ content: JSON.stringify(requests <= 2 ? captured : correction) }, "stop", payload.model);
  }, { onDraftComplete: () => { reviews++; } });
  const job = app.request();
  await app.runtime.waitForIdle();
  const result = app.store.snapshot().jobs.find(entry => entry.id === job.id);
  assert.equal(requests, 3);
  assert.equal(result.requestCount, 3);
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.equal(result.maxTurns, 3);
  assert.equal(app.store.getStory(app.slot.id).body, correction.body);
  assert.equal(app.store.getStory(app.slot.id).contentVersion, app.original.contentVersion + 1);
  assert.equal(app.store.getStory(app.slot.id).fit.status, "fit");
  assert.equal(app.calls.length, 0, "corrections never repeat research");
  assert.equal(reviews, 1, "only committed fitted copy receives editorial review");
  assert.equal(app.trace.entries.filter(entry => entry.kind === "story.fit_rewrite").length, 2);
});

test("exhausted fit recovery preserves copy and typography with an actionable incomplete result", async (t) => {
  let requests = 0, reviews = 0;
  const app = await setupResize(t, ({ payload }) => {
    requests++;
    return sseResponse({ content: JSON.stringify(captured) }, "stop", payload.model);
  }, { onDraftComplete: () => { reviews++; } });
  app.request();
  await app.runtime.waitForIdle();
  const result = app.store.snapshot().jobs.at(-1), slot = app.store.getStory(app.slot.id);
  assert.equal(requests, 3);
  assert.equal(result.status, "incomplete");
  assert.equal(result.phase, "needs_fit");
  assert.equal(result.error.code, "STORY_FIT");
  assert.equal(result.fit.words, 281);
  assert.equal(result.fit.maxWords, 248);
  assert.equal(result.retainedDraft.body, captured.body);
  assert.equal(result.recovery.action, "fit_copy");
  assert.equal(slot.status, "needs_fit");
  assert.equal(slot.body, app.original.body);
  assert.equal(slot.contentVersion, app.original.contentVersion);
  assert.deepEqual(slot.typography, app.original.typography);
  assert.match(slot.researchNote, /Enlarge the block/);
  assert.equal(reviews, 0);
  assert.equal(app.trace.entries.some(entry => entry.kind === "story.draft"), false);
});

test("fitting cannot create extra turns when the existing allowance is exhausted", async (t) => {
  let requests = 0;
  const app = await setupResize(t, ({ payload }) => {
    requests++;
    return sseResponse({ content: JSON.stringify(captured) }, "stop", payload.model);
  }, { maxTurns: 1 });
  app.request();
  await app.runtime.waitForIdle();
  assert.equal(requests, 1);
  assert.equal(app.store.snapshot().jobs.at(-1).phase, "needs_fit");
  assert.equal(app.store.getStory(app.slot.id).body, app.original.body);
});

test("manual copy written during a fit correction remains authoritative", async (t) => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let requests = 0;
  const app = await setupResize(t, async ({ payload }) => {
    if (++requests === 1)
      return sseResponse({ content: JSON.stringify(captured) }, "stop", payload.model);
    entered.resolve();
    await release.promise;
    return sseResponse({ content: JSON.stringify(correction) }, "stop", payload.model);
  });
  app.request();
  await entered.promise;
  app.store.editStory(app.slot.id, { body: "My newer manual copy." });
  release.resolve();
  await app.runtime.waitForIdle();
  const slot = app.store.getStory(app.slot.id);
  assert.equal(slot.body, "My newer manual copy.");
  assert.equal(slot.alternateDraft.body, correction.body);
  assert.equal(app.store.snapshot().jobs.at(-1).phase, "alternate");
  assert.equal(app.calls.length, 0);
});

test("cancelling a fit correction cannot insert a late draft or trigger another correction", async (t) => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let requests = 0;
  const app = await setupResize(t, async ({ payload }) => {
    if (++requests === 1)
      return sseResponse({ content: JSON.stringify(captured) }, "stop", payload.model);
    entered.resolve();
    await release.promise;
    return sseResponse({ content: JSON.stringify(correction) }, "stop", payload.model);
  });
  const job = app.request();
  await entered.promise;
  app.runtime.cancelStory(job.id);
  release.resolve();
  await app.runtime.waitForIdle();
  assert.equal(requests, 2);
  assert.equal(app.store.snapshot().jobs.at(-1).status, "cancelled");
  assert.equal(app.store.getStory(app.slot.id).body, app.original.body);
  assert.deepEqual(app.store.getStory(app.slot.id).typography, app.original.typography);
});

test("an explicit retry resumes the retained fit candidate without starting research again", async (t) => {
  let requests = 0;
  const app = await setupResize(t, ({ payload }) => {
    requests++;
    return sseResponse({ content: JSON.stringify(requests <= 3 ? captured : correction) }, "stop", payload.model);
  });
  app.request();
  await app.runtime.waitForIdle();
  const failed = app.store.snapshot().jobs.at(-1);
  const retry = app.runtime.requestStory({ slotId: app.slot.slotId, prompt: app.slot.prompt });
  await app.runtime.waitForIdle();
  assert.equal(requests, 4);
  assert.equal(app.calls.length, 0);
  assert.equal(app.store.snapshot().jobs.at(-1).status, "completed");
  assert.equal(app.store.getStory(app.slot.id).body, correction.body);
  assert.ok(app.trace.entries.some(entry => entry.kind === "story" &&
    entry.requestId === retry.id && entry.resumedFrom === failed.id));
});

test("an unchanged fitted response preserves its content version and existing typography", async (t) => {
  const app = await setupResize(t, ({ payload }) =>
    sseResponse({ content: JSON.stringify(captured) }, "stop", payload.model), { maxWords: 400 });
  app.request();
  await app.runtime.waitForIdle();
  const slot = app.store.getStory(app.slot.id), job = app.store.snapshot().jobs.at(-1);
  assert.equal(job.status, "completed");
  assert.equal(job.outcome.unchanged, true);
  assert.equal(slot.status, "ready");
  assert.equal(slot.contentVersion, app.original.contentVersion);
  assert.deepEqual(slot.typography, app.original.typography);
});

test("enlarging an empty needs-fit block can resume its candidate instead of losing the collected research", async (t) => {
  let requests = 0, sourceIds;
  const app = await setup({ tools: [], config: {
    maxTurns: 1, measureStoryBudget: () => ({ maxWords: 248 }),
    fixtureChat: ({ payload }) => {
      requests++;
      if (requests === 1) sourceIds = [storyRequest(payload).sources[0].id];
      else {
        assert.ok(payload.messages.some(message => message.content?.startsWith?.("Resize request:")));
        assert.equal((payload.tools ?? []).length, 0);
      }
      return sseResponse({ content: JSON.stringify({
        ...(requests === 1 ? captured : correction), sourceIds,
      }) }, "stop", payload.model);
    },
  } });
  t.after(() => app.runtime.close());
  app.store.setStage("editor");
  const slot = app.store.reserveStory({ prompt: "Dance and AI" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: slot.prompt });
  await app.runtime.waitForIdle();
  assert.equal(app.store.getStory(slot.id).status, "needs_fit");
  assert.equal(app.store.getStory(slot.id).body, "");
  const current = app.store.getStory(slot.id);
  app.store.moveStory(slot.id, { ...current.frame, height: current.frame.height + 10 });
  assert.equal(app.runtime.resizeStory({ slotId: slot.slotId }).scheduled, true);
  await app.runtime.waitForIdle();
  assert.equal(requests, 2);
  assert.equal(app.store.getStory(slot.id).body, correction.body);
  assert.deepEqual(app.store.getStory(slot.id).sourceIds, sourceIds);
  assert.equal(app.calls.length, 0);
});
