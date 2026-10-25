import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrace } from "../src/trace.mjs";
import { createInferenceBudget } from "../src/agent/budget.mjs";

async function directoryBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? directoryBytes(path) : stat(path).then(value => value.size);
  }));
  return sizes.reduce((total, bytes) => total + bytes, 0);
}

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `Expected ${expected}, received ${actual}`);

test("300 synthetic requests rotate old diagnostics while full recent I/O and durable spending remain usable", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session2-storage-headroom-"));
  const directory = join(root, "execution");
  const archiveLimit = 512 * 1024;
  const traceOptions = {
    directory, scopeId: "synthetic-long-visit",
    maximumArchiveBytes: archiveLimit, maximumPendingBytes: 128 * 1024,
    minimumFreeBytes: 32 * 1024, rollingRetention: true,
  };
  const config = {
    issueId: traceOptions.scopeId, inferenceLedgerFile: join(root, "inference.json"),
    maxInferenceCostUsd: 1, maxRequestCostUsd: 0.01,
  };
  let trace = createTrace(traceOptions);
  t.after(async () => {
    await trace.close();
    await rm(root, { recursive: true, force: true });
  });
  // Exercise real reservation and fsync behavior. No gateway, HTTP server,
  // credentials, or provider is used; the charges below are synthetic input.
  let budget = createInferenceBudget({ config, trace, fixture: false });
  trace.setBudgetSource(() => budget.summary());
  const unsettled = [];
  const model = "synthetic/no-provider";
  let latest;
  for (let index = 0; index < 300; index++) {
    const operationId = `synthetic-operation-${index}`;
    const requestId = `synthetic-request-${index}`;
    const payload = {
      model, messages: [
        { role: "system", content: "Synthetic archive regression. No inference is dispatched." },
        { role: "user", content: `Request ${index}: ${"input ".repeat(1400)} END INPUT ${index}` },
      ],
      tools: [{ type: "function", function: { name: "synthetic_read",
        parameters: { type: "object", properties: { query: { type: "string" } } } } }],
    };
    const result = { choices: [{ message: {
      role: "assistant", content: `Response ${index}: ${"output ".repeat(800)} END OUTPUT ${index}`,
    }, finish_reason: "stop" }] };
    budget.reserve(operationId, { model, kind: "story", payload });
    await trace.flush();
    const span = trace.start("model", {
      id: requestId, operationId, requestId, model, maxTurns: 1, turn: 1, simulated: true,
    });
    await trace.flush();
    const input = trace.record("model.request", {
      id: `${requestId}-input`, parentId: span.id, operationId, requestId, model, payload,
    });
    await trace.flush();
    const http = trace.record("model.http", {
      id: `${requestId}-http`, parentId: span.id, operationId, requestId, model,
      url: "https://synthetic.invalid/no-request-was-sent",
      httpStatus: 200, payload, result, truncated: false,
    });
    await trace.flush();
    trace.record("model.response", {
      parentId: span.id, operationId, requestId, model,
      message: { role: "assistant", content: [{ type: "text", text: result.choices[0].message.content }] },
    });
    await trace.flush();
    if (index % 50 === 0) {
      unsettled.push(operationId);
      budget.settle(operationId, null);
    } else budget.settle(operationId, 0.001);
    await trace.flush();
    span.finish({ status: "completed" });
    await trace.flush();
    latest = { requestId, inputId: input.id, httpId: http.id, payload, result };
  }

  async function assertLatestIo() {
    const request = await trace.get(latest.inputId);
    const http = await trace.get(latest.httpId);
    assert.ok(request, "the latest request remains inspectable");
    assert.ok(http, "the latest full HTTP exchange remains inspectable");
    assert.deepEqual(request.payload, latest.payload);
    assert.deepEqual(http.payload, latest.payload);
    assert.deepEqual(http.result, latest.result);
    assert.notEqual(request.captureIncomplete, true);
    assert.notEqual(http.captureIncomplete, true);
    const paired = await trace.getExchange(latest.requestId);
    assert.deepEqual(paired.exchange.request.http[0].value, latest.payload);
    assert.deepEqual(paired.exchange.response.http[0].value, latest.result);
  }

  t.diagnostic(JSON.stringify({
    requests: 300, archiveBytes: await directoryBytes(directory),
    storedBytes: trace.summary().storedBytes, retention: trace.summary().retention,
    capture: trace.summary().capture, accountingAvailable: budget.summary().accountingAvailable,
  }));
  await assertLatestIo();
  assert.equal(await trace.get("synthetic-request-0-input"), null,
    "old diagnostic records rotate instead of consuming the whole work directory");
  assert.equal(trace.summary().capture.errors, 0);
  assert.equal(trace.summary().capture.droppedRecords, 0, "retire old records instead of dropping new I/O");
  assert.ok(await directoryBytes(directory) <= archiveLimit + 16 * 1024,
    "physical archive files stay bounded, allowing a small scope-manifest overhead");
  assert.equal(budget.summary().accountingAvailable, true);
  closeTo(budget.summary().knownCostUsd, 0.294);
  closeTo(budget.summary().reservedUsd, 0.06);
  assert.deepEqual(budget.summary().unsettledOperations, unsettled);
  const ledgerBeforeClear = await readFile(config.inferenceLedgerFile);
  assert.equal(JSON.parse(ledgerBeforeClear).operations.length, 300);
  const spendingBeforeClear = budget.summary();
  const generation = trace.generation;
  await assert.doesNotReject(trace.clear());
  assert.equal(trace.generation, generation + 1);
  assert.equal(trace.list({ view: "protocol" }).total, 0);
  assert.deepEqual(await readFile(config.inferenceLedgerFile), ledgerBeforeClear);
  assert.deepEqual(budget.summary(), spendingBeforeClear);
  await assertLatestIo();

  await trace.close();
  trace = createTrace(traceOptions);
  budget = createInferenceBudget({ config, trace, fixture: false });
  trace.setBudgetSource(() => budget.summary());
  assert.deepEqual(budget.summary(), spendingBeforeClear,
    "accounting reloads from its ledger even though old diagnostics were retired");
  await assertLatestIo();
  assert.equal(budget.canReserve(model), true);
  assert.equal(budget.reserve("next-after-clear", {
    model, kind: "story", payload: { messages: [{ role: "user", content: "Next synthetic request" }] },
  }), 0.01);
  budget.settle(unsettled[0], 0.001);
  closeTo(budget.summary().knownCostUsd, 0.295);
  closeTo(budget.summary().reservedUsd, 0.06);
  assert.equal(budget.summary().accountingAvailable, true);
  assert.ok(budget.summary().unsettledOperations.includes("next-after-clear"));
  assert.ok(!budget.summary().unsettledOperations.includes(unsettled[0]));
  const saved = JSON.parse(await readFile(config.inferenceLedgerFile, "utf8"));
  assert.equal(saved.operations.length, 301);
  assert.equal(saved.operations.find(entry => entry.operationId === unsettled[0]).costUsd, 0.001);
  const cacheFile = join(root, "editor-cache.json");
  await writeFile(cacheFile, JSON.stringify({ issueId: config.issueId, body: "Saved after rotation" }));
  assert.equal(JSON.parse(await readFile(cacheFile, "utf8")).body, "Saved after rotation");
  await trace.flush();
});
