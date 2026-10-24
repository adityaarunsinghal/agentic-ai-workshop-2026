import test from "node:test";
import assert from "node:assert/strict";
import { createIssueStore, storyWordBudget } from "../../domain/store.mjs";
import { createTrace } from "../../trace.mjs";
import { createGateway } from "../gateway.mjs";
import { createResearchAgent } from "../runtime.mjs";
import { fixtureCompletion, sseResponse } from "../fixture.mjs";

async function setup(t, fixtureChat) {
  const trace = createTrace();
  const config = { mode: "fixture", fixture: true, model: "openai/gpt-6-luna", fixtureChat };
  const store = await createIssueStore({ trace, config });
  store.setStage("editor");
  const gateway = createGateway({ trace, config });
  const agent = createResearchAgent({
    store, trace, gateway, config,
    mcp: { listTools: async () => [], callTool: async () => assert.fail("No tools were exposed.") },
  });
  t.after(async () => { await agent.close(); await trace.close(); });
  return { store, agent, trace };
}

test("resizes coalesce and adapt existing copy in either direction without research", async (t) => {
  let requests = 0;
  const { store, agent } = await setup(t, ({ payload }) => {
    requests++;
    assert.equal(payload.tool_choice, "none");
    return fixtureCompletion(payload);
  });
  const source = { id: "source", title: "Supporting record", url: "https://example.invalid/source",
    evidenceLevel: "full-text", text: "The supplied evidence supports this existing explanation. ".repeat(40) };
  store.addSources([source]);
  const slot = store.reserveStory({ frame: { x: 12, y: 44, width: 180, height: 200 } });
  store.editStory(slot.slotId, { headline: "Retained headline", body: source.text });
  store.update((issue) => { issue.stories[0].sourceIds = [source.id]; });
  for (const width of [90, 84]) {
    store.moveStory(slot.slotId, { x: 12, y: 44, width, height: 50 });
    agent.resizeStory({ slotId: slot.slotId });
  }
  await agent.waitForIdle();
  const shortened = store.getStory(slot.slotId);
  assert.equal(requests, 1);
  assert.equal(shortened.headline, "Retained headline");
  assert.deepEqual(shortened.sourceIds, [source.id]);
  assert.ok(shortened.body.split(/\s+/u).length <= storyWordBudget(shortened.frame));
  store.moveStory(slot.slotId, { x: 12, y: 44, width: 180, height: 200 });
  agent.resizeStory({ slotId: slot.slotId });
  await agent.waitForIdle();
  assert.equal(requests, 2);
  assert.ok(store.getStory(slot.slotId).body.length > shortened.body.length);
});

test("manual edits made during an automatic resize remain authoritative", async (t) => {
  let begun, release;
  const started = new Promise((done) => { begun = done; });
  const held = new Promise((done) => { release = done; });
  const { store, agent } = await setup(t, async ({ payload }) => {
    begun();
    await held;
    return fixtureCompletion(payload);
  });
  const slot = store.reserveStory({ frame: { x: 12, y: 44, width: 84, height: 50 } });
  store.editStory(slot.slotId, { headline: "Manual headline", body: "Existing copy with retained meaning. ".repeat(30) });
  agent.resizeStory({ slotId: slot.slotId });
  const idle = agent.waitForIdle();
  await started;
  store.editStory(slot.slotId, { body: "My newer manual copy." });
  release();
  await idle;
  const current = store.getStory(slot.slotId);
  assert.equal(current.body, "My newer manual copy.");
  assert.ok(current.alternateDraft);
});

test("an early unsupported conclusion continues within the same research allowance", async (t) => {
  let requests = 0;
  const { store, agent } = await setup(t, ({ payload }) => {
    requests++;
    return requests === 1
      ? sseResponse({ content: "The narrow search did not verify this claim. An official page is still needed." }, "stop", payload.model)
      : fixtureCompletion(payload);
  });
  const slot = store.reserveStory({ prompt: "Research a grounded explanation.", frame: { x: 12, y: 44, width: 180, height: 200 } });
  agent.requestStory({ slotId: slot.slotId, prompt: slot.prompt });
  await agent.waitForIdle();
  assert.equal(requests, 2);
  assert.ok(store.getStory(slot.slotId).body);
  assert.equal(store.snapshot().jobs.at(-1).status, "completed");
});
