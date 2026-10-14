import test from "node:test";
import assert from "node:assert/strict";
import { createLocalHn, hnTool } from "../local/hn.mjs";
import { createWorkshop } from "../agent/workshop.mjs";
import manifest from "../workshop-app.json" with { type: "json" };

test("actual in-memory MCP discovery and calls have paired, correlated observations", async (t) => {
  const entries = [];
  const source = createLocalHn({
    fixture: true,
    fetcher: () => { throw new Error("Unexpected external request."); },
  });
  t.after(() => source.close());
  const observation = {
    taskId: "briefing-1",
    operationId: "model-request-1",
    toolCallId: "tool-call-1",
    notify: (entry) => entries.push(entry),
  };
  const tool = await source.discover(undefined, observation);
  assert.equal(tool.name, "list_stories");
  const result = await source.listStories(
    { category: "top", count: 2 }, undefined, observation,
  );
  assert.equal(result.structuredContent.records.length, 2);
  await assert.rejects(() => source.listStories(
    { category: "top", count: 13 }, undefined, observation,
  ));

  const starts = entries.filter((entry) => entry.type === "mcp.request_start");
  assert.deepEqual(starts.map((entry) => entry.method), [
    "initialize", "tools/list", "tools/list", "tools/call", "tools/list", "tools/call",
  ]);
  for (const start of starts) {
    const end = entries.find((entry) =>
      entry.type === "mcp.request_end" && entry.mcpRequestId === start.id,
    );
    assert.ok(end);
    assert.equal(end.parentId, start.id);
    assert.equal(end.taskId, observation.taskId);
    assert.equal(end.operationId, observation.operationId);
    assert.equal(end.toolCallId, observation.toolCallId);
    assert.equal(start.transport, "in-memory");
    assert.equal(start.actor, start.method === "tools/call" ? "tool" : "harness");
  }
  assert.equal(entries.at(-1).status, "failed");
  const succeeded = entries.find((entry) =>
    entry.type === "mcp.request_end" && entry.method === "tools/call" &&
    entry.status === "completed",
  );
  assert.deepEqual(succeeded.result, result);

  // An observer cannot suppress a real result or cause an extra execution.
  const observed = await source.listStories(
    { category: "top", count: 1 }, undefined,
    { notify: () => { throw new Error("Broken observer."); } },
  );
  assert.equal(observed.structuredContent.records.length, 1);
});

test("hosted MCP observes real HTTP SDK boundaries and redacts failure credentials", async (t) => {
  const entries = [];
  const methods = [];
  const token = "synthetic-private-workshop-token";
  const workshop = createWorkshop({
    env: {
      WORKSHOP_RUNTIME: "hosted",
      WORKSHOP_RUN_ID: "test-visit",
      WORKSHOP_BROKER_URL: "https://broker.example",
      WORKSHOP_RUN_TOKEN: token,
    },
    fetcher: async (url, init) => {
      if (new URL(url).pathname === "/v1/bootstrap")
        return Response.json({
          contractVersion: manifest.schemaVersion,
          runId: "test-visit",
          mode: "hosted",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          inference: { selection: { modelId: manifest.inference.defaultModel } },
          services: { hn: { url: "/hn" } },
        });
      assert.equal(new URL(url).pathname, "/hn");
      if (init.method === "GET") return new Response(null, { status: 405 });
      const request = JSON.parse(init.body);
      methods.push(request.method);
      if (!Object.hasOwn(request, "id")) return new Response(null, { status: 202 });
      let result;
      if (request.method === "initialize")
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "test-hn", version: "1" },
        };
      else if (request.method === "tools/list") result = { tools: [hnTool] };
      else if (request.method === "tools/call")
        return Response.json({
          jsonrpc: "2.0", id: request.id,
          error: { code: -32602, message: `Synthetic source failure ${token}` },
        });
      else assert.fail(`Unexpected MCP method ${request.method}`);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  t.after(() => workshop.close());
  const observation = {
    taskId: "briefing-http",
    operationId: "model-http",
    toolCallId: "tool-http",
    notify: (entry) => entries.push(entry),
  };
  await workshop.bootstrap();
  await workshop.discover(undefined, observation);
  await assert.rejects(() => workshop.listStories(
    { category: "top", count: 2 }, undefined, observation,
  ), /Synthetic source failure/);
  assert.deepEqual(
    methods.filter((method) => !method.startsWith("notifications/")),
    ["initialize", "tools/list", "tools/call"],
  );
  const starts = entries.filter((entry) => entry.type === "mcp.request_start");
  assert.equal(starts.length, 3);
  assert.ok(starts.every((entry) => entry.transport === "streamable-http"));
  assert.equal(entries.at(-1).status, "failed");
  assert.equal(entries.at(-1).operationId, "model-http");
  assert.ok(!JSON.stringify(entries).includes(token));
});
