import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createView, serveApp } from "../ui/view.mjs";
import { createWorkshop } from "../agent/workshop.mjs";
import { createApplication } from "../agent/app.mjs";
import { createLocalWorkshop } from "../local/workshop.mjs";

const noNetwork = () => { throw new Error("Unexpected external request."); };

test("diagnostics preserve empty tool-call content while redacting secrets in every environment", async (t) => {
  const secret = "synthetic-diagnostic-secret";
  const environments = [
    ["hosted", () => createWorkshop({
      env: { WORKSHOP_BROKER_URL: "https://workshop.example", WORKSHOP_RUN_TOKEN: secret },
      fetcher: noNetwork,
    })],
    ["local", () => createLocalWorkshop({
      mode: "live", storeFile: ":memory:", fetcher: noNetwork,
      env: { OPENROUTER_API_KEY: secret, OPENROUTER_MODEL: "test/model" },
    })],
    ["fixture", () => createLocalWorkshop({
      mode: "fixture", env: {}, fetcher: noNetwork,
    })],
  ];
  for (const [mode, create] of environments) {
    await t.test(mode, async (t) => {
      const workshop = create();
      const app = createApplication({ workshop });
      t.after(() => app.close());
      const entry = {
        id: "empty-content",
        type: "app.request_start",
        payload: {
          messages: [{
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call-1", type: "function",
              function: { name: "list_stories", arguments: '{"category":"top"}' },
            }],
          }],
          options: { topic: "", count: 0, enabled: false, selection: null },
          diagnostic: mode === "fixture" ? "" : `context ${secret}`,
        },
      };
      const original = structuredClone(entry);
      app.view.trace(entry);
      const failure = workshop.cleanError(undefined);
      app.view.trace({ id: "real-failure", type: "app.setup_failed", error: failure });
      await app.view.execution.flush();
      const recorded = await app.view.execution.get(entry.id);
      assert.deepEqual(recorded.payload, {
        ...entry.payload,
        diagnostic: mode === "fixture" ? "" : "context [redacted]",
      });
      assert.deepEqual(entry, original, "Diagnostics must not mutate provider input.");
      assert.equal(recorded.status, "running");
      assert.equal(workshop.cleanError(new Error(`Problem ${secret}`)),
        mode === "fixture" ? `Problem ${secret}` : "Problem [redacted]");
      const failed = await app.view.execution.get("real-failure");
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, failure);
      assert.match(failure, /request failed/i);
      assert.equal(app.view.state.requestsUsed, 0);
    });
  }
});

test("diagnostics beyond 12 MiB remain on disk while state and SSE stay compact", async (t) => {
  const secret = "synthetic-environment-secret";
  const view = createView({ sessionId: "archive-test" }, {
    clean: (value) => value.replaceAll(secret, "[redacted]"),
  });
  t.after(() => view.close());
  const frames = [];
  const response = new EventEmitter();
  Object.assign(response, {
    writableLength: 0,
    writeHead() {},
    write(frame) { frames.push(frame); },
    end() {},
    destroy() { this.destroyed = true; },
  });
  view.connect(response);
  const payload = "complete-observation-".repeat(55000);
  for (let index = 0; index < 13; index++) {
    view.trace({
      id: `large-${index}`,
      type: "app.hn_observation",
      taskId: "large-task",
      payload: `${index}:${payload}`,
      authorization: `Bearer ${secret}`,
      message: secret,
    });
    // Respect the archive's pending-write bound while exceeding the old total.
    await view.execution.flush();
  }
  for (let index = 0; index < 80; index++)
    view.trace({
      id: `small-${index}`,
      type: "app.skill_loaded",
      taskId: "large-task",
      content: "An archived instruction.",
    });
  await view.execution.flush();
  view.flush();
  assert.ok(view.execution.summary().logicalBytes > 12 * 1024 * 1024);
  assert.equal(view.execution.summary().capture.status, "complete");
  assert.ok(view.state.trace.length <= 50);
  assert.ok(Buffer.byteLength(JSON.stringify(view.state)) < 64000);
  assert.ok(frames.every((frame) => Buffer.byteLength(frame) < 64000));
  assert.ok(!frames.some((frame) => frame.includes("complete-observation-")));
  assert.ok(!frames.some((frame) => frame.includes(secret)));
  const original = await view.execution.get("large-0");
  assert.equal(original.payload, `0:${payload}`);
  assert.equal(original.message, "[redacted]");
  assert.ok(!JSON.stringify(original).includes(secret));
});

test("execution GETs page summaries and read one sanitized record without initializing work", async (t) => {
  let bootstraps = 0;
  const workshop = createLocalWorkshop({
    mode: "fixture", env: {}, fetcher: noNetwork,
  });
  const bootstrap = workshop.bootstrap;
  workshop.bootstrap = (...args) => {
    bootstraps++;
    return bootstrap(...args);
  };
  const app = createApplication({ workshop });
  const runtime = await serveApp(app, { host: "127.0.0.1", port: 0 });
  t.after(() => runtime.close());
  for (let index = 0; index < 3; index++)
    app.view.trace({
      id: `observation-${index}`,
      type: "app.hn_observation",
      taskId: "task-1",
      operationId: "request-1",
      content: `Full observation ${index}`,
      password: "synthetic-secret",
    });
  await app.view.execution.flush();
  const before = app.view.execution.summary();
  const origin = `http://127.0.0.1:${runtime.port}`;
  const page = await (await fetch(
    `${origin}/api/execution?view=protocol&limit=2&query=request-1&taskId=task-1`,
  )).json();
  assert.equal(page.records.length, 2);
  assert.ok(page.nextCursor);
  assert.ok(page.records.every((record) => record.content === undefined));
  const older = await (await fetch(
    `${origin}/api/execution?view=protocol&limit=2&cursor=${page.nextCursor}`,
  )).json();
  assert.equal(older.records.length, 1);
  const detail = await (await fetch(
    `${origin}/api/execution/observation-0`,
  )).json();
  assert.equal(detail.record.content, "Full observation 0");
  assert.ok(!JSON.stringify(detail).includes("synthetic-secret"));
  const missing = await fetch(`${origin}/api/execution/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { record: null });
  assert.equal(bootstraps, 0);
  assert.equal(app.view.state.requestsUsed, 0);
  assert.deepEqual(app.view.execution.summary(), before);
});

test("recovery identity survives retirement of visible records and resets for a new conversation", async (t) => {
  let requests = 0;
  const app = createApplication({
    workshop: createLocalWorkshop({
      mode: "live",
      env: { OPENROUTER_API_KEY: "synthetic-key", OPENROUTER_MODEL: "test/model" },
      storeFile: ":memory:",
      fetcher: async () => {
        requests++;
        return new Response("Unavailable", { status: 503 });
      },
    }),
  });
  t.after(async () => {
    await app.close();
    await app.view.close();
  });
  await app.initialize();
  await app.action({
    id: randomUUID(),
    type: "run",
    data: {
      sessionId: app.view.state.sessionId,
      text: "Keep this request.",
      options: {},
    },
  });
  await app.idle;
  const operationId = app.view.state.recoveryOperationId;
  assert.ok(operationId);
  assert.equal(app.view.state.resume.operationId, operationId);
  for (let index = 0; index < 75; index++)
    app.view.trace({ type: "app.skill_loaded", content: `Later diagnostic ${index}` });
  assert.ok(!app.view.state.trace.some((entry) => entry.type === "app.request_start"));
  assert.equal(app.view.state.resume.operationId, operationId);
  assert.equal(app.view.state.recoveryOperationId, operationId);
  assert.equal(app.view.state.requestsUsed, 1);
  assert.equal(requests, 1);
  await app.action({ id: randomUUID(), type: "new_conversation", data: {} });
  assert.equal(app.view.state.recoveryOperationId, null);
  assert.equal(app.view.state.resume, null);
  assert.equal(app.view.state.requestsUsed, 1);
});
