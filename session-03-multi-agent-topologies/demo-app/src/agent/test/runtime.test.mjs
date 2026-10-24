import assert from "node:assert/strict";
import test from "node:test";
import { sseResponse } from "../fixture.mjs";
import { deferred, setup, storyRequest } from "./helpers.mjs";

test("the offline story fixture discovers MCP tools, reads evidence, and writes only its reserved slot", async () => {
  const app = await setup();
  const slot = app.store.reserveStory({ prompt: "tools" });
  const job = app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" });
  assert.equal(typeof job.then, "undefined");
  assert.equal(job.status, "queued");
  await app.runtime.waitForIdle();
  const state = app.store.snapshot();
  assert.equal(state.jobs[0].status, "completed");
  assert.equal(state.issue.stories.length, 1);
  assert.match(state.issue.stories[0].body, /Simulated/u);
  assert.deepEqual(app.calls.map((call) => call.name), ["search_hn", "fetch_read", "write_story"]);
  assert.deepEqual(state.issue.stories[0].sourceIds, ["fixture-read"]);
  assert.equal(app.trace.requests.length, 0);
  assert.equal(app.trace.entries.find((entry) => entry.kind === "mcp.exposure").toolNames.includes("hidden_app_tool"), false);
  assert.equal(app.calls.every((call) => call.meta.actor === "agent" && call.meta.jobId === job.id), true);
});

test("independent stories start together while each keeps its tool and slot ownership order", { timeout: 2000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let searches = 0;
  t.after(() => release.resolve());
  const app = await setup({ config: { concurrency: undefined, maxQueue: 0 }, onCall: async ({ name }) => {
    if (name === "search_hn") {
      if (++searches === 3) entered.resolve();
      await release.promise;
    }
  } });
  const slots = Array.from({ length: 3 }, () => app.store.reserveStory({ prompt: "tools" }));
  const jobs = slots.map(slot => app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" }));
  await entered.promise;
  assert.equal(app.calls.length, 3, "all three independent searches started before any result returned");
  release.resolve();
  await app.runtime.waitForIdle();
  for (const [index, job] of jobs.entries()) {
    const calls = app.calls.filter(call => call.meta.jobId === job.id);
    assert.deepEqual(calls.map(call => call.name), ["search_hn", "fetch_read", "write_story"]);
    assert.equal(calls[2].args.slotId, slots[index].slotId);
    assert.equal(calls[2].args.requestId, job.id);
    assert.equal(app.store.snapshot().jobs.find(entry => entry.id === job.id).status, "completed");
  }
});

test("moving the placeholder preserves its identity and current frame", async () => {
  const entered = deferred(), release = deferred();
  const app = await setup({ onCall: async ({ name }) => {
    if (name === "search_hn") { entered.resolve(); await release.promise; }
  } });
  const slot = app.store.reserveStory({ prompt: "tools" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" });
  await entered.promise;
  app.store.moveStory(slot.id, { x: 110, y: 50, width: 84, height: 78 });
  const moved = app.store.getStory(slot.id).frame;
  release.resolve();
  await app.runtime.waitForIdle();
  const current = app.store.getStory(slot.id);
  assert.equal(current.slotId, slot.slotId);
  assert.deepEqual(current.frame, moved);
  assert.match(current.body, /Simulated/u);
});

test("manual copy survives completion and the generated copy becomes an alternate", async () => {
  const entered = deferred(), release = deferred();
  const app = await setup({ onCall: async ({ name }) => {
    if (name === "search_hn") { entered.resolve(); await release.promise; }
  } });
  const slot = app.store.reserveStory({ prompt: "tools" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" });
  await entered.promise;
  app.store.editStory(slot.id, { headline: "My headline", body: "My manual copy." });
  release.resolve();
  await app.runtime.waitForIdle();
  const current = app.store.getStory(slot.id);
  assert.equal(current.headline, "My headline");
  assert.equal(current.body, "My manual copy.");
  assert.match(current.alternateDraft.body, /Simulated/u);
  assert.equal(app.store.snapshot().jobs[0].phase, "alternate");
});

test("deletion during research cannot recreate the slot", async () => {
  const entered = deferred(), release = deferred();
  const app = await setup({ onCall: async ({ name }) => {
    if (name === "search_hn") { entered.resolve(); await release.promise; }
  } });
  const slot = app.store.reserveStory({ prompt: "tools" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" });
  await entered.promise;
  app.store.deleteStory(slot.id);
  release.resolve();
  await app.runtime.waitForIdle();
  assert.equal(app.store.snapshot().issue.stories.length, 0);
  assert.equal(app.store.snapshot().jobs[0].status, "superseded");
  assert.equal(app.calls.some((call) => call.name === "write_story"), false);
});

test("the bounded queue admits two requests and a cancelled queued job performs no tools", async () => {
  const entered = deferred(), release = deferred();
  const app = await setup({ config: { concurrency: 1, maxQueue: 1 }, onCall: async ({ name }) => {
    if (name === "search_hn") { entered.resolve(); await release.promise; }
  } });
  const slots = Array.from({ length: 3 }, () => app.store.reserveStory({ prompt: "tools" }));
  const first = app.runtime.requestStory({ slotId: slots[0].slotId, prompt: "tools" });
  const second = app.runtime.requestStory({ slotId: slots[1].slotId, prompt: "tools" });
  assert.throws(() => app.runtime.requestStory({ slotId: slots[2].slotId, prompt: "tools" }), { code: "QUEUE_FULL" });
  await entered.promise;
  assert.equal(app.runtime.cancelStory(second.id), true);
  release.resolve();
  await app.runtime.waitForIdle();
  const state = app.store.snapshot();
  assert.equal(state.jobs.find((job) => job.id === first.id).status, "completed");
  assert.equal(state.jobs.find((job) => job.id === second.id).status, "cancelled");
  assert.equal(app.calls.some((call) => call.meta.jobId === second.id), false);
  assert.equal(app.store.getStory(slots[1].id).requestId, null);
});

test("replacement preserves the newest request and a late original response cannot insert copy", async () => {
  const entered = deferred(), release = deferred();
  let blocked = false;
  const app = await setup({ onCall: async ({ name }) => {
    if (name === "search_hn" && !blocked) {
      blocked = true; entered.resolve(); await release.promise;
    }
  } });
  const slot = app.store.reserveStory({ prompt: "tools" });
  const first = app.runtime.requestStory({ slotId: slot.slotId, prompt: "old request" });
  await entered.promise;
  const second = app.runtime.requestStory({ slotId: slot.slotId, prompt: "new request" });
  release.resolve();
  await app.runtime.waitForIdle();
  const state = app.store.snapshot();
  assert.equal(state.jobs.find((job) => job.id === first.id).status, "superseded");
  assert.equal(state.jobs.find((job) => job.id === second.id).status, "completed");
  assert.equal(app.store.getStory(slot.id).requestId, second.id);
  assert.equal(app.store.getStory(slot.id).prompt, "new request");
});

test("endless tools force a tenth tool-free response; final failure retains explicit evidence", async () => {
  const app = await setup({ config: { fixture: { endlessTools: true, failFinal: true } } });
  const slot = app.store.reserveStory({ prompt: "tools" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" });
  await app.runtime.waitForIdle();
  const job = app.store.snapshot().jobs[0];
  assert.equal(job.turn, 10);
  assert.equal(job.requestCount, 10);
  assert.equal(app.calls.length, 9);
  assert.equal(job.status, "incomplete");
  assert.equal(job.fallback.generated, false);
  assert.ok(job.evidence.length);
  assert.equal(app.store.getStory(slot.id).body, "");
  const requests = app.trace.entries.filter((entry) => entry.kind === "model.request");
  assert.equal(requests.length, 10);
  assert.equal(requests[9].payload.tool_choice, "none");
  assert.equal(requests[9].payload.tools, undefined);
  const final = app.trace.entries.find(entry => entry.kind === "agent.final_turn");
  assert.equal(final.reason, "max_turns");
  assert.equal(final.maxTurns, 10);
});

test("a final draft with an invented source ID cannot enter the issue", async () => {
  const app = await setup({ tools: [], config: {
    fixtureChat: ({ payload }) => sseResponse({ content: JSON.stringify({
      headline: "Unsupported", body: "A made-up account.", sourceIds: ["invented-id"],
    }) }, "stop", payload.model),
  } });
  const slot = app.store.reserveStory({ prompt: "unsupported topic" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "unsupported topic" });
  await app.runtime.waitForIdle();
  assert.equal(app.store.snapshot().jobs[0].error.code, "EVIDENCE");
  assert.equal(app.store.getStory(slot.id).body, "");
  assert.equal(app.store.snapshot().issue.sources.some((source) => source.id === "invented-id"), false);
});

test("a fit rewrite shares the same allowance and triggers the parent's completion hook", async () => {
  const reviewed = deferred();
  const app = await setup({ tools: [], onDraftComplete: reviewed.resolve, config: {
    maxTurns: 2, measureStoryBudget: () => ({ maxWords: 10 }),
    fixtureChat: ({ payload, turn }) => {
      const context = storyRequest(payload);
      return sseResponse({ content: JSON.stringify({
        headline: "Simulated draft",
        body: turn === 1 ? "Simulated " + Array(20).fill("copy").join(" ") : "Simulated evidence supports this short workshop draft.",
        sourceIds: [context.sources[0].id],
      }) }, "stop", payload.model);
    },
  } });
  const slot = app.store.reserveStory({ prompt: "tools" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" });
  await app.runtime.waitForIdle();
  await reviewed.promise;
  assert.equal(app.store.snapshot().jobs[0].turn, 2);
  assert.equal(app.store.snapshot().jobs[0].status, "completed");
  assert.equal(app.trace.entries.filter((entry) => entry.kind === "story.fit_rewrite").length, 1);
  assert.equal(app.store.getStory(slot.id).fit.status, "fit");
});

test("an oversized write gets one tool-free shortening pass instead of repeated rejected writes", async () => {
  const app = await setup({ config: {
    measureStoryBudget: () => ({ maxWords: 129 }),
    fixtureChat: ({ payload, turn }) => {
      const context = storyRequest(payload);
      if (turn < 5) return sseResponse({ tool_calls: [{
        index: 0, id: `search-${turn}`, type: "function",
        function: { name: "search_hn", arguments: JSON.stringify({ query: "Synthetic research" }) },
      }] }, "tool_calls", payload.model);
      if (turn === 5) return sseResponse({ tool_calls: [{
        index: 0, id: "too-long-write", type: "function", function: {
          name: "write_story", arguments: JSON.stringify({
            issueId: context.issueId, slotId: context.slotId, requestId: context.requestId, baseContentVersion: context.baseContentVersion,
            headline: "Synthetic headline", body: Array(145).fill("word").join(" "),
            sourceIds: [context.sources[0].id],
          }),
        },
      }] }, "tool_calls", payload.model);
      assert.equal(payload.tools, undefined);
      assert.equal(payload.tool_choice, "none");
      assert.match(JSON.stringify(payload.messages), /contains 145 words/);
      assert.match(JSON.stringify(payload.messages), /correction shares the original run allowance/);
      return sseResponse({ content: JSON.stringify({
        headline: "Synthetic headline", body: Array(117).fill("word").join(" "),
        sourceIds: [context.sources[0].id],
      }) }, "stop", payload.model);
    },
  } });
  const slot = app.store.reserveStory({ prompt: "Synthetic research" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: "Synthetic research" });
  await app.runtime.waitForIdle();
  const job = app.store.snapshot().jobs[0];
  assert.equal(job.status, "completed", JSON.stringify(job.error));
  assert.equal(job.turn, 6);
  assert.equal(job.maxTurns, 10);
  assert.equal(job.requestCount, 6);
  assert.equal(app.calls.filter(call => call.name === "write_story").length, 0);
  assert.equal(app.store.getStory(slot.id).body.split(" ").length, 117);
  const correction = app.trace.entries.find(entry => entry.kind === "agent.copy_fit");
  assert.equal(correction.turn, 6);
  assert.equal(correction.maxTurns, 10);
  assert.equal(correction.reason, "copy_fit");
  assert.equal(correction.label, "Copy fit: tools disabled");
  assert.equal(app.trace.entries.some(entry => entry.kind === "agent.final_turn"), false,
    "a successful correction need not consume or announce the last possible turn");
});
