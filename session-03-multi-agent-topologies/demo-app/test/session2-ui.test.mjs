import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage, factCheckDisplay, inferenceRequests, mergeSnapshots, normalizeSnapshot, recordCost } from "../ui/src/shared/state.mjs";
import {
  compactRecords, executionPage, executionParams, executionRecord, executionRunScope,
  executionTotals, groupTeachingRecords, LOCAL_SUMMARY_LIMIT, relatedRecordIds,
} from "../ui/src/shared/execution.mjs";
import {
  assessmentDetails, assessmentReference, editorialOutcome,
  receiptInputSets, recommendedView,
} from "../ui/src/shared/editorial.mjs";
import { briefingViews } from "../ui/src/shared/briefings.mjs";
import { requestRevisionDemo, REVISION_DEMO_MESSAGE } from "../ui/src/shared/revision-demo.mjs";
import { postBrowserRecord, stateFromEvent } from "../ui/src/host/transport.mjs";
import { persistBrowserRecord } from "../ui/src/host/browser-records.mjs";

test("Execution counts each dispatch once and retains its reported charge across SDK request events", () => {
  const requests = inferenceRequests([
    { kind: "model", operationId: "chat-1", usage: { cost: 0.002, prompt_tokens: 50 } },
    { kind: "model.request", operationId: "chat-1", payload: { model: "fixture-chat" } },
    { kind: "model.response", operationId: "chat-1", usage: { cost: 0.002 } },
    { kind: "decision", purpose: "Editor tool wrapper" },
    { kind: "decision", operationId: "native-1", usage: { cost: 0.0001 } },
    { kind: "decision.request", operationId: "native-1", payload: { model: "fixture-native" } },
    { kind: "model", operationId: "unknown-charge", usage: null },
  ]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(recordCost), [0.002, 0.0001, null]);
  assert.equal(requests[0].usage.prompt_tokens, 50);
});

test("a failed research job renders its structured error as visible text", () => {
  assert.equal(errorMessage({ code: "INFERENCE_FAILED", message: "The request timed out." }), "The request timed out.");
  assert.equal(errorMessage("Evidence is missing."), "Evidence is missing.");
});

const snapshot = (patch = {}) => ({
  streamRevision: 1,
  issue: { id: "issue-a", revision: 4, stories: [{ id: "human-story", body: "Keep my exact copy." }], sources: [] },
  settings: { stage: "editor", model: "selected-general-model", editorLayout: "newspaper" },
  jobs: [], trace: [], ...patch,
});

test("repeated snapshots retain only 50 summaries, never archived input or output", () => {
  let state = normalizeSnapshot(snapshot());
  for (let index = 0; index < 180; index++) {
    state = mergeSnapshots(state, normalizeSnapshot(snapshot({
      streamRevision: index + 2,
      trace: [{ id: `record-${index}`, kind: "editorial", status: "complete", sequence: index,
        payload: { text: "Large original input" }, result: { answer: "Large original output" } }],
    })));
  }
  assert.equal(state.trace.length, 50);
  assert.equal(state.trace[0].id, "record-130");
  assert.equal(state.trace.at(-1).id, "record-179");
  assert.ok(state.trace.every((record) => !("payload" in record) && !("result" in record)));
  assert.equal(state.issue.stories[0].body, "Keep my exact copy.");
});

test("an older activity snapshot cannot roll completed editorial choices back to running", () => {
  const complete = normalizeSnapshot(snapshot({
    streamRevision: 12, editorial: { requestId: "review", status: "complete", resultRevision: 4 },
    settings: { stage: "editor", editorLayout: "comparison" },
  }));
  const late = normalizeSnapshot(snapshot({
    streamRevision: 11, editorial: { requestId: "review", status: "running" },
  }));
  const state = mergeSnapshots(complete, late);
  assert.equal(state.editorial.status, "complete");
  assert.equal(state.settings.editorLayout, "comparison");
  const patch = stateFromEvent(state, { streamRevision: 13, patch: {
    editorial: { requestId: "next-review", status: "running" },
  } }, "patch");
  assert.equal(patch.state.streamRevision, 13);
  assert.equal(patch.state.editorial.requestId, "next-review");
  assert.equal(stateFromEvent(patch.state, { streamRevision: 15, patch: {} }, "patch").gap, true);
});

test("Execution pages are bounded and originals are accessed separately", () => {
  const original = { id: "past-request", kind: "model.provider_event", payload: { complete: "input" }, result: { complete: "output" } };
  const page = executionPage({ executionPage: { records: [original], nextCursor: "41", total: 1200 } });
  assert.equal(page.records[0].kind, "model.provider_event");
  assert.equal(page.records[0].payload, undefined);
  assert.equal(page.nextCursor, "41");
  assert.deepEqual(executionRecord({ executionRecord: original }), original);
  assert.deepEqual(executionRecord({ record: original }), original);
  assert.throws(() => executionPage({ records: Array(51).fill(original) }), /page limit/);
  assert.deepEqual(executionParams({ view: "protocol", cursor: "41", limit: 5000, query: "  request-a  ", taskId: "run-a" }),
    { view: "protocol", cursor: "41", limit: 50, query: "request-a", taskId: "run-a" });
});

test("aggregate budget survives filtering and unavailable accounting never becomes zero", () => {
  const archive = { totalRecords: 8000, requestCount: 6, reportedCostUsd: 0.5,
    budget: { accountingAvailable: true, knownCostUsd: 0.75, reservedUsd: 0.2, unsettledOperations: ["unsettled"] } };
  const total = executionTotals(archive, {}, { totalRecords: 1, reportedCostUsd: 0 });
  assert.equal(total.total, 8000);
  assert.equal(total.requests, 6);
  assert.equal(total.knownCostUsd, 0.75);
  assert.equal(total.unknown, 1);
  const unavailable = executionTotals({ ...archive, budget: { accountingAvailable: false, error: "Ledger unavailable", knownCostUsd: 0 } });
  assert.equal(unavailable.knownCostUsd, null);
  assert.equal(unavailable.reservedUsd, null);
  assert.equal(unavailable.accountingError, "Ledger unavailable");
  assert.equal(executionTotals().knownCostUsd, null);
  assert.equal(executionTotals({ reportedCostUsd: 0 }).knownCostUsd, 0);
});

test("Execution opens the requested or active run and keeps issue-level record links global", () => {
  const records = [
    { id: "model-a", taskId: "run-a", kind: "model" },
    { id: "editorial-a", kind: "editorial", requestId: "editorial-a" },
  ];
  const jobs = [
    { id: "run-a", status: "completed" },
    { id: "run-b", status: "researching" },
    { id: "run-c", status: "queued" },
  ];
  assert.equal(executionRunScope({ records, jobs }), "run-c");
  assert.equal(executionRunScope({ recordId: "model-a", records, jobs }), "run-a");
  assert.equal(executionRunScope({ taskId: "run-b", recordId: "model-a", records, jobs }), "run-b");
  assert.equal(executionRunScope({ recordId: "run-a", records, jobs }), "run-a");
  assert.equal(executionRunScope({ recordId: "editorial-a", records, jobs }), "");
  assert.equal(executionRunScope({ recordId: "older-record", records, jobs }), "");
  assert.equal(executionRunScope({ records, jobs: jobs.slice(0, 1) }), "");
});

test("grouped requests and related links preserve off-page parent identity and original event names", () => {
  const records = compactRecords([
    { id: "tool-1", taskId: "run-a", parentId: "off-page-parent", kind: "agent.tool_execution_end", label: "Tool result" },
    { id: "turn-1", taskId: "run-a", kind: "agent.turn_end", label: "Turn complete" },
  ]);
  const groups = groupTeachingRecords(records);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].records[0].kind, "agent.tool_execution_end");
  assert.equal(groups[0].records[0].parentId, "off-page-parent");
  assert.deepEqual(relatedRecordIds({ id: "off-page-parent" }, records), ["tool-1"]);
});

test("completed editorial choices recommend a paper template while retaining the user's applied geometry", () => {
  const issue = {
    ...snapshot().issue, layoutTemplate: "newspaper",
    stories: [{ id: "human-story", slotId: "human-story", body: "Keep my exact copy.",
      frame: { x: 40, y: 150, width: 86, height: 104 } }],
  };
  const state = snapshot({
    issue, settings: { stage: "editor", editorLayout: "side_by_side" },
    editorial: { requestId: "review-a", status: "complete", resultRevision: 4 },
  });
  assert.deepEqual(recommendedView(state.settings), { id: "side_by_side", label: "Side by Side" });
  const completed = mergeSnapshots(normalizeSnapshot(state), normalizeSnapshot({
    ...state, streamRevision: 2, settings: { ...state.settings, editorLayout: "breaking_news" },
    editorial: { requestId: "review-b", status: "complete", resultRevision: 4 },
  }));
  assert.equal(recommendedView(completed.settings).id, "breaking_news");
  assert.deepEqual(completed.issue, issue);
  assert.equal(recommendedView({ editorLayout: "unsupported" }), null);
});

test("editorial statuses and timing sets distinguish stale, failed, superseded and different questions", () => {
  assert.equal(editorialOutcome({ status: "complete", resultRevision: 4 }, 5).status, "stale");
  assert.equal(editorialOutcome({ status: "superseded" }).label, "Superseded; result was not applied");
  assert.equal(editorialOutcome({ status: "failed" }).status, "failed");
  assert.equal(editorialOutcome({ status: "running" }).status, "running");
  const story = { factCheck: { requestId: "previous", status: "complete", probability: 0 } };
  for (const status of ["running", "failed", "superseded"]) {
    const display = factCheckDisplay(story, { requestId: "next", backend: "decisions", status });
    assert.equal(display.percentage, null);
    assert.equal(display.status, status === "superseded" ? "stale" : status);
  }
  assert.equal(story.factCheck.probability, 0);
  const receipts = [
    { model: "general", inputDigest: "input-a", questionDigest: "choices" },
    { model: "jev", inputDigest: "input-a", questionDigest: "choices-and-noul" },
    { model: "general", inputDigest: "input-b", questionDigest: "choices" },
    { model: "general", inputDigest: "input-a", questionDigest: "choices", cached: true },
    { model: "general" },
  ];
  assert.deepEqual(receiptInputSets(receipts).map((entry) => entry.inputSet), [1, 2, 3, 1, null]);
});

test("shared Choice matching recognizes chat/native while keeping extra Noul and different inputs distinct", () => {
  const chat = { model: "general", inputDigest: "state-a", choiceQuestionDigest: "choices-a",
    questionDigest: "choices-a", questionsCount: 3, choiceCount: 3, noulCount: 0 };
  const native = { model: "jev", inputDigest: "state-a", choiceQuestionDigest: "choices-a",
    questionDigest: "choices-and-checks", questionsCount: 5, choiceCount: 3, noulCount: 2 };
  const receipts = [
    chat, native, { ...native, inputDigest: "state-b" },
    { ...chat, choiceQuestionDigest: "choices-b", questionDigest: "choices-b" },
    { ...native, cached: true },
    { model: "legacy", inputDigest: "state-a", questionDigest: "choices-a" },
    { model: "partial", inputDigest: "state-a", choiceQuestionDigest: "choices-a" },
  ];
  const sets = receiptInputSets(receipts);
  assert.deepEqual(sets.map((entry) => entry.choiceSet), [1, 1, 2, 3, 1, null, 1]);
  assert.deepEqual(sets.map((entry) => entry.inputSet), [1, 2, 3, 4, 2, 1, null]);
  assert.equal(sets[0].receipt.noulCount, 0);
  assert.equal(sets[1].receipt.noulCount, 2);
  assert.equal(sets[6].receipt.noulCount, undefined);
});

test("Evidence recovers the exact question and zero-valued answer from an off-page original record", () => {
  const check = { requestId: "old-editorial" };
  const original = { id: "old-editorial", payload: { questions: { check_story: {
    type: "noul", instructions: "The exact supplied question", criteria: { true: "Needs verification", false: "Within supplied evidence" },
  } } }, result: { answers: { check_story: { type: "noul", noul: 0 } } } };
  assert.equal(assessmentReference(check), "old-editorial");
  const details = assessmentDetails(check, executionRecord({ record: original }), "story");
  assert.equal(details.question.instructions, "The exact supplied question");
  assert.deepEqual(details.response, { type: "noul", noul: 0 });
  assert.equal(assessmentDetails(check, undefined, "story").question, undefined);
});

test("tools-stage briefing display uses briefing jobs and cards without borrowing a newspaper slot", () => {
  const state = snapshot({
    briefings: [{ id: "briefing-a", jobId: "job-a", prompt: "HN reliability", cards: [{ id: "source-a", note: "Read this." }], partialText: "Observed so far…" }],
    jobs: [{ id: "job-a", type: "briefing", status: "researching", turn: 2, sourceIds: ["source-a"] }],
  });
  const [briefing] = briefingViews(state);
  assert.equal(briefing.id, "briefing-a");
  assert.equal(briefing.status, "researching");
  assert.equal(briefing.partialText, "Observed so far…");
  assert.deepEqual(briefing.sourceIds, ["source-a"]);
  assert.equal(briefing.job.turn, 2);
  assert.equal(briefingViews(snapshot()).length, 0);
  assert.equal(state.issue.stories.length, 1);
});

test("the revision placeholder makes exactly one app-tool call and requires the backend's exact confirmation", async () => {
  const calls = [];
  const result = await requestRevisionDemo(async (name, args) => {
    calls.push({ name, args });
    return { structuredContent: { message: REVISION_DEMO_MESSAGE } };
  });
  assert.deepEqual(calls, [{ name: "revise_copy_demo", args: {} }]);
  assert.equal(result.message, "Auto-revisions would have started");
  let failedCalls = 0;
  await assert.rejects(requestRevisionDemo(async () => {
    failedCalls++;
    return { structuredContent: { message: "Research started" } };
  }), /unexpected confirmation/);
  assert.equal(failedCalls, 1);
});

const browserEvent = {
  id: "b85ddeea-93ab-4a2e-a84c-725bc5064b37", kind: "mcp.resource",
  actor: "app", status: "complete", startedAt: "2026-10-14T12:00:00Z",
  parentId: "canonical-resource-call",
  payload: { uri: "ui://session-02/editor-view.html", method: "resources/read" },
  result: { bytes: 8192, mimeType: "text/html;profile=mcp-app" },
};
const browserAck = (event = browserEvent) => ({
  id: `browser:${event.id}`, kind: event.kind, actor: "host", reportedBy: "browser",
  status: "complete", parentId: event.parentId, sequence: 41,
});

test("browser transport sends only bounded same-origin diagnostics with the canonical parent", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls++;
    assert.equal(path, "/api/execution/browser");
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.redirect, "error");
    const posted = JSON.parse(options.body);
    assert.equal(posted.id, browserEvent.id);
    assert.equal(posted.parentId, "canonical-resource-call");
    assert.deepEqual(posted.payload, browserEvent.payload);
    assert.equal(posted.actor, undefined);
    assert.equal(posted.reportedBy, undefined);
    assert.equal(posted.operationId, undefined);
    assert.equal(posted.costUsd, undefined);
    return new Response(JSON.stringify({ record: browserAck() }));
  });
  const summary = await postBrowserRecord({ ...browserEvent, operationId: "not-authority", costUsd: 99 });
  assert.equal(calls, 1);
  assert.equal(summary.id, `browser:${browserEvent.id}`);
  assert.equal(summary.reportedBy, "browser");
  assert.equal(summary.payload, undefined);
  await assert.rejects(postBrowserRecord({ ...browserEvent, kind: "model.request" }), /unsupported/);
  await assert.rejects(postBrowserRecord({ ...browserEvent, payload: { text: "é".repeat(32 * 1024) } }), /64 KiB/);
  assert.equal(calls, 1);
});

test("a browser acknowledgment removes the local event UUID and retains concurrent tab reports", async () => {
  let local = [{ id: "another-local-event", label: "Keep this report", deliveryStatus: "failed" }];
  let resolveSend;
  let acknowledged;
  const sending = persistBrowserRecord(browserEvent, {
    send: () => new Promise((resolve) => { resolveSend = resolve; }),
    updateLocal: (update) => { local = update(local); },
    onAcknowledged: (record) => { acknowledged = record; },
  });
  assert.equal(local.at(-1).id, browserEvent.id);
  assert.equal(local.at(-1).deliveryStatus, "pending");
  assert.equal(local.at(-1).payload, undefined);
  resolveSend(browserAck());
  assert.equal((await sending).id, `browser:${browserEvent.id}`);
  assert.equal(acknowledged.id, `browser:${browserEvent.id}`);
  assert.deepEqual(local.map((entry) => entry.id), ["another-local-event"]);
});

test("a mismatched archive receipt leaves a tab-only fallback and never retries the interaction", async (t) => {
  let sends = 0, archived = 0, local = [];
  t.mock.method(globalThis, "fetch", async () => {
    sends++;
    return new Response(JSON.stringify({ record: { ...browserAck(), id: browserEvent.id } }));
  });
  assert.equal(await persistBrowserRecord(browserEvent, {
    send: postBrowserRecord,
    updateLocal: (update) => { local = update(local); },
    onAcknowledged: () => { archived++; },
  }), null);
  assert.equal(sends, 1);
  assert.equal(archived, 0);
  assert.equal(local.length, 1);
  assert.equal(local[0].id, browserEvent.id);
  assert.equal(local[0].deliveryStatus, "failed");
  assert.match(local[0].deliveryError, /did not acknowledge/);
});

test("unavailable diagnostic storage keeps bounded fallback summaries without retrying or retaining payloads", async () => {
  let local = [], sends = 0, archived = 0;
  for (let index = 0; index < LOCAL_SUMMARY_LIMIT + 5; index++) {
    await persistBrowserRecord({ ...browserEvent, id: `local-${index}` }, {
      send: async () => { sends++; throw new Error("Archive unavailable"); },
      updateLocal: (update) => { local = update(local); },
      onAcknowledged: () => { archived++; },
    });
  }
  assert.equal(sends, LOCAL_SUMMARY_LIMIT + 5);
  assert.equal(archived, 0);
  assert.equal(local.length, LOCAL_SUMMARY_LIMIT);
  assert.equal(local[0].id, "local-5");
  assert.ok(local.every((entry) => entry.deliveryStatus === "failed" && entry.reportedBy === "browser" && !("payload" in entry)));
});
