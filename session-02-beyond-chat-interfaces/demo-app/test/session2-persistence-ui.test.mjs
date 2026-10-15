import test from "node:test";
import assert from "node:assert/strict";
import { persistenceAcknowledgesFailure, persistenceDisplay, supersedePersistenceFailures } from "../ui/src/shared/persistence.mjs";
import { postTool, retryPersistence } from "../ui/src/host/transport.mjs";

test("only a confirmed save with no local changes displays Edition saved", () => {
  assert.deepEqual(persistenceDisplay({ phase: "saved" }), {
    label: "Edition saved", busy: false, saved: true, failed: false,
  });
  for (const phase of ["pending", "saving", "failed", "conflict", "readiness", "unknown", undefined]) {
    const status = persistenceDisplay({ phase });
    assert.equal(status.saved, false, String(phase));
    assert.notEqual(status.label, "Edition saved", String(phase));
  }
  for (const local of [{ pending: true }, { failed: true }, { resetting: true }])
    assert.equal(persistenceDisplay({ phase: "saved" }, local).saved, false);
  assert.equal(persistenceDisplay({ phase: "saved", error: { message: "Unconfirmed" } }).saved, false);
});

test("pending, saving, failure and conflict retain distinct accessible labels", () => {
  assert.equal(persistenceDisplay({ phase: "pending" }).label, "Changes pending");
  assert.equal(persistenceDisplay({ phase: "saving" }).label, "Saving edition…");
  assert.equal(persistenceDisplay({ phase: "failed" }).label, "Edition not saved");
  assert.equal(persistenceDisplay({ phase: "conflict" }).label, "Save conflict");
  assert.equal(persistenceDisplay({ phase: "readiness" }).label, "Readiness preview");
  assert.equal(persistenceDisplay(undefined).label, "Save not confirmed");
});

test("explicit Retry save sends one same-origin POST and returns the acknowledged state", async (t) => {
  const state = { issue: { id: "retained", revision: 7, stories: [] }, streamRevision: 99,
    persistence: { phase: "saved", version: 4, acknowledgedRevision: 7, error: null } };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (path, init) => {
    requests.push({ path, init });
    return Response.json(state);
  });
  const result = await retryPersistence();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/persistence/retry");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.deepEqual(result.persistence, state.persistence);
  assert.equal(result.issue.id, "retained");
  assert.equal(result.streamRevision, 99);
});

test("storage failure metadata reaches Host immediately without automatic retries or reloads", async (t) => {
  const persistence = { phase: "conflict", error: { code: "STORAGE_CONFLICT", message: "Another visit saved." } };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (path) => {
    requests.push(path);
    return Response.json({ error: "Another visit saved.", code: "STORAGE_CONFLICT", persistence }, { status: 409 });
  });
  for (const action of [() => retryPersistence(), () => postTool("set_title", { title: "Pending" })]) {
    await assert.rejects(action(), (error) => {
      assert.equal(error.message, "Another visit saved.");
      assert.equal(error.status, 409);
      assert.equal(error.code, "STORAGE_CONFLICT");
      assert.deepEqual(error.persistence, persistence);
      return true;
    });
  }
  assert.deepEqual(requests, ["/api/persistence/retry", "/api/mcp/tools/set_title"]);
});

test("retry cannot infer saved from an incomplete success response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ issue: { id: "retained" } }));
  await assert.rejects(retryPersistence(), /did not confirm the save status/);
});

test("a second failed title supersedes the first title's recovery record", () => {
  const first = { id: "A", issueId: "paper", epoch: 0, message: "Storage failed",
    version: 4, revision: 7, intent: { kind: "issue", patch: { title: "A" } } };
  const second = { ...first, id: "B", revision: 8, intent: { kind: "issue", patch: { title: "B" } } };
  const remaining = supersedePersistenceFailures([first], second.intent, { issueId: "paper", epoch: 0 });
  remaining.push(second);
  assert.deepEqual(remaining.map((failure) => failure.id), ["B"]);
  assert.deepEqual(first.intent.patch, { title: "A" }, "the original failure is not mutated");
});

test("supersession retains conflicting fields, foreign papers and other story slots", () => {
  const first = { id: "A", status: "failed", issueId: "paper", epoch: 1, intent: {
    kind: "patch", target: { slotId: "one" }, patch: { headline: "A", body: "Keep this unsaved body" },
  } };
  const others = [
    { ...first, id: "other-paper", issueId: "foreign" },
    { ...first, id: "older-generation", epoch: 0 },
    { ...first, id: "other-slot", intent: { ...first.intent, target: { slotId: "two" } } },
  ];
  const retained = supersedePersistenceFailures([first, ...others],
    { kind: "patch", target: { slotId: "one" }, patch: { headline: "B" } }, { issueId: "paper", epoch: 1 });
  assert.deepEqual(retained[0].intent.patch, { body: "Keep this unsaved body" });
  assert.deepEqual(retained.slice(1), others);
});

test("a same-version journal acknowledgement clears recovery only when that edit is durably covered", () => {
  const failure = { version: 5, revision: 12 };
  const acknowledged = { phase: "saved", error: null, version: 5, acknowledgedRevision: 12 };
  assert.equal(persistenceAcknowledgesFailure(acknowledged, failure), true);
  assert.equal(persistenceAcknowledgesFailure({ ...acknowledged, version: 6 }, failure), true);
  for (const patch of [
    { phase: "failed" }, { phase: "pending" }, { phase: "saving" },
    { error: { message: "Journal still pending" } }, { error: undefined },
    { version: 4 }, { version: undefined }, { acknowledgedRevision: 11 },
    { acknowledgedRevision: undefined },
  ]) assert.equal(persistenceAcknowledgesFailure({ ...acknowledged, ...patch }, failure), false, JSON.stringify(patch));
});
