import test from "node:test";
import assert from "node:assert/strict";
import { stageProfile, STAGE_PROFILES } from "../src/stages.mjs";
import { createIssueStore } from "../src/domain/store.mjs";
import { createEditorial } from "../src/editorial.mjs";
import { createTrace } from "../src/trace.mjs";

async function setup(stage) {
  const trace = createTrace();
  const store = await createIssueStore({ trace, config: { mode: "fixture" } });
  store.addSources([{ id: "source", title: "Fixture", url: "https://example.org", text: "Fixture source", evidenceLevel: "article" }]);
  const slot = store.reserveStory({ prompt: "Fixture" });
  const job = store.startJob({ slotId: slot.slotId, prompt: "Fixture" });
  store.completeStory({ slotId: slot.slotId, requestId: job.id, baseContentVersion: 0, headline: "Attributed fixture", body: "A short fixture.", sourceIds: ["source"] });
  store.setStage(stage);
  return { trace, store };
}
const labels = () => ({
  layout: { type: "choice", choice: "newspaper" },
  reaction: { type: "choice", choice: "keep" },
  lead: { type: "choice", choice: "none" },
  layout_cleanup: { type: "choice", choice: "keep" },
  layout_basis: { type: "choice", choice: "balanced_coverage" },
});

test("teaching profiles add auto research after native editorial decisions", () => {
  assert.deepEqual(Object.keys(STAGE_PROFILES), ["tools", "editor", "final", "research"]);
  assert.equal(stageProfile("tools").apps, false);
  assert.equal(stageProfile("editor").editorialBackend, "chat");
  assert.equal(stageProfile("editor").noulBars, false);
  assert.equal(stageProfile("final").nativeDecisions, true);
  assert.equal(stageProfile("final").editorialBackend, "decisions");
  assert.equal(stageProfile("editor").apps, true);
  assert.equal(stageProfile("research").autoResearch, true);
  assert.equal(stageProfile("research").nativeDecisions, true);
  assert.equal(stageProfile("final").autoResearch, undefined);
});

test("tools stage performs no editorial inference", async () => {
  const { trace, store } = await setup("tools");
  let calls = 0;
  const editorial = createEditorial({
    store, trace, config: { maxDecisionRequests: 10 },
    gateway: { decide() { calls++; }, completeText() { calls++; } },
  });
  assert.equal((await editorial.review()).disabled, true);
  assert.equal(calls, 0);
});

test("editor stage uses the general model without fabricating Noul answers", async () => {
  const { trace, store } = await setup("editor");
  let chat = 0, native = 0;
  const editorial = createEditorial({
    store, trace, config: { maxDecisionRequests: 10 },
    gateway: {
      async completeText({ messages }) {
        chat++;
        const { questions } = JSON.parse(messages.at(-1).content);
        return { text: JSON.stringify({ answers: {
          ...labels(), ...Object.fromEntries(Object.entries(questions)
            .filter(([id]) => id.startsWith("style_"))
            .map(([id]) => [id, { type: "choice", choice: "medium_regular" }])),
        } }) };
      },
      async decide() { native++; },
    },
  });
  await editorial.review();
  assert.equal(chat, 1);
  assert.equal(native, 0);
  assert.equal(store.snapshot().settings.capabilities.noulBars, false);
});

test("final stage retains the native Noul proposition probability", async () => {
  const { trace, store } = await setup("final");
  const editorial = createEditorial({
    store, trace, config: { maxDecisionRequests: 10 },
    gateway: { async decide({ questions }) {
      return { answers: {
        ...labels(), ...Object.fromEntries(Object.entries(questions)
          .filter(([id]) => !Object.hasOwn(labels(), id))
          .map(([id, question]) => [id, question.type === "noul"
            ? { type: "noul", noul: 0.37 } : { type: "choice", choice: "medium_regular" }])),
      } };
    } },
  });
  await editorial.review();
  assert.equal(store.snapshot().issue.stories[0].factCheck.probability, 0.37);
});
