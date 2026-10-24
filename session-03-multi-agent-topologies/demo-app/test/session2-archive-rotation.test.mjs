import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutionLog } from "../src/execution-log.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "archive-rotation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("completed owners release old running progress and orphan objects without touching user files", async (t) => {
  const root = await workspace(t), directory = join(root, "issue.json.execution");
  const ledger = join(root, "issue.json.inference.json");
  await writeFile(ledger, '{"charged":0.123,"pending":0.05}');
  await writeFile(join(root, "issue.json"), '{"body":"Keep the newspaper"}');
  let log = createExecutionLog({ directory, scopeId: "paper", segmentBytes: 100000 });
  log.record({ id: "old-root", kind: "story", jobId: "old", status: "completed",
    result: "old".repeat(6000) });
  log.record({ id: "old-progress", kind: "agent", jobId: "old", action: "job_progress", status: "running" });
  await log.close(); // Seal a mixed segment, rather than a progress-only segment.
  log = createExecutionLog({ directory, scopeId: "paper", maximumArchiveBytes: 12000, rollingRetention: true });
  t.after(() => log.close());
  log.record({ id: "fresh", kind: "editor", action: "saved" });
  await log.flush();
  assert.equal(await log.get("old-root"), null);
  assert.equal(await log.get("old-progress"), null);
  assert.ok(await log.get("fresh"));
  assert.equal(log.summary().retention.retiredRecords, 2);
  assert.ok(log.summary().retention.retiredObjects > 0);
  assert.equal(log.summary().capture.droppedRecords, 0);
  assert.match(log.summary().capture.reason, /retired/);
  assert.equal(await readFile(ledger, "utf8"), '{"charged":0.123,"pending":0.05}');
  assert.equal(await readFile(join(root, "issue.json"), "utf8"), '{"body":"Keep the newspaper"}');
});

test("rotation keeps active work, complete latest I/O, and lifetime cost receipts through reopening", async (t) => {
  const root = await workspace(t), directory = join(root, "archive");
  let log = createExecutionLog({ directory, scopeId: "paper", segmentBytes: 1 });
  log.record({ id: "active", kind: "story", jobId: "active-job", status: "running", payload: { keep: "active input" } });
  for (let n = 0; n < 6; n++) {
    log.record({ id: `root-${n}`, kind: "story", jobId: `job-${n}`, status: "completed" });
    log.record({ id: `model-${n}`, kind: "model", jobId: `job-${n}`, parentId: `root-${n}`,
      operationId: `operation-${n}`, status: "completed", costUsd: 0.01 });
    log.record({ id: `http-${n}`, kind: "model.http", jobId: `job-${n}`, parentId: `model-${n}`,
      operationId: `operation-${n}`, status: "complete", payload: { request: n },
      result: { text: String(n).repeat(6000) } });
  }
  await log.close();
  log = createExecutionLog({ directory, scopeId: "paper", maximumArchiveBytes: 24000,
    segmentBytes: 1, rollingRetention: true });
  log.record({ id: "new-event", kind: "editor", action: "updated" });
  await log.flush();
  assert.ok(log.summary().retention.retiredRecords > 0);
  assert.deepEqual((await log.get("active")).payload, { keep: "active input" });
  for (const n of [4, 5]) {
    assert.deepEqual((await log.get(`http-${n}`)).payload, { request: n });
    assert.equal((await log.get(`http-${n}`)).result.text, String(n).repeat(6000));
  }
  assert.equal(log.summary().requestCount, 6);
  assert.ok(Math.abs(log.summary().reportedCostUsd - 0.06) < 1e-12);
  await log.close();
  log = createExecutionLog({ directory, scopeId: "paper", rollingRetention: true });
  t.after(() => log.close());
  assert.equal(log.summary().requestCount, 6);
  assert.ok(Math.abs(log.summary().reportedCostUsd - 0.06) < 1e-12);
  assert.ok(log.summary().retention.retiredRecords > 0);
  assert.equal((await log.get("http-5")).result.text, "5".repeat(6000));
});

test("reserve refusal and generation write failures stay nonfatal and never report a clear", async (t) => {
  const root = await workspace(t), directory = join(root, "archive");
  let log = createExecutionLog({ directory, scopeId: "paper" });
  log.record({ id: "before", kind: "editor", action: "saved" });
  await log.close();
  log = createExecutionLog({ directory, scopeId: "paper", minimumFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.doesNotThrow(() => log.record({ id: "refused", kind: "editor", payload: "new diagnostic" }));
  await log.flush();
  assert.equal(await log.get("refused"), null);
  const refused = await log.clear();
  assert.equal(refused.cleared, false);
  assert.equal(log.generation, 0);
  assert.ok(await log.get("before"));
  await log.close();
  log = createExecutionLog({ directory, scopeId: "paper" });
  t.after(() => log.close());
  await mkdir(join(directory, "scope.json.next"));
  const failed = await log.clear();
  assert.equal(failed.cleared, false);
  assert.match(failed.clearError, /not cleared/);
  assert.equal(log.generation, 0);
  assert.equal(log.list().total, 1);
  await rm(join(directory, "scope.json.next"), { recursive: true });
  assert.equal((await log.clear()).cleared, true);
  assert.equal(log.generation, 1);
  assert.equal(log.list().total, 0);
});

test("an incoming task completion releases its older segments before admitting the finish", async (t) => {
  const root = await workspace(t), directory = join(root, "archive");
  let log = createExecutionLog({ directory, scopeId: "paper", segmentBytes: 1 });
  log.record({ id: "owner", kind: "story", jobId: "job", status: "running" });
  log.record({ id: "source", kind: "source.read", jobId: "job", parentId: "owner",
    status: "complete", result: "historical evidence".repeat(1200) });
  log.record({ id: "progress", kind: "agent", jobId: "job", parentId: "owner",
    action: "job_progress", status: "running" });
  await log.close();
  log = createExecutionLog({ directory, scopeId: "paper", maximumArchiveBytes: 12000,
    rollingRetention: true, segmentBytes: 1 });
  t.after(() => log.close());
  log.record({ id: "owner", kind: "story", jobId: "job", status: "completed" });
  await log.flush();
  assert.equal((await log.get("owner")).status, "completed");
  assert.equal(await log.get("source"), null);
  assert.ok(log.summary().retention.retiredRecords > 0);
  assert.equal(log.summary().capture.droppedRecords, 0);
});
