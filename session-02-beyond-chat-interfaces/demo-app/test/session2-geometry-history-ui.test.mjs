import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { layoutMeasurementKey } from "../ui/src/shared/geometry.mjs";
import { templateStoryPlans } from "../src/layout-templates.mjs";

// Load the real JSX and React state machine. Only the MCP connection is a
// fixture; its recorded calls prove no-op gestures do not enter the write queue.
async function mount(t, component) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/", pretendToBeVisual: true });
  // jsdom has no modal placement or layout observers. These shims exercise
  // the actual component actions without claiming browser geometry coverage.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const globals = {};
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
  })) {
    globals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(globals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(() => root.render(component));
  return { root, document: dom.window.document };
}

async function modules(t, app) {
  const key = `__session2GeometryTest${Math.random().toString(36).slice(2)}`;
  globalThis[key] = app;
  const server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../ui", import.meta.url)),
    server: { middlewareMode: true, watch: null, hmr: false },
    ssr: { noExternal: ["@modelcontextprotocol/ext-apps"] },
    plugins: [{
      name: "offline-mcp-connection",
      enforce: "pre",
      resolveId(id) { if (id === "@modelcontextprotocol/ext-apps/react") return "\0offline-mcp"; },
      load(id) {
        if (id === "\0offline-mcp") return `export function useApp(options) {
          options.onAppCreated(globalThis[${JSON.stringify(key)}]);
          return {isConnected: true};
        }`;
      },
    }],
  });
  t.after(async () => { await server.close(); delete globalThis[key]; });
  return server;
}

test("UI micro-jitter and seven unchanged gestures never flush copy or send moves", async (t) => {
  const frame = { x: 12, y: 44, width: 86, height: 104 };
  let snapshot = {
    issue: { id: "paper", revision: 1, stories: [{
      id: "slot", slotId: "slot", frame, body: "Saved copy", contentVersion: 1, locked: false,
    }], sources: [] },
    settings: { stage: "research" }, jobs: [], streamRevision: 1,
    persistence: { phase: "saved" },
  };
  const calls = [], pending = [];
  const app = {
    callServerTool: async (request) => {
      calls.push(request);
      if (request.name === "move_story") {
        const next = structuredClone(snapshot);
        next.issue.stories[0].frame = request.arguments.frame;
        next.issue.revision++; next.streamRevision++;
        await new Promise((resolve) => pending.push(resolve));
        snapshot = next;
      }
      return { structuredContent: structuredClone(snapshot) };
    },
  };
  const loader = await modules(t, app);
  const { useEditor } = await loader.ssrLoadModule("/src/editor/useEditor.jsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  let controller;
  function Probe() { controller = useEditor(); return null; }
  await mount(t, React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.ok(controller.state);
  const story = controller.state.issue.stories[0];
  await act(() => controller.draftStory(story, { body: "Unsaved human copy" }));
  for (let index = 0; index < 7; index++)
    await act(() => controller.moveStory(story, { ...frame, width: 85.99, height: 103.98 }));
  assert.equal(controller.dirty, true);
  assert.equal(controller.state.issue.stories[0].body, "Unsaved human copy");
  assert.equal(controller.pending.length, 0);
  assert.deepEqual(calls.map((entry) => entry.name), ["get_editor_state"]);

  let first, duplicate;
  await act(async () => {
    first = controller.moveStory(story, { ...frame, x: 40, width: 85.99, height: 103.98 });
    duplicate = controller.moveStory(story, { ...frame, x: 40 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(pending.length, 1);
  assert.deepEqual(calls.at(-1).arguments.frame, { ...frame, x: 40 });
  await act(async () => { pending.shift()(); await Promise.all([first, duplicate]); });
  assert.equal(calls.filter((entry) => entry.name === "move_story").length, 1,
    "queued duplicate is satisfied after the first authoritative move");
  assert.equal(calls.some((entry) => entry.name === "edit_story"), false,
    "size jitter during a real move must not flush a copy draft");
});

test("ToolsStage labels unavailable saved briefings, inspects them locally and cancels only live jobs", async (t) => {
  const loader = await modules(t, {});
  const { ToolsStage } = await loader.ssrLoadModule("/src/host/ToolsStage.jsx");
  const old = {
    id: "old", jobId: "old", status: "interrupted", prompt: "Earlier prompt",
    answer: "", partialText: "Keep the surviving words", cards: [],
    executionHistory: { available: false, recordId: null, taskId: "old", origin: "earlier_visit",
      label: "Saved result from an earlier visit. Full Execution history is unavailable." },
  };
  const fresh = { id: "fresh", jobId: "fresh", status: "researching", prompt: "Current prompt", cards: [],
    executionHistory: { available: true, recordId: null, taskId: "fresh", origin: "current_visit" } };
  const calls = [], inspected = [], executions = [];
  const state = { issue: { sources: [] }, briefings: [old, fresh],
    jobs: [{ id: "fresh", type: "briefing", status: "researching" }] };
  const view = await mount(t, React.createElement(ToolsStage, {
    state,
    callTool: async (name, args) => { calls.push({ name, args }); return { structuredContent: { cancelled: true } }; },
    onInspect: (...args) => inspected.push(args), onExecution: (...args) => executions.push(args),
  }));
  const [saved, current] = view.document.querySelectorAll(".host-briefing");
  assert.match(saved.textContent, /earlier visit.*Full Execution history is unavailable/);
  assert.match(saved.textContent, /Saved partial response/);
  assert.match(saved.textContent, /Keep the surviving words/);
  assert.doesNotMatch(saved.textContent, /Open Execution|Cancel briefing|response in progress/);
  await act(() => [...saved.querySelectorAll("button")].find((button) => /Inspect saved briefing/.test(button.textContent)).click());
  assert.equal(inspected[0][0].partialText, old.partialText);
  assert.match(inspected[0][1], /full trace unavailable/);
  assert.deepEqual(calls, []);
  await act(() => [...current.querySelectorAll("button")].find((button) => button.textContent === "Open Execution").click());
  assert.deepEqual(executions, [[null, "fresh"]]);
  await act(async () => { [...current.querySelectorAll("button")].find((button) => button.textContent === "Cancel briefing").click(); });
  assert.deepEqual(calls, [{ name: "cancel_briefing", args: { jobId: "fresh" } }]);
});

const earlierReceipt = {
  requestId: "earlier-review", status: "complete", model: "synthetic-model",
  durationMs: 12, inputRevision: 3, resultRevision: 4,
  answers: { lead: { type: "choice", choice: "preserved-lead" } },
  executionHistory: { available: false, recordId: "earlier-review", taskId: null, origin: "earlier_visit",
    label: "Saved result from an earlier visit. Full Execution history is unavailable." },
};
const buttonWith = (element, text) => [...element.querySelectorAll("button")].find((button) => button.textContent === text);
async function expandJson(dialog) {
  const expand = buttonWith(dialog, "Expand tree");
  if (expand) await act(() => expand.click());
}

test("editorial status opens a compact saved result locally and keeps readable IDs actionable", async (t) => {
  const loader = await modules(t, {});
  const { EditorialStatus } = await loader.ssrLoadModule("/src/editor/EditorialStatus.jsx");
  const opened = [], before = JSON.stringify(earlierReceipt);
  const props = { editorial: earlierReceipt, issueRevision: 4, onExecution: (id) => opened.push(id) };
  const view = await mount(t, React.createElement(EditorialStatus, props));
  assert.match(view.document.body.textContent, /Saved result from an earlier visit/);
  assert.equal(buttonWith(view.document, "Open Execution"), undefined);
  await act(() => buttonWith(view.document, "Inspect saved result").click());
  let dialog = view.document.querySelector("dialog[open]");
  assert.match(dialog.textContent, /Saved editorial result/);
  assert.match(dialog.textContent, /compact result saved with the newspaper/);
  assert.match(dialog.textContent, /does not contain the full Execution trace/);
  assert.ok(dialog.querySelector('[aria-label="JSON inspector"]'));
  await expandJson(dialog);
  assert.match(dialog.textContent, /preserved-lead/);
  assert.deepEqual(opened, []);
  assert.equal(JSON.stringify(earlierReceipt), before);
  await act(() => buttonWith(dialog, "Close").click());
  for (const origin of ["current_visit", "earlier_visit"]) {
    const readable = { ...earlierReceipt, requestId: `readable-${origin}`,
      executionHistory: { available: true, origin } };
    await act(() => view.root.render(React.createElement(EditorialStatus, { ...props, editorial: readable })));
    assert.equal(buttonWith(view.document, "Inspect saved result"), undefined);
    await act(() => buttonWith(view.document, "Open Execution").click());
    assert.equal(opened.at(-1), readable.requestId);
  }
});

test("Execution receipts and initial old IDs inspect saved JSON without fetching; fresh and archived records stay readable", async (t) => {
  const loader = await modules(t, {});
  const { Execution } = await loader.ssrLoadModule("/src/shared/Execution.jsx");
  const client = new QueryClient();
  t.after(() => client.clear());
  const fresh = { ...earlierReceipt, requestId: "fresh-review", model: "fresh-model",
    executionHistory: { available: true, origin: "current_visit" } };
  const archived = { ...earlierReceipt, requestId: "archived-review", model: "archived-model",
    executionHistory: { available: true, origin: "earlier_visit" } };
  const reads = [], originals = new Map([fresh, archived].map((receipt) => [
    receipt.requestId, { id: receipt.requestId, kind: "editorial", status: "complete",
      label: `Original ${receipt.model}`, payload: { questions: { exact: "Original archived question" } },
      result: { answers: { exact: "Original archived response" } } },
  ]));
  const props = {
    issueId: "paper", editorialHistory: [earlierReceipt, fresh, archived], initialRecordId: earlierReceipt.requestId,
    listExecution: async () => ({ records: [], total: 0, nextCursor: null }),
    getExecutionRecord: async (id) => {
      reads.push(id);
      assert.ok(originals.has(id), "an unavailable old receipt must never trigger an original-record fetch");
      return originals.get(id);
    },
  };
  const view = await mount(t, React.createElement(QueryClientProvider, { client },
    React.createElement(Execution, props)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  let dialog = view.document.querySelector("dialog[open]");
  assert.match(dialog.textContent, /Saved editorial result/);
  await expandJson(dialog);
  assert.match(dialog.textContent, /preserved-lead/);
  assert.deepEqual(reads, []);
  await act(() => buttonWith(dialog, "Close").click());

  const rows = [...view.document.querySelectorAll(".editorial-receipts tbody tr")];
  assert.match(rows[0].textContent, /Full Execution history is unavailable/);
  await act(() => buttonWith(rows[0], "Inspect saved result").click());
  assert.deepEqual(reads, []);
  await act(() => buttonWith(view.document.querySelector("dialog[open]"), "Close").click());
  for (let index = 1; index <= 2; index++) {
    await act(async () => { buttonWith(rows[index], "Open Execution").click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    dialog = view.document.querySelector("dialog[open]");
    assert.match(dialog.textContent, /Original (fresh|archived)-model/);
    assert.doesNotMatch(dialog.textContent, /compact result saved with the newspaper/);
    await expandJson(dialog);
    assert.match(dialog.textContent, /Original archived question/);
    assert.match(dialog.textContent, /Original archived response/);
    await act(() => buttonWith(dialog, "Close").click());
  }
  assert.deepEqual(reads, [fresh.requestId, archived.requestId]);
  await act(() => buttonWith(view.document, "Return to record").click());
  dialog = view.document.querySelector("dialog[open]");
  await act(() => buttonWith(dialog, "← Previous record").click());
  await act(() => buttonWith(view.document.querySelector("dialog[open]"), "← Previous record").click());
  assert.match(view.document.querySelector("dialog[open]").textContent, /Saved editorial result/);
  assert.equal(reads.includes(earlierReceipt.requestId), false);
  assert.equal(client.getQueryData(["execution-record", "paper", earlierReceipt.requestId]), undefined,
    "compact saved receipts never masquerade as captured execution records in the query cache");
});

test("a layout recommendation waits for approval, and declining keeps all current geometry", async (t) => {
  const loader = await modules(t, {});
  const { LayoutSuggestion } = await loader.ssrLoadModule("/src/editor/LayoutSuggestion.jsx");
  const story = { id: "human", slotId: "human", headline: "Human headline", body: "Retain human copy.",
    contentVersion: 1, frame: { x: 40, y: 150, width: 86, height: 104 } };
  const state = {
    issue: { id: "layout-paper", revision: 4, layoutTemplate: "newspaper", stories: [story] },
    settings: { editorLayout: "side_by_side" }, jobs: [],
    editorial: { status: "complete", requestId: "proposal-1", resultRevision: 4 },
    layoutOperation: { id: crypto.randomUUID(), status: "offered", reviewRequestId: "proposal-1" },
  };
  const assignment = templateStoryPlans(state.issue, "side_by_side")[0];
  const measurements = { human: { key: layoutMeasurementKey(story), ready: true,
    template: { ...assignment, requiredHeight: 60 } } };
  const calls = [], original = structuredClone(state.issue);
  const controller = { authoritative: state, dirty: false, pending: [], failed: [],
    run: async (name, args) => { calls.push({ name, args }); return true; } };
  const props = { state, measurements, controller };
  const view = await mount(t, React.createElement(LayoutSuggestion, props));
  assert.match(view.document.body.textContent, /Approve Side by Side layout/);
  assert.deepEqual(calls, []);
  assert.deepEqual(state.issue, original);
  await act(() => buttonWith(view.document, "Decline").click());
  assert.deepEqual(calls, []);
  assert.deepEqual(state.issue, original);
  assert.equal(view.document.querySelector(".layout-suggestion"), null);

  const sameIntent = { ...state, editorial: { ...state.editorial, requestId: "proposal-2" },
    layoutOperation: { ...state.layoutOperation, reviewRequestId: "proposal-2" } };
  controller.authoritative = sameIntent;
  await act(() => view.root.render(React.createElement(LayoutSuggestion, { ...props, state: sameIntent })));
  assert.equal(view.document.querySelector(".layout-suggestion"), null, "a fresh receipt alone cannot reopen a handled intent");
  const next = { ...sameIntent, layoutOperation: { ...sameIntent.layoutOperation, id: crypto.randomUUID() } };
  controller.authoritative = next;
  await act(() => view.root.render(React.createElement(LayoutSuggestion, { ...props, state: next })));
  await act(async () => { buttonWith(view.document, "Approve").click(); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "apply_layout");
  assert.equal(calls[0].args.baseRevision, 4);
  assert.equal(calls[0].args.template, "side_by_side");
  assert.equal(calls[0].args.approval.intentId, next.layoutOperation.id);
  assert.equal(calls[0].args.frames[0].slotId, "human");
  assert.notDeepEqual(calls[0].args.frames[0].frame, original.stories[0].frame);
  assert.deepEqual(state.issue, original, "only the authoritative tool response may replace geometry");
  const legacy = { ...state, issue: { ...state.issue, id: "warm-backend" }, layoutOperation: undefined };
  controller.authoritative = legacy;
  await act(() => view.root.render(React.createElement(LayoutSuggestion, { ...props, state: legacy })));
  await act(async () => { buttonWith(view.document, "Approve").click(); });
  assert.equal(calls[1].args.approval, undefined, "the warm backend still receives the legacy arguments");
});

test("settled layout status preserves the recorded model, timing and original receipt", async (t) => {
  const loader = await modules(t, {});
  const { EditorialStatus } = await loader.ssrLoadModule("/src/editor/EditorialStatus.jsx");
  const editorial = {
    status: "complete", resultRevision: 4, requestId: "original-review",
    backend: "chat", model: "fixture/recorded-model", durationMs: 2500,
  };
  const original = structuredClone(editorial);
  const view = await mount(t, React.createElement(EditorialStatus, {
    editorial, issueRevision: 5, summary: true, settled: true,
  }));
  assert.match(view.document.body.textContent, /Layout settled/);
  assert.match(view.document.body.textContent, /recorded-model/);
  assert.match(view.document.body.textContent, /2\.50 s/);
  assert.deepEqual(editorial, original);
  await act(() => view.root.render(React.createElement(EditorialStatus, {
    editorial, issueRevision: 6, summary: true, settled: false,
  })));
  assert.match(view.document.body.textContent, /Earlier choices/);
});
