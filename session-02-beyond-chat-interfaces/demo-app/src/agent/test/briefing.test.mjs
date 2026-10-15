import assert from "node:assert/strict";
import test from "node:test";
import { createIssueStore } from "../../domain/store.mjs";
import { createMcpServer } from "../../mcp/server.mjs";
import { connectMcp } from "../../mcp/client.mjs";
import { BRIEFING_TOOLS } from "../../mcp/access.mjs";
import { createSources } from "../../sources/service.mjs";
import { createTrace } from "../../trace.mjs";
import { createGateway } from "../gateway.mjs";
import { createResearchAgent } from "../runtime.mjs";
import { sseResponse } from "../fixture.mjs";
import { deferred } from "./helpers.mjs";

async function setup(t, overrides = {}) {
  const config = { mode: "fixture", maxTurns: 10, concurrency: 1, maxQueue: 1, ...overrides };
  const trace = createTrace();
  let http = 0;
  trace.fetch = async () => { http++; throw new Error("Real network requests are forbidden."); };
  const store = await createIssueStore({ trace, config });
  const sources = createSources({ store, trace, config });
  const context = { store, trace, sources, config };
  const server = createMcpServer(context);
  const mcp = await connectMcp(server, trace);
  const gateway = createGateway({ trace, config });
  const runtime = createResearchAgent({ store, trace, mcp, gateway, config });
  context.agent = runtime;
  t.after(async () => { await runtime.close(); await mcp.close(); await server.close(); });
  return { trace, store, sources, mcp, gateway, runtime, http: () => http };
}

test("a real MCP briefing discovers the familiar tools and shows HN metadata cards before its final answer", async (t) => {
  const app = await setup(t);
  let earlyCards;
  const unsubscribe = app.store.subscribe((state) => {
    const briefing = state.briefings[0];
    if (briefing?.cards.length && briefing.status !== "completed")
      earlyCards = structuredClone(briefing);
  });
  t.after(unsubscribe);
  const result = await app.mcp.callTool("request_briefing", { prompt: "Which three HN links should I open?" });
  assert.equal(result.isError, undefined);
  const job = result.structuredContent.job;
  assert.equal(job.status, "queued");
  assert.equal(job.type, "briefing");
  assert.equal(job.slotId, undefined);
  await app.runtime.waitForIdle();
  const state = app.store.snapshot(), briefing = state.briefings[0];
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, "completed");
  assert.equal(briefing.id, job.id);
  assert.equal(briefing.jobId, job.id);
  assert.equal(briefing.prompt, job.prompt);
  assert.equal(briefing.status, "completed");
  assert.equal(briefing.cards.length, 3);
  assert.equal(earlyCards.cards.length, 3);
  assert.equal(earlyCards.answer, "");
  assert.match(briefing.answer, /HN recommendations.*synthetic metadata/u);
  assert.ok(briefing.cards.every((card) => card.evidenceLevel === "metadata" && !card.text));
  assert.ok(briefing.cards.every((card) =>
    card.id === card.sourceId && briefing.answer.includes(card.canonicalUrl)));
  assert.equal(state.issue.stories.length, 0);
  assert.equal(app.http(), 0);
  const calls = app.trace.entries.filter((entry) => entry.method === "tools/call" && entry.jobId === job.id);
  assert.deepEqual(calls.map((entry) => entry.params.name),
    ["read_skill", "inspect_user_preferences", "list_stories", "propose_briefing"]);
  const requests = app.trace.entries.filter((entry) => entry.kind === "model.request" && entry.jobId === job.id);
  assert.equal(requests.length, 5);
  const names = requests[0].payload.tools.map((tool) => tool.function.name);
  assert.ok(BRIEFING_TOOLS.every((name) => names.includes(name)));
  assert.ok(names.includes("search_google_news"));
  for (const name of ["write_story", "request_story", "approve_change", "list_execution"])
    assert.equal(names.includes(name), false);
  const message = requests[0].payload.messages.find((entry) =>
    typeof entry.content === "string" && entry.content.startsWith("Briefing request:\n"));
  const context = JSON.parse(message.content.slice("Briefing request:\n".length));
  for (const key of ["slotId", "frame", "budget", "baseContentVersion"])
    assert.equal(context[key], undefined);
  assert.equal(state.jobs[0].operationIds.length, 5);
  assert.equal(app.gateway.budget.reservedUsd, 0);
  assert.equal(app.gateway.budget.finalAnswerReservedUsd, 0);
});

test("briefings and stories share admission limits and cancelling a briefing preserves the story", async (t) => {
  const app = await setup(t);
  const entered = deferred(), release = deferred();
  const list = app.sources.listStories;
  app.sources.listStories = async (...args) => {
    entered.resolve(); await release.promise; return list(...args);
  };
  const first = app.runtime.requestBriefing({ prompt: "Three HN links" });
  await entered.promise;
  const slot = app.store.reserveStory({ prompt: "tools" });
  const second = app.runtime.requestStory({ slotId: slot.slotId, prompt: "tools" });
  assert.throws(() => app.runtime.requestBriefing({ prompt: "One more" }), { code: "QUEUE_FULL" });
  assert.equal(app.store.snapshot().briefings.length, 1);
  assert.equal(app.runtime.cancelBriefing(first.id), true);
  release.resolve();
  await app.runtime.waitForIdle();
  const state = app.store.snapshot();
  assert.equal(state.briefings[0].status, "cancelled");
  assert.equal(state.jobs.find((job) => job.id === second.id).status, "completed");
  assert.equal(state.issue.stories.length, 1);
  assert.match(state.issue.stories[0].body, /Simulated/u);
  assert.equal(app.http(), 0);
});

test("an endless briefing gets nine tool turns and one final answer attempt in the same budget", async (t) => {
  const app = await setup(t, { fixture: { endlessTools: true, failFinal: true } });
  app.runtime.requestBriefing({ prompt: "HN links" });
  await app.runtime.waitForIdle();
  const state = app.store.snapshot(), job = state.jobs[0];
  assert.equal(job.status, "incomplete");
  assert.equal(job.turn, 10);
  assert.equal(job.requestCount, 10);
  assert.match(state.briefings[0].answer, /could not be completed/u);
  assert.ok(job.sourceIds.length);
  assert.equal(state.issue.stories.length, 0);
  const requests = app.trace.entries.filter((entry) => entry.kind === "model.request");
  assert.equal(requests.length, 10);
  assert.equal(requests[9].payload.tool_choice, "none");
  assert.equal(requests[9].payload.tools, undefined);
  assert.equal(app.trace.entries.filter((entry) => entry.method === "tools/call" && entry.jobId === job.id).length, 9);
  assert.equal(app.http(), 0);
});

test("briefing answers cannot register invented source recommendations", async (t) => {
  const app = await setup(t, {
    fixtureChat: ({ payload }) => sseResponse({ content: JSON.stringify({
      answer: "Open this link.", recommendations: [{ sourceId: "invented-id", note: "Unsupported" }],
    }) }, "stop", payload.model),
  });
  app.runtime.requestBriefing({ prompt: "HN links" });
  await app.runtime.waitForIdle();
  const state = app.store.snapshot();
  assert.equal(state.jobs[0].error.code, "EVIDENCE");
  assert.equal(state.briefings[0].status, "incomplete");
  assert.deepEqual(state.briefings[0].cards, []);
  assert.deepEqual(state.issue.sources, []);
  assert.deepEqual(state.issue.stories, []);
});
