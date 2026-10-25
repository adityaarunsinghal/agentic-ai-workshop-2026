import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.mjs";

test("HTTP clear and actual MCP stage/newspaper resets empty both views while history survives restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "execution-reset-routes-"));
  const config = {
    mode: "fixture", fixture: true, stateFile: join(root, "issue.json"),
    exportsDirectory: join(root, "exports"),
    fixtureChat() { throw new Error("Reset checks must not make a model request."); },
  };
  let application = await createApplication(config);
  t.after(async () => { await application.close(); await rm(root, { recursive: true, force: true }); });
  const archived = [];
  const emptyViews = async () => {
    for (const view of ["teaching", "protocol"]) {
      const response = await application.app.request(`/api/execution?view=${view}`);
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.equal(page.total, 0);
      assert.deepEqual(page.records, []);
      assert.deepEqual(application.trace.recent({ view }), []);
    }
    assert.equal(application.store.snapshot().execution.totalRecords, 0);
    assert.equal(application.store.snapshot().execution.teachingRecords, 0);
    assert.deepEqual(application.store.snapshot().trace, []);
  };
  for (const reset of ["clear", "stage", "newspaper"]) {
    const span = application.trace.start("story", { jobId: `job-${reset}`, payload: { original: reset } });
    const record = application.trace.record("agent", { jobId: `job-${reset}`, action: "job_progress",
      status: "researching", partialText: `Response before ${reset}` });
    archived.push(span.id, record.id);
    if (reset === "clear") {
      const response = await application.app.request("/api/execution/clear", { method: "POST" });
      assert.equal(response.status, 200);
    } else {
      const result = await application.mcp.callTool(reset === "stage" ? "set_stage" : "new_newspaper",
        reset === "stage" ? { stage: "editor" } : {});
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
    }
    span.finish({ status: "completed", result: `Late result after ${reset}` });
    await emptyViews();
    assert.equal((await application.trace.get(span.id)).result, `Late result after ${reset}`);
  }
  const retained = application.trace.entries;
  assert.equal(application.trace.generation, 3);
  assert.equal(application.trace.summary().archivedRecords, retained.length);
  assert.equal(application.trace.summary().requestCount, 0);
  const issueId = application.store.snapshot().issue.id;
  await application.close();
  application = await createApplication(config);
  assert.equal(application.store.snapshot().issue.id, issueId);
  assert.equal(application.trace.generation, 3);
  assert.equal(application.trace.summary().archivedRecords, retained.length);
  for (const id of archived) {
    const response = await application.app.request(`/api/execution/${id}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).record, retained.find((record) => record.id === id));
    assert.equal(application.trace.describe(id).detailAvailable, true);
  }
  const current = application.trace.list({ view: "protocol" });
  assert.ok(current.records.every((record) => record.generation === 3));
  assert.ok(current.records.every((record) => !archived.includes(record.id)));
});
