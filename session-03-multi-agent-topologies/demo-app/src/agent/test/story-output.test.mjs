import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDraft, normalizeResizeDraft, proseExplanation } from "../story.mjs";
import { sseResponse } from "../fixture.mjs";
import { setup, storyRequest } from "./helpers.mjs";

const message = (text) => ({ content: [{ type: "text", text }] });
const source = { id: "observed", title: "Synthetic source", text: "Synthetic observed evidence.", evidenceLevel: "article-text" };
const evidence = new Map([[source.id, source]]);
const snapshot = { issue: { sources: [source] } };

test("draft parsing repairs only literal string controls and still validates fields and observed evidence", () => {
  const draft = {
    headline: 'Synthetic "quoted" headline',
    body: 'A quoted "detail" and a slash \\\n\nA new paragraph\twith synthetic evidence.',
    sourceIds: [source.id],
  };
  const raw = JSON.stringify(draft).replaceAll("\\n", "\n").replaceAll("\\t", "\t");
  assert.throws(() => JSON.parse(raw));
  assert.deepEqual(normalizeDraft(message(raw), evidence, snapshot), draft);
  assert.deepEqual(normalizeDraft(message(`\`\`\`json\n${raw}\n\`\`\``), evidence, snapshot), draft);
  assert.deepEqual(normalizeResizeDraft(message(raw), draft), draft);
  assert.throws(() => normalizeResizeDraft(message(JSON.stringify({ ...draft, body: JSON.stringify(draft) })), draft), { code: "DRAFT" });
  assert.equal(proseExplanation(message(raw)), "");
  assert.throws(() => normalizeDraft(message(raw.replace('"observed"', '"invented"')), evidence, snapshot), { code: "EVIDENCE" });
  for (const malformed of [
    raw.slice(0, -1), raw.replace('"body":', '"body" '),
    raw.replace(',"sourceIds"', '\u0001,"sourceIds"'), "null",
    JSON.stringify({ ...draft, body: JSON.stringify(draft) }),
  ])
    assert.throws(() => normalizeDraft(message(malformed), evidence, snapshot), { code: "DRAFT" });
  const prose = "Synthetic headline\n[observed] An observed synthetic detail.";
  assert.equal(normalizeDraft(message(prose), evidence, snapshot).body, prose.split("\n")[1]);
  assert.equal(proseExplanation(message("The primary source is unavailable.")), "The primary source is unavailable.");
});

test("one shortening pass recovers unescaped JSON paragraphs after a 140-word write exceeds a 129-word slot", async () => {
  const body = `${Array(50).fill("Synthetic").join(" ")}\n\n${Array(53).fill("evidence").join(" ")}`;
  let raw;
  const app = await setup({ config: {
    measureStoryBudget: () => ({ maxWords: 129 }),
    fixtureChat: ({ payload, turn }) => {
      const context = storyRequest(payload);
      const call = (name, args) => sseResponse({ tool_calls: [{
        index: 0, id: `synthetic-${turn}`, type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }] }, "tool_calls", payload.model);
      if (turn === 1) return call("search_hn", { query: "Synthetic evidence" });
      if (turn === 2) return call("fetch_read", { sourceId: "fixture-search" });
      if (turn === 3) return call("write_story", {
        issueId: context.issueId, slotId: context.slotId, requestId: context.requestId,
        baseContentVersion: context.baseContentVersion, headline: "Synthetic headline",
        body: Array(140).fill("Synthetic").join(" "), sourceIds: ["fixture-read"],
      });
      assert.equal(turn, 4);
      assert.equal(payload.tools, undefined);
      assert.equal(payload.tool_choice, "none");
      assert.match(JSON.stringify(payload.messages), /contains 140 words; this slot permits 129/);
      raw = JSON.stringify({ headline: "Synthetic headline", body, sourceIds: ["fixture-read"] })
        .replaceAll("\\n", "\n");
      return sseResponse({ content: raw }, "stop", payload.model);
    },
  } });
  try {
    const slot = app.store.reserveStory({ prompt: "Synthetic research" });
    app.runtime.requestStory({ slotId: slot.slotId, prompt: "Synthetic research" });
    await app.runtime.waitForIdle();
    const job = app.store.snapshot().jobs[0], story = app.store.getStory(slot.id);
    assert.equal(job.status, "completed", JSON.stringify(job.error));
    assert.equal(job.requestCount, 4);
    assert.equal(story.body, body);
    assert.deepEqual(story.sourceIds, ["fixture-read"]);
    assert.equal(story.researchNote, undefined);
    assert.equal(job.partialText.length, 480);
    assert.equal(job.partialTextTruncated, true);
    assert.ok(job.partialTextCharacters >= raw.length);
    assert.equal(job.partialText, raw.slice(-480));
    assert.equal(app.trace.entries.some((entry) => entry.kind === "agent.message_end" &&
      entry.message?.role === "assistant" &&
      entry.message?.content?.some((part) => part.text === raw)), true, "retain original malformed output");
    assert.equal(app.trace.requests.length, 0);
  } finally { await app.runtime.close(); }
});

test("unrepairable structured output stays incomplete without becoming story copy or a research note", async () => {
  let raw, candidate;
  const app = await setup({ config: { maxTurns: 2, measureStoryBudget: () => ({ maxWords: 10 }),
    fixtureChat: ({ payload, turn }) => {
      const context = storyRequest(payload);
      if (turn === 1) {
        candidate = { headline: "Synthetic headline", body: Array(25).fill("Synthetic").join(" "), sourceIds: [context.sources[0].id] };
        return sseResponse({ tool_calls: [{
          index: 0, id: "synthetic-overflow", type: "function", function: { name: "write_story",
            arguments: JSON.stringify({
              issueId: context.issueId, slotId: context.slotId, requestId: context.requestId,
              baseContentVersion: context.baseContentVersion, ...candidate,
            }),
          },
        }] }, "tool_calls", payload.model);
      }
      raw = JSON.stringify({
        headline: "Synthetic headline", body: "Unfinished synthetic copy.",
        sourceIds: candidate.sourceIds,
      }).slice(0, -1);
      return sseResponse({ content: `\`\`\`json\n${raw}\n\`\`\`` }, "stop", payload.model);
    },
  } });
  try {
    const slot = app.store.reserveStory({ prompt: "Synthetic incomplete request" });
    app.runtime.requestStory({ slotId: slot.slotId, prompt: "Synthetic incomplete request" });
    await app.runtime.waitForIdle();
    const job = app.store.snapshot().jobs[0], story = app.store.getStory(slot.id);
    assert.equal(job.status, "incomplete");
    assert.equal(job.error.code, "DRAFT");
    assert.equal(job.requestCount, 2);
    assert.deepEqual(job.retainedDraft, candidate);
    assert.equal(job.fallback.generated, false);
    assert.equal(story.body, "");
    assert.equal(job.answer, undefined);
    assert.equal(job.explanation, undefined);
    assert.match(story.researchNote, /not a complete JSON draft/);
    assert.equal(story.researchNote.includes(raw), false);
    assert.equal(app.trace.entries.some((entry) => entry.kind === "agent.message_end" &&
      entry.message?.role === "assistant" &&
      entry.message?.content?.some((part) => part.text?.includes(raw))), true);
  } finally { await app.runtime.close(); }
});
