import assert from "node:assert/strict";
import test from "node:test";
import { deferred, setup } from "./helpers.mjs";

test("agent progress distinguishes generation, search, read and write with complete status and bounded text", async () => {
  const entered = deferred(), release = deferred(), updates = [];
  const app = await setup({ onCall: async ({ name }) => {
    if (name === "fetch_read") { entered.resolve(); await release.promise; }
  } });
  const original = app.store.updateJob;
  app.store.updateJob = (id, patch) => { updates.push(structuredClone(patch)); return original(id, patch); };
  try {
    const slot = app.store.reserveStory({ prompt: "Synthetic research" });
    const job = app.runtime.requestStory({ slotId: slot.slotId, prompt: "Synthetic research" });
    await entered.promise;
    const current = app.store.snapshot().jobs[0];
    assert.equal(current.status, "reading");
    assert.equal(current.phase, "reading");
    release.resolve();
    await app.runtime.waitForIdle();
    for (const [phase, status] of [["generating", "running"], ["searching", "researching"], ["reading", "reading"], ["writing", "writing"]])
      assert.equal(updates.some((entry) => entry.phase === phase && entry.status === status), true, phase);
    for (const update of updates) {
      assert.ok(update.status);
      assert.ok(update.phase);
      assert.equal(update.actor, "agent");
      assert.equal(update.parentId, job.parentId);
      if (update.phase === "generating") assert.equal(update.tool ?? null, null);
      if (update.partialText !== undefined) assert.ok(update.partialText.length <= 480);
    }
  } finally { release.resolve(); await app.runtime.close(); }
});
