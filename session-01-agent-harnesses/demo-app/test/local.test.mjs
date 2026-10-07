import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApplication } from "../agent/app.mjs";
import { createLocalWorkshop } from "../local/workshop.mjs";
import { createLocalStore } from "../local/store.mjs";
import { createLocalHn } from "../local/hn.mjs";
import { emptyUserPreferences } from "../support/user-preferences.mjs";
import { serveApp } from "../ui/view.mjs";
import { textFrame } from "../local/fixture.mjs";
import manifest from "../workshop-app.json" with { type: "json" };

const noNetwork = () => {
  throw new Error("A fixture attempted an external request.");
};
function application(t, options = {}) {
  const workshop = createLocalWorkshop({
    mode: "fixture",
    env: {},
    fetcher: noNetwork,
    fixtureDelay: 1,
    ...options,
  });
  const app = createApplication({ workshop });
  t.after(async () => {
    await app.close();
    app.view.close();
  });
  return app;
}
function action(app, type, data = {}) {
  return app.action({ id: randomUUID(), type, data });
}
async function run(app, options = {}, text = "Suggest useful HN links.") {
  await app.initialize();
  await action(app, "run", {
    text,
    options,
    sessionId: app.view.state.sessionId,
  });
  await app.idle;
  return app.view.state;
}
async function until(read) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected local state did not arrive.");
}

test("the fixture runs discovery, tools and complete observations without a network", async (t) => {
  const app = application(t);
  const state = await run(app);
  assert.equal(state.runtimeMode, "fixture");
  assert.equal(state.fixture, true);
  assert.equal(state.lastOutcome.status, "completed");
  assert.equal(state.requestsUsed, 4);
  assert.equal(state.cards.length, 3);
  assert.deepEqual(
    state.trace
      .filter((e) => e.type === "tool_execution_start")
      .map((e) => e.toolName),
    ["read_skill", "list_stories", "propose_briefing"],
  );
  const requests = state.trace.filter((e) => e.type === "app.request_start");
  const last = requests.at(-1).payload.messages;
  assert.ok(
    last.some((m) => m.role === "tool" && m.content.includes("fixture-hn-1")),
  );
  assert.equal(state.usage, null);
});

test("fixed control fetches before its one model request", async (t) => {
  const app = application(t);
  const state = await run(app, { control: "fixed" });
  assert.equal(state.lastOutcome.status, "completed");
  assert.equal(state.requestsUsed, 1);
  const request = state.trace.find((e) => e.type === "app.request_start");
  assert.equal(request.payload.tool_choice, "none");
  assert.ok(
    request.payload.messages[1].content.includes("fixedWorkflowEvidence"),
  );
});

test("a denied save changes no preferences; approval persists the exact proposal", async (t) => {
  const app = application(t);
  await run(app);
  const sourceId = app.view.state.cards[0].id;
  await action(app, "save_links", { sourceIds: [sourceId] });
  const denied = await until(() => app.view.state.approval);
  await action(app, "approve", { approvalId: denied.id, accepted: false });
  await app.idle;
  assert.equal(app.view.state.userPreferences.value.entries.length, 0);

  await action(app, "save_links", { sourceIds: [sourceId] });
  const approved = await until(() => app.view.state.approval);
  await action(app, "approve", { approvalId: approved.id, accepted: true });
  await app.idle;
  assert.deepEqual(
    app.view.state.userPreferences.value.entries.map((e) => e.id),
    [sourceId],
  );
  assert.equal(app.view.state.userPreferences.status, "saved");
  assert.equal(app.view.state.requestsUsed, 4);
});

test("saved context and the current override are separate", async (t) => {
  const app = application(t);
  await app.initialize();
  await action(app, "remember", { topic: "distributed systems" });
  const approval = await until(() => app.view.state.approval);
  await action(app, "approve", { approvalId: approval.id, accepted: true });
  await app.idle;
  const state = await run(app, { topic: "agent tools" });
  const request = state.trace.find((e) => e.type === "app.request_start");
  const context = JSON.parse(
    request.payload.messages[1].content.split("\n").slice(1).join("\n"),
  );
  assert.equal(context.savedPreferences.topic, "distributed systems");
  assert.equal(context.effectiveTopic, "agent tools");
  assert.equal(
    state.userPreferences.value.preferences.topic,
    "distributed systems",
  );
});

test("the reviewer receives its own context within the shared budget", async (t) => {
  const app = application(t);
  const state = await run(app, { reviewer: true });
  assert.equal(state.lastOutcome.status, "completed");
  assert.equal(state.requestsUsed, 5);
  const review = state.trace.find(
    (e) => e.type === "app.request_start" && e.role === "reviewer",
  );
  assert.equal(review.payload.tools.length, 0);
  assert.ok(review.payload.messages[0].content.startsWith("Review an HN"));
});

test("stop cancels an in-flight fixture request and retains the input", async (t) => {
  const app = application(t, { fixtureDelay: 500 });
  await app.initialize();
  await action(app, "run", {
    text: "Keep my question.",
    options: {},
    sessionId: app.view.state.sessionId,
  });
  await until(() => app.view.state.requestsUsed === 1);
  await action(app, "stop", { briefingId: app.view.state.activeId });
  await app.idle;
  assert.equal(app.view.state.lastOutcome.status, "cancelled");
  assert.ok(app.view.state.chat.some((m) => m.text === "Keep my question."));
  assert.equal(app.view.state.requestsUsed, 1);
});

test("local modes fail before execution when hosted configuration is present", () => {
  for (const mode of ["live", "fixture"])
    for (const env of [
      { WORKSHOP_RUNTIME: "hosted" },
      { WORKSHOP_RUN_TOKEN: "synthetic-hosted-token" },
      { WORKSHOP_BROKER_URL: "http://127.0.0.1:1" },
    ])
      assert.throws(
        () => createLocalWorkshop({ mode, env }),
        /hosted workshop/,
      );
  assert.throws(
    () => createLocalWorkshop({ mode: "live", env: {} }),
    /requires OPENROUTER/,
  );
  assert.throws(
    () => createLocalWorkshop({ env: {} }),
    /explicit fixture or live/,
  );
});

test("live adapter sends the explicit model and full request, with no fallback", async (t) => {
  const requests = [];
  const env = {
    OPENROUTER_API_KEY: "synthetic-local-key",
    OPENROUTER_MODEL: manifest.inference.defaultModel,
  };
  const app = application(t, {
    mode: "live",
    env,
    storeFile: ":memory:",
    fetcher: async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      requests.push(JSON.parse(init.body));
      assert.equal(init.headers.authorization, "Bearer synthetic-local-key");
      return new Response(textFrame("An injected test response."), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await app.initialize();
  assert.equal(requests.length, 0);
  const state = await run(app, {}, "My complete question: café, 東京.");
  assert.equal(state.lastOutcome.status, "completed");
  assert.equal(state.runtimeMode, "local");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, manifest.inference.defaultModel);
  assert.equal(requests[0].provider.allow_fallbacks, false);
  assert.equal(requests[0].plugins[0].enabled, false);
  assert.ok(
    requests[0].messages.some(
      (m) => m.content === "My complete question: café, 東京.",
    ),
  );
  assert.ok(!JSON.stringify(state).includes("synthetic-local-key"));
});

test("a provider failure makes one attempt and stays visible", async (t) => {
  let requests = 0;
  const app = application(t, {
    mode: "live",
    env: {
      OPENROUTER_API_KEY: "synthetic-key",
      OPENROUTER_MODEL: manifest.inference.defaultModel,
    },
    storeFile: ":memory:",
    fetcher: async () => {
      requests++;
      return new Response("Unavailable", { status: 503 });
    },
  });
  const state = await run(app);
  assert.equal(requests, 1);
  assert.equal(state.lastOutcome.status, "failed");
  assert.match(state.lastOutcome.message, /HTTP 503/);
  assert.equal(state.requestsUsed, 1);
});

test("the real HN adapter reports losses through actual MCP calls", async (t) => {
  const urls = [];
  const hn = createLocalHn({
    fixture: false,
    fetcher: async (url) => {
      urls.push(url);
      if (url.endsWith("topstories.json")) return Response.json([1, 2]);
      if (url.endsWith("/1.json"))
        return Response.json({
          id: 1,
          type: "story",
          title: "Synthetic API story",
          time: 1700000000,
          url: "https://example.org/story",
        });
      return Response.json({ id: 2, deleted: true });
    },
  });
  t.after(() => hn.close());
  const declaration = await hn.discover();
  assert.equal(
    declaration.inputSchema.$schema,
    "http://json-schema.org/draft-07/schema#",
  );
  const response = await hn.listStories({ category: "top", count: 2 });
  assert.equal(response.structuredContent.records.length, 1);
  assert.equal(response.structuredContent.completeForRequestedScope, false);
  assert.equal(response._meta["newspaper.sources"].losses[0].upstreamId, "2");
  assert.equal(urls.length, 3);
  await assert.rejects(() => hn.listStories({ category: "top", count: 13 }));
  assert.equal(urls.length, 3);
});

test("local preferences survive reopening and reject a stale writer", () => {
  const directory = resolve(".local/test-runs", randomUUID());
  mkdirSync(directory, { recursive: true });
  const filename = resolve(directory, "preferences.sqlite");
  const first = createLocalStore(filename);
  const value = emptyUserPreferences();
  value.preferences.topic = "reliable tools";
  const saved = first.save(value, null);
  first.close();
  const second = createLocalStore(filename);
  try {
    assert.deepEqual(second.load().value, value);
    assert.throws(
      () => second.save(emptyUserPreferences(), null),
      /changed after/,
    );
    assert.equal(second.load().etag, saved.etag);
    assert.deepEqual(second.load().value, value);
  } finally {
    second.close();
  }
});

test("the packaged HTTP UI is ready locally and exposes only declared source", async () => {
  const app = createApplication({
    workshop: createLocalWorkshop({
      mode: "fixture",
      env: {},
      fetcher: noNetwork,
    }),
  });
  const runtime = await serveApp(app, { host: "127.0.0.1", port: 0 });
  try {
    const origin = `http://127.0.0.1:${runtime.port}`;
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.phase, "idle");
    assert.equal(state.runtimeMode, "fixture");
    assert.equal((await fetch(`${origin}/api/source?path=.env`)).status, 404);
    assert.equal(
      (await fetch(`${origin}/api/source?path=local/workshop.mjs`)).status,
      200,
    );
  } finally {
    await runtime.close();
  }
});
