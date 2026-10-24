import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrace } from "../src/trace.mjs";
import { createExecutionLog } from "../src/execution-log.mjs";
import { createInferenceBudget } from "../src/agent/budget.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "execution-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("history over 12 MiB survives migration and reopening while summaries stay small", async (t) => {
  const root = await workspace(t);
  const directory = join(root, "execution");
  const entries = Array.from({ length: 105 }, (_, index) => ({
    id: `retained-${index}`, kind: "model", operationId: `request-${index}`,
    status: "complete", payload: { text: "x".repeat(128 * 1024) + index },
  }));
  const trace = createTrace({ directory, scopeId: "issue" });
  await trace.restore(entries);
  assert.ok(trace.summary().logicalBytes > 12 * 1024 * 1024);
  assert.equal(trace.summary().capture.status, "complete");
  assert.equal(trace.summary().totalRecords, 105);
  const page = trace.list({ limit: 2 });
  assert.equal(page.records.length, 2);
  assert.ok(page.nextCursor);
  assert.equal(page.records[0].payload, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(trace.recent())) < 64 * 1024);
  assert.deepEqual((await trace.get("retained-104")).payload, entries[104].payload);
  await trace.close();
  const restored = createTrace({ directory, scopeId: "issue" });
  await restored.restore();
  assert.equal(restored.summary().totalRecords, 105);
  assert.deepEqual((await restored.get("retained-0")).payload, entries[0].payload);
  await restored.close();
});

test("finishing a span accounts for its details without interrupting work at a diagnostic bound", async (t) => {
  const root = await workspace(t);
  const trace = createTrace({
    directory: join(root, "small"), scopeId: "issue", maximumArchiveBytes: 30000,
  });
  const span = trace.start("mcp.call", { tool: "fetch_read" });
  const before = trace.summary().logicalBytes;
  assert.doesNotThrow(() => span.finish({ result: "article".repeat(16000) }));
  await trace.flush();
  assert.ok(trace.summary().logicalBytes > before);
  assert.equal(trace.summary().capture.status, "partial");
  assert.equal((await trace.get(span.id)).captureIncomplete, true);
  assert.doesNotThrow(() => trace.record("editor", { action: "copy_saved" }));
  await trace.close();
});

test("an unavailable diagnostic directory cannot throw into an application action or expose another scope", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "file"), "ordinary file");
  const failed = createExecutionLog({ directory: join(root, "file", "logs"), scopeId: "issue" });
  assert.doesNotThrow(() => failed.record({ id: "save", kind: "editor", action: "saved" }));
  assert.equal(failed.summary().capture.status, "partial");
  await failed.close();
  const first = createExecutionLog({ directory: join(root, "scoped"), scopeId: "one" });
  first.record({ id: "private", kind: "editor", payload: { value: "one's record" } });
  await first.close();
  const other = createExecutionLog({ directory: join(root, "scoped"), scopeId: "two" });
  assert.equal(await other.get("private"), null);
  assert.equal(other.summary().capture.status, "partial");
  await other.close();
});

test("funding survives without diagnostic history and an uncertain charge retains its reservation", async (t) => {
  const root = await workspace(t);
  const config = {
    issueId: "issue", inferenceLedgerFile: join(root, "funding.json"),
    maxInferenceCostUsd: 0.25, maxRequestCostUsd: 0.05,
  };
  const trace = { entries: [], record() {} };
  const first = createInferenceBudget({ config, trace, fixture: false });
  first.reserve("charged", { model: "test", kind: "story", payload: {} });
  first.settle("charged", 0.01);
  first.reserve("uncertain", { model: "test", kind: "story", payload: {} });
  first.settle("uncertain", null);
  const next = createInferenceBudget({ config, trace, fixture: false });
  assert.equal(next.summary().knownCostUsd, 0.01);
  assert.equal(next.summary().reservedUsd, 0.05);
  assert.deepEqual(next.summary().unsettledOperations, ["uncertain"]);
  assert.equal(next.summary().remainingUsd, 0.19);
  assert.throws(() => next.reserve("charged", { model: "test", kind: "story", payload: {} }),
    { code: "OPERATION_REUSE" });
});

test("a corrupt funding journal stops paid admission while remaining readable as unavailable", async (t) => {
  const root = await workspace(t);
  const inferenceLedgerFile = join(root, "funding.json");
  await writeFile(inferenceLedgerFile, "{broken");
  const budget = createInferenceBudget({
    config: { issueId: "issue", inferenceLedgerFile },
    trace: { entries: [], record() {} }, fixture: false,
  });
  assert.equal(budget.summary().accountingAvailable, false);
  assert.equal(budget.summary().knownCostUsd, null);
  assert.equal(budget.summary().remainingUsd, 0);
  assert.throws(() => budget.reserve("new", { model: "test", kind: "story", payload: {} }),
    { code: "BUDGET_STORAGE" });
});
