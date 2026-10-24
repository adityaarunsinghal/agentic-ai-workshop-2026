import test from "node:test";
import assert from "node:assert/strict";
import {
  factCheckDisplay, mergeSnapshots, normalizeSnapshot, projectIntents,
  recordCost, sanitizeForInspection, supersedeFailedIntents,
} from "../src/shared/state.mjs";
import { boundFrame, emptyFrame, intersects } from "../src/shared/geometry.mjs";
import { absoluteArtifact, appResource, sandboxUrl, stateFromEvent } from "../src/host/transport.mjs";
import { fixture } from "./editor-state.mjs";

test("MCP snapshot wrappers normalize without treating text errors as state", () => {
  for (const wrapper of [
    fixture, { state: fixture }, { structuredContent: fixture },
    { structuredContent: { state: fixture } }, { content: [{ type: "text", text: JSON.stringify(fixture) }] },
  ]) assert.equal(normalizeSnapshot(wrapper).issue.id, "fixture-issue");
  assert.equal(normalizeSnapshot({ content: [{ type: "text", text: "Not a snapshot" }] }), null);
});

test("older callbacks cannot replace newer copy or remove a newer optimistic move", () => {
  const newer = structuredClone(fixture);
  newer.revision = 21;
  newer.issue.revision = 11;
  newer.issue.stories[0].body = "The editor's newer copy.";
  const merged = mergeSnapshots(newer, fixture);
  assert.equal(merged.issue.stories[0].body, "The editor's newer copy.");
  const projected = projectIntents(merged, [
    { intent: { kind: "patch", target: { slotId: "slot-1" }, patch: { frame: { x: 30, y: 170, width: 90, height: 80 } } } },
    { intent: { kind: "patch", target: { slotId: "slot-1" }, patch: { headline: "My final headline" } } },
  ]);
  assert.equal(projected.issue.stories[0].frame.y, 170);
  assert.equal(projected.issue.stories[0].headline, "My final headline");
  assert.equal(projected.issue.stories[0].factCheck.status, "stale");
  assert.equal(newer.issue.stories[0].headline, fixture.issue.stories[0].headline);
});

test("an optimistic deletion stays deleted when a research completion arrives", () => {
  const completed = structuredClone(fixture);
  completed.issue.stories[1] = { ...completed.issue.stories[1], headline: "Late research", body: "Late draft", status: "ready" };
  const projected = projectIntents(completed, [{ intent: { kind: "delete", target: { slotId: "slot-2" } } }]);
  assert.equal(projected.issue.stories.some((story) => story.slotId === "slot-2"), false);
});

test("retrying an older failed edit cannot undo a newer explicit edit of the same field", () => {
  const failed = [{
    id: "failed-1", status: "failed", name: "edit_story",
    intent: { kind: "patch", target: { slotId: "slot-1" }, patch: { headline: "Keep my headline", body: "Older unsaved body" } },
    arguments: { patch: { headline: "Keep my headline", body: "Older unsaved body" } },
  }];
  const entries = supersedeFailedIntents(failed,
    { kind: "patch", target: { slotId: "slot-1" }, patch: { body: "My newer body" } });
  assert.deepEqual(entries[0].arguments.patch, { headline: "Keep my headline" });
  assert.equal(projectIntents(fixture, entries).issue.stories[0].body, fixture.issue.stories[0].body);
  assert.equal(recordCost({ usage: { cost: "0.0007" }, sdkUsage: { cost: { total: 99 } } }), .0007);
  assert.equal(recordCost({ sdkUsage: { cost: { total: 99 } } }), null);
});

test("Noul zero is an estimate; pending, stale, unavailable and failures are distinct", () => {
  assert.equal(factCheckDisplay({ factCheck: { status: "complete", probability: 0 } }).percentage, 0);
  for (const status of ["pending", "failed", "unavailable", "stale"]) {
    const display = factCheckDisplay({ factCheck: { status, probability: 0.72 } });
    assert.equal(display.percentage, null);
    assert.notEqual(display.label, "72%");
  }
  assert.equal(factCheckDisplay({ contentVersion: 4, factCheck: { probability: .3, contentVersion: 3 } }).status, "stale");
});

test("reserved regions stay in the physical page and don't cover existing stories", () => {
  assert.deepEqual(boundFrame({ x: -100, y: -100, width: 999, height: 999 }), { x: 12, y: 44, width: 273, height: 350 });
  const frames = fixture.issue.stories.map((story) => story.frame);
  const frame = emptyFrame(frames, { x: 192, y: 46 });
  assert.ok(frame);
  assert.ok(frame.x + frame.width <= 285 && frame.y + frame.height <= 404);
  assert.ok(frames.every((occupied) => !intersects(occupied, frame)));
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 192, y: 46 });
  assert.equal(emptyFrame(frames, frames[0]), null, "clicking an occupied block does not relocate or overlap it");
});

test("host and proxy use opposite origins, and only MCP App resources can load", () => {
  const proxy = sandboxUrl("http://localhost:8088");
  assert.equal(proxy.origin, "http://127.0.0.1:8088");
  assert.throws(() => sandboxUrl("http://localhost:8088", "http://localhost:8088"));
  assert.equal(appResource({ contents: [{ uri: "ui://session-02/editor-view.html", mimeType: "text/html;profile=mcp-app", text: "<html>App</html>" }] }).html, "<html>App</html>");
  assert.throws(() => appResource({ contents: [{ mimeType: "text/html", text: "<html>ordinary page</html>" }] }));
  const descriptor = absoluteArtifact({ content: [], structuredContent: { artifact: { id: "export-1", url: "/api/artifacts/export-1", filename: "paper.html" } } }, "http://localhost:8088");
  assert.equal(descriptor.artifact.url, "http://localhost:8088/api/artifacts/export-1");
});

test("stream gaps cause free resynchronization, not a replay of an action", () => {
  const changed = stateFromEvent(fixture, { revision: 18, patch: { issue: { title: "Updated masthead" } } }, "patch");
  assert.equal(changed.state.issue.title, "Updated masthead");
  assert.equal(changed.state.issue.stories.length, 2);
  assert.equal(stateFromEvent(fixture, { revision: 20, patch: {} }, "patch").gap, true);
});

test("inspection keeps full context while removing credentials and opaque replay", () => {
  const safe = sanitizeForInspection({
    payload: { headers: { authorization: "Bearer private", "x-api-key": "private" }, url: "https://user:private@example.com/?token=private" },
    usage: { input_tokens: 101, output_tokens: 22 },
    providerReplay: { secret: "private" }, content: "complete evidence",
  });
  assert.equal(safe.payload.headers.authorization, "[redacted]");
  assert.equal(safe.payload.headers["x-api-key"], "[redacted]");
  assert.ok(!safe.payload.url.includes("private"));
  assert.equal(safe.usage.input_tokens, 101);
  assert.equal(safe.content, "complete evidence");
  assert.equal(safe.providerReplay, "[redacted]");
});
