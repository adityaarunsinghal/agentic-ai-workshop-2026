import assert from "node:assert/strict";
import test from "node:test";
import { createResearchAgent } from "../runtime.mjs";
import { sseResponse } from "../fixture.mjs";
import { setup } from "./helpers.mjs";
import { layoutMeasurementKey } from "../../../ui/src/shared/geometry.mjs";
import { mergeSnapshots } from "../../../ui/src/shared/state.mjs";

const initialBody = Array(57).fill("Synthetic").join(" ");
const frame = { x: 151.5, y: 44, width: 75, height: 65 };
function report(app, values = {}) {
  const state = app.store.snapshot(), story = state.issue.stories[0];
  return {
    issueId: state.issue.id, slotId: story.slotId, contentVersion: story.contentVersion,
    frame: story.frame, key: layoutMeasurementKey(story), overflow: true,
    bodyHeight: 200, availableBodyHeight: 100, minimumLineHeight: 24, requiredHeight: 95,
    ...values,
  };
}

async function renderedApp(t, fixtureChat) {
  let app;
  const completions = [];
  app = await setup({ tools: [], config: {
    measureStoryBudget: () => ({ maxWords: 250 }), fixtureChat,
  }, onDraftComplete: (completion) => {
    completions.push(completion);
    const { slotId } = completion;
    // Replay the fixture's explicit large_bold decision on the revised copy.
    app.store.update((issue) => {
      const story = issue.stories.find(story => story.slotId === slotId);
      story.typography = { contentVersion: story.contentVersion, styles: { s0: "large_bold" },
        sentences: [{ id: "s0", start: 0, end: story.body.length }] };
    }, { history: false });
  } });
  t.after(() => app.runtime.close());
  app.store.setStage("editor");
  app.store.addSources([{ id: "observed", title: "Synthetic evidence", text: initialBody, evidenceLevel: "article-text" }]);
  const slot = app.store.reserveStory({ frame, prompt: "Synthetic story" });
  app.store.editStory(slot.slotId, { headline: "Synthetic story 3", body: initialBody });
  app.store.update((issue) => {
    const story = issue.stories[0];
    story.sourceIds = ["observed"];
    story.typography = { contentVersion: story.contentVersion, styles: { s0: "large_bold" },
      sentences: [{ id: "s0", start: 0, end: story.body.length }] };
  }, { history: false });
  return { ...app, slot, completions };
}

test("rendered overflow of a 57-word large-bold story tightens the fit target without research", async (t) => {
  let calls = 0, app;
  app = await renderedApp(t, ({ payload }) => {
    calls++;
    const input = JSON.parse(payload.messages.find(message => message.content?.startsWith?.("Resize request:")).content.split("\n").slice(1).join("\n"));
    assert.equal(input.target.maximumWords, 24, "rendered height overrides the generic 250-word estimate");
    assert.equal(payload.tools, undefined);
    assert.equal(payload.tool_choice, "none");
    assert.equal(app.store.getStory(app.slot.id).body, initialBody);
    assert.equal(app.store.getStory(app.slot.id).typography.styles.s0, "large_bold");
    return sseResponse({ content: JSON.stringify({
      headline: input.copy.headline, body: "Synthetic evidence remains provisional.", sourceIds: input.copy.sourceIds,
    }) }, "stop", payload.model);
  });
  app.store.update((issue, state) => {
    issue.layoutTemplate = "newspaper";
    state.layoutOperation = { id: "approved-rendered-layout", approvedTemplate: "newspaper", status: "complete" };
  }, { history: false });
  const started = app.runtime.reportRenderedFit(report(app));
  assert.equal(started.status, "fitting");
  for (let i = 0; i < 20; i++) app.runtime.reportRenderedFit(report(app));
  await app.runtime.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(app.completions[0].origin, "rendered_fit");
  assert.equal(app.completions[0].layoutOperationId, "approved-rendered-layout");
  assert.equal(app.store.snapshot().jobs.at(-1).status, "completed",
    JSON.stringify(app.store.snapshot().jobs.at(-1).error));
  assert.equal(app.calls.length, 0);
  assert.equal(app.store.getStory(app.slot.id).renderedFit.status, "awaiting_measurement");
  assert.equal(app.store.getStory(app.slot.id).typography.styles.s0, "large_bold");
  assert.equal(app.store.snapshot().jobs.at(-1).phase, "awaiting_render");
  const fitted = app.runtime.reportRenderedFit(report(app, { overflow: false, bodyHeight: 48 }));
  assert.equal(fitted.status, "fit");
  assert.equal(app.store.getStory(app.slot.id).status, "ready");
  assert.equal(app.store.snapshot().jobs.at(-1).phase, "completed");
  assert.deepEqual(app.store.getStory(app.slot.id).sourceIds, ["observed"]);
});

test("self-rewrites and repeated reports share two rendered passes, including after runtime replacement", async (t) => {
  let calls = 0;
  const app = await renderedApp(t, ({ payload }) => {
    const body = Array(++calls === 1 ? 20 : 6).fill("Synthetic").join(" ");
    return sseResponse({ content: JSON.stringify({ headline: "Synthetic story", body, sourceIds: ["observed"] }) }, "stop", payload.model);
  });
  app.runtime.reportRenderedFit(report(app));
  await app.runtime.waitForIdle();
  const first = app.store.getStory(app.slot.id).renderedFit;
  app.runtime.reportRenderedFit(report(app));
  await app.runtime.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(app.store.getStory(app.slot.id).renderedFit.id, first.id);
  assert.equal(app.store.getStory(app.slot.id).renderedFit.attempts, 2);
  const beforeRender = app.store.snapshot();
  await app.runtime.close();
  const resumed = createResearchAgent({
    store: app.store, trace: app.trace, gateway: app.gateway,
    mcp: { listTools: async () => assert.fail("No research"), callTool: async () => assert.fail("No research") },
  });
  t.after(() => resumed.close());
  const exhausted = resumed.reportRenderedFit(report(app));
  assert.equal(exhausted.status, "needs_fit");
  for (let i = 0; i < 50; i++) resumed.reportRenderedFit(report(app, { bodyHeight: 200 + i }));
  await resumed.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(app.store.getStory(app.slot.id).body.split(" ").length, 6);
  assert.equal(app.store.getStory(app.slot.id).typography.styles.s0, "large_bold");
  assert.equal(app.store.getStory(app.slot.id).status, "needs_fit");
  assert.equal(app.store.snapshot().jobs.at(-1).status, "incomplete");
  assert.equal(mergeSnapshots(beforeRender, app.store.snapshot()).jobs.at(-1).phase, "needs_fit");
  assert.match(app.store.getStory(app.slot.id).researchNote, /Enlarge this block, approve a layout adjustment/);
});

test("stale copy/frame reports and physically unavailable space dispatch no inference", async (t) => {
  let calls = 0;
  const app = await renderedApp(t, () => { calls++; assert.fail("No inference expected."); });
  assert.equal(app.runtime.reportRenderedFit(report(app, { contentVersion: 999 })).accepted, false);
  assert.equal(app.runtime.reportRenderedFit(report(app, { frame: { ...frame, width: 80 } })).accepted, false);
  const original = app.store.getStory(app.slot.id);
  const result = app.runtime.reportRenderedFit(report(app, { availableBodyHeight: 0 }));
  assert.equal(result.status, "needs_fit");
  for (let i = 0; i < 20; i++) app.runtime.reportRenderedFit(report(app));
  assert.throws(() => app.runtime.requestStory({ slotId: app.slot.slotId, prompt: app.slot.prompt }), { code: "STORY_FIT" });
  await app.runtime.waitForIdle();
  assert.equal(calls, 0);
  assert.equal(app.store.getStory(app.slot.id).body, original.body);
  assert.deepEqual(app.store.getStory(app.slot.id).typography, original.typography);
  app.store.moveStory(app.slot.id, { ...frame, height: 140 });
  assert.equal(app.runtime.reportRenderedFit(report(app, { overflow: false })).status, "fit");
  assert.equal(app.store.getStory(app.slot.id).status, "ready");
});
