import assert from "node:assert/strict";
import test from "node:test";
import { sseResponse } from "../fixture.mjs";
import { setup, storyRequest } from "./helpers.mjs";

const call = (index, sourceId) => ({
  index, id: `read-${index}`, type: "function",
  function: { name: "fetch_read", arguments: JSON.stringify({ sourceId }) },
});

test("five valid tools run in one turn and a blocked source does not lose useful siblings", async (t) => {
  const app = await setup({
    onCall: ({ name, args }) => {
      if (name === "fetch_read" && ["blocked", "missing"].includes(args.sourceId))
        throw Object.assign(new Error(args.sourceId === "blocked" ? "Source returned 403" : "Source returned 404"),
          { code: "SOURCE_HTTP", status: args.sourceId === "blocked" ? 403 : 404 });
    },
    config: { fixtureChat: ({ payload, turn }) => {
      if (turn === 1) return sseResponse({
        tool_calls: ["primary", "companion", "blocked", "missing", "fallback"].map((id, index) => call(index, id)),
      }, "tool_calls", payload.model);
      const observations = payload.messages.filter(message => message.role === "tool");
      assert.equal(observations.length, 5);
      assert.match(JSON.stringify(observations), /403/);
      assert.match(JSON.stringify(observations), /404/);
      assert.match(JSON.stringify(observations.at(-1)), /fixture-read/);
      return sseResponse({ content: JSON.stringify({
        headline: "Supported synthetic draft",
        body: "Simulated data: an editor requests a cited draft in a fixed newspaper slot.",
        sourceIds: ["fixture-read"],
      }) }, "stop", payload.model);
    } },
  });
  t.after(() => app.runtime.close());
  const slot = app.store.reserveStory({ prompt: "Five sources" });
  const job = app.runtime.requestStory({ slotId: slot.slotId, prompt: slot.prompt });
  await app.runtime.waitForIdle();
  assert.equal(app.store.snapshot().jobs.at(-1).status, "completed");
  assert.deepEqual(app.calls.map(entry => entry.args.sourceId), ["primary", "companion", "blocked", "missing", "fallback"]);
  assert.equal(app.calls.every(entry => entry.meta.jobId === job.id && entry.meta.slotId === slot.slotId), true);
  assert.equal(app.trace.entries.filter(entry => entry.kind === "mcp.call" && entry.status === "failed").length, 2);
  assert.equal(app.trace.entries.some(entry => entry.error?.code === "TOOL_LIMIT"), false);
  assert.deepEqual(app.store.getStory(slot.id).sourceIds, ["fixture-read"]);
});

test("removing the call-count cap retains tool-argument validation", async (t) => {
  const app = await setup({ config: { fixtureChat: ({ payload, turn }) => {
    if (turn === 1) return sseResponse({ tool_calls: [
      { ...call(0, "unused"), function: { name: "fetch_read", arguments: JSON.stringify({ unexpected: "not a source" }) } },
      call(1, "valid"),
    ] }, "tool_calls", payload.model);
    const context = storyRequest(payload);
    return sseResponse({ content: JSON.stringify({
      headline: "Validated synthetic draft", body: "Simulated evidence remains available.",
      sourceIds: [context.sources[0].id],
    }) }, "stop", payload.model);
  } } });
  t.after(() => app.runtime.close());
  const slot = app.store.reserveStory({ prompt: "Validate inputs" });
  app.runtime.requestStory({ slotId: slot.slotId, prompt: slot.prompt });
  await app.runtime.waitForIdle();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].args.sourceId, "valid");
  assert.equal(app.store.snapshot().jobs.at(-1).status, "completed");
});
