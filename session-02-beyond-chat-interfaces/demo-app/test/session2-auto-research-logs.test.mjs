import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createServer } from "vite";
import { createExecutionLog } from "../src/execution-log.mjs";
import { createTrace } from "../src/trace.mjs";
import {
  compactRecords, executionPage, executionRunScope, executionTotals, groupTeachingRecords,
} from "../ui/src/shared/execution.mjs";

const taskId = "research-run";
const original = { headline: "Test report", body: "An unverified claim. ".repeat(800), sourceIds: ["source-1"] };
const candidate = { headline: "A supported test report", body: "A specific, attributed claim. ".repeat(800),
  sourceIds: ["source-1", "source-2"] };
const rubric = { factualSupport: "Every factual claim must cite retrieved evidence.", informative: "Keep useful specifics." };
const phases = [
  { id: "root", kind: "auto_research.run", runId: taskId, slotId: "story-a", maxRounds: 3, original, rubric },
  { id: "audit", kind: "auto_research.audit", claims: [{ text: "An unverified claim", supported: false }], goals: ["Find primary evidence"] },
  { id: "research", kind: "auto_research.research", round: 1, queries: ["Primary evidence for the claim"], sources: [{ id: "source-2", text: "Retrieved evidence. ".repeat(500) }] },
  { id: "experiment", kind: "auto_research.experiment", round: 1, before: original, candidate, changes: ["Attribute the claim"] },
  { id: "evaluate", kind: "auto_research.evaluate", round: 1, rubric,
    baselineEvaluation: { supported: 0, claimsTotal: 1, goalsMet: 1, goalsTotal: 1 },
    candidateEvaluation: { supported: 1, claimsTotal: 1, goalsMet: 1, goalsTotal: 1 }, metrics: { improved: true } },
  { id: "keep", kind: "auto_research.keep", round: 1, reason: "Support improved without losing the useful detail.", before: original, after: candidate },
  { id: "revert", kind: "auto_research.revert", round: 2, reason: "The alternative lost a useful qualification.", before: candidate, after: candidate },
  { id: "stop", kind: "auto_research.stop", round: 2, reason: "No further supported improvement.", outcome: "stopped" },
];

function appendCycle(archive) {
  for (const [index, phase] of phases.entries())
    archive.record({
      taskId, parentId: phase.id === "root" ? null : "root", status: "complete",
      startedAt: new Date(index * 1000).toISOString(), ...phase,
    });
}

test("every research phase appears in Simplified View without sending copy or evidence payloads", async (t) => {
  const archive = createExecutionLog();
  t.after(() => archive.close());
  appendCycle(archive);
  archive.record({ kind: "model.provider_event", taskId, payload: { delta: "streamed text" } });
  archive.record({ kind: "source.read", taskId, result: { text: "Full source" } });
  const page = executionPage(archive.list({ order: "asc", taskId }));
  assert.deepEqual(page.records.map((record) => record.id), phases.map((phase) => phase.id));
  assert.equal(page.total, phases.length);
  assert.equal(archive.summary().teachingRecords, phases.length);
  assert.match(page.records.find((record) => record.id === "evaluate").label, /^Cycle 1 · Evaluate baseline and candidate$/);
  assert.match(page.records.find((record) => record.id === "revert").label, /^Cycle 2 · Revert candidate$/);
  const snapshot = JSON.stringify(compactRecords(archive.recent()));
  assert.ok(Buffer.byteLength(snapshot) < 6000);
  for (const key of ["original", "rubric", "claims", "goals", "queries", "sources", "before", "candidate",
    "baselineEvaluation", "candidateEvaluation", "metrics", "after", "changes"])
    assert.ok(page.records.every((record) => !(key in record)), key);
  assert.ok(!snapshot.includes("An unverified claim."));
  assert.equal(groupTeachingRecords(page.records).length, 1);
  assert.equal(groupTeachingRecords(page.records)[0].root.id, "root");
  assert.equal(executionRunScope({ recordId: "evaluate", records: page.records }), taskId);
  assert.deepEqual((await archive.get("experiment")).candidate, candidate);
  assert.deepEqual((await archive.get("root")).rubric, rubric);
});

test("cycle identity and explicit labels survive payload envelopes and partial pages", async (t) => {
  const archive = createExecutionLog();
  t.after(() => archive.close());
  archive.record({ id: "early", kind: "auto_research.run", runId: taskId, label: "Research this story" });
  archive.record({ id: "late", parentId: "early", kind: "auto_research.evaluate",
    label: "Test the frozen rubric", payload: { runId: taskId, round: 3, rubric } });
  const page = executionPage(archive.list({ limit: 1, taskId }));
  assert.equal(page.records[0].label, "Cycle 3 · Test the frozen rubric");
  assert.equal(page.records[0].parentId, "early");
  assert.equal(page.records[0].taskId, taskId);
  assert.equal(groupTeachingRecords(page.records)[0].id, taskId);
  archive.record({ id: "labeled", kind: "auto_research.keep", round: 3, label: "Round 3 · Keep attributed copy" });
  assert.equal(archive.describe("labeled").label, "Round 3 · Keep attributed copy");
  assert.deepEqual((await archive.get("late")).payload.rubric, rubric);
});

test("real trace spans retain run filtering and completed result envelopes in both views", async (t) => {
  const trace = createTrace();
  t.after(() => trace.close());
  const correlation = { taskId, runId: taskId, jobId: taskId, slotId: "story-a" };
  const root = trace.start("auto_research.run", { ...correlation, original, rubric });
  const reports = {
    baseline: { claims: [{ id: "c1", verdict: "unresolved" }], goals: [{ id: "g1", met: true }], addedClaims: [] },
    candidate: { claims: [{ id: "c1", verdict: "supported" }], goals: [{ id: "g1", met: true }], addedClaims: [] },
    nextQueries: [],
  };
  trace.withContext({ actor: "agent", parentId: root.id }, () => {
    const experiment = trace.start("auto_research.experiment", { ...correlation, round: 1, before: original });
    experiment.finish({ result: candidate });
    const evaluation = trace.start("auto_research.evaluate", { ...correlation, round: 1, rubric });
    evaluation.finish({ result: reports });
    trace.record("auto_research.keep", { ...correlation, round: 1, reason: "More support; all reader goals retained.",
      metrics: { baseline: { supported: 0, claimsTotal: 1, goalsMet: 1, goalsTotal: 1 },
        candidate: { supported: 1, claimsTotal: 1, goalsMet: 1, goalsTotal: 1 } } });
    trace.record("model.provider_event", { ...correlation, payload: { text: "Stream delta" } });
  });
  root.finish({ status: "completed" });
  await trace.flush();
  const page = executionPage(trace.list({ taskId, view: "teaching", order: "asc" }));
  assert.deepEqual(page.records.map((record) => record.kind), [
    "auto_research.run", "auto_research.experiment", "auto_research.evaluate", "auto_research.keep",
  ]);
  assert.equal(page.total, 4);
  assert.equal(trace.list({ taskId, view: "protocol" }).total, 5);
  assert.ok(page.records.every((record) => record.taskId === taskId));
  assert.ok(page.records.slice(1).every((record) => record.parentId === root.id));
  assert.ok(page.records.every((record) => !("result" in record) && !("metrics" in record)));
  assert.equal(groupTeachingRecords(page.records)[0].root.id, root.id);
  assert.deepEqual((await trace.get(page.records[1].id)).result, candidate);
  assert.deepEqual((await trace.get(page.records[2].id)).result, reports);
});

test("research records preserve on-demand evidence after archive reopen and redact secrets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "auto-research-execution-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = createExecutionLog({ directory, scopeId: "test-paper" });
  appendCycle(archive);
  archive.record({ id: "source-private", kind: "auto_research.research", taskId, parentId: "root",
    round: 2, sources: [{ url: "https://example.org/?token=private", text: "Source evidence" }],
    authorization: "Bearer secret", reasoning: "Provider replay must not travel to the UI" });
  await archive.close();
  const restored = createExecutionLog({ directory, scopeId: "test-paper" });
  t.after(() => restored.close());
  assert.deepEqual((await restored.get("experiment")).before, original);
  assert.deepEqual((await restored.get("experiment")).candidate, candidate);
  assert.equal((await restored.get("source-private")).authorization, "[retained on server]");
  assert.equal((await restored.get("source-private")).reasoning, "[retained on server]");
  assert.equal((await restored.get("source-private")).sources[0].url, "https://example.org/?token=[redacted]");
  assert.equal(restored.list({ taskId }).total, 9);
  assert.equal(restored.summary().capture.status, "complete");
});

test("loop phase records cannot become model requests or duplicate actual charges", async (t) => {
  const archive = createExecutionLog();
  t.after(() => archive.close());
  archive.record({ id: "request-start", kind: "app.request_start", taskId, parentId: "root",
    operationId: "model-call", model: "fixture-model", status: "running" });
  archive.record({ id: "request-end", kind: "app.request_end", taskId, parentId: "root",
    operationId: "model-call", costUsd: 0.012, durationMs: 321, usage: { input_tokens: 80, output_tokens: 20 } });
  appendCycle(archive);
  archive.record({ kind: "auto_research.evaluate", taskId, operationId: "phase-is-not-a-request",
    round: 3, metrics: { costUsd: 99 }, candidateEvaluation: { cost: 77 } });
  assert.equal(archive.summary().requestCount, 1);
  assert.equal(archive.summary().reportedCostUsd, 0.012);
  const narrow = archive.list({ query: "revert" });
  assert.equal(narrow.total, 1);
  assert.equal(executionTotals(narrow.summary).requests, 1);
  assert.equal(executionTotals(narrow.summary).knownCostUsd, 0.012);
  const request = executionPage(archive.list({ query: "request-end" })).records[0];
  assert.equal(request.operationId, "model-call");
  assert.equal(request.durationMs, 321);
  assert.equal(request.costUsd, 0.012);
  assert.deepEqual(request.usage, { input_tokens: 80, output_tokens: 20 });
});

test("record learning surface compares captured evidence without inventing scores or certainty", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "auto-research-ui-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const vite = await createServer({
    configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir,
    server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom",
  });
  t.after(() => vite.close());
  const { AutoResearchRecord, autoResearchPhase, evaluationComparison } =
    await vite.ssrLoadModule("/ui/src/shared/AutoResearchRecord.jsx");
  const render = (record) => renderToStaticMarkup(React.createElement(AutoResearchRecord, { record }));
  assert.equal(autoResearchPhase({ kind: "model.request" }), null);
  assert.equal(autoResearchPhase({ kind: "auto_research.unknown" }), null);
  assert.equal(autoResearchPhase({ kind: "auto_research.revert" }), "revert");
  const comparison = render(phases.find((phase) => phase.id === "experiment"));
  assert.match(comparison, /Compare before and candidate/);
  assert.match(comparison, /aria-label="Before"/);
  assert.match(comparison, /aria-label="Candidate"/);
  assert.match(comparison, /3200 body words/);
  assert.match(comparison, /2 cited sources/);
  assert.match(comparison, /excerpt/);
  assert.ok(comparison.length < 2500, "copy previews are bounded");
  assert.ok(!comparison.includes("<details open"), "copy comparison starts collapsed");
  assert.match(render({ kind: "auto_research.experiment", before: original, result: candidate }),
    /Compare before and candidate/, "completed trace spans keep phase output in result");
  const evaluated = phases.find((phase) => phase.id === "evaluate");
  assert.deepEqual(evaluationComparison(evaluated), [
    { key: "supported", baseline: 0, candidate: 1 },
    { key: "claimsTotal", baseline: 1, candidate: 1 },
    { key: "goalsMet", baseline: 1, candidate: 1 },
    { key: "goalsTotal", baseline: 1, candidate: 1 },
  ]);
  assert.match(render(evaluated), /<th>Baseline<\/th><th>Candidate<\/th>/);
  assert.match(render(evaluated), /<th scope="row">supported<\/th><td>0<\/td><td>1<\/td>/);
  assert.deepEqual(evaluationComparison({ baselineEvaluation: { unsupported: 0 },
    candidateEvaluation: { other: 4, unsupported: "0" } }), []);
  assert.equal(render({ kind: "auto_research.evaluate", candidateEvaluation: { supported: 1 } }), "");
  assert.equal(render({ ...evaluated, captureIncomplete: true }), "");
  assert.equal(render({ kind: "auto_research.experiment", before: original, candidate: original }), "");
  const pairedReports = { kind: "auto_research.evaluate",
    rubric: { claims: [{ id: "c1", text: "The frozen factual claim." }],
      goals: [{ id: "g1", question: "What useful detail should remain?" }] },
    result: {
      baseline: { claims: [{ id: "c1", verdict: "unresolved" }, { id: "c2", verdict: "supported" }],
        goals: [{ id: "g1", met: true }], addedClaims: [] },
      candidate: { claims: [{ id: "c2", verdict: "supported" }, { id: "c1", verdict: "qualified" }],
        goals: [{ id: "g1", met: false }], addedClaims: [{ id: "extra1", text: "An unsupported addition.", verdict: "unresolved" }] },
    },
  };
  const reportHtml = render(pairedReports);
  assert.match(reportHtml, /<td>unresolved<\/td><td>qualified<\/td>/);
  assert.match(reportHtml, /<td>met<\/td><td>not met<\/td>/);
  assert.match(reportHtml, /The frozen factual claim/);
  assert.match(reportHtml, /What useful detail should remain/);
  assert.match(reportHtml, /<td>not present<\/td><td>unresolved<\/td>/);
  assert.deepEqual(evaluationComparison(pairedReports).map(({ key, baseline, candidate }) => ({ key, baseline, candidate })), [
    { key: "Claim c1", baseline: "unresolved", candidate: "qualified" },
    { key: "Claim c2", baseline: "supported", candidate: "supported" },
    { key: "Goal g1", baseline: "met", candidate: "not met" },
    { key: "Added claim extra1", baseline: "not present", candidate: "unresolved" },
  ]);
  const decision = render({ kind: "auto_research.revert", payload: { reason: "Still missing <primary evidence>." } });
  assert.match(decision, /Decision reason/);
  assert.match(decision, /&lt;primary evidence&gt;/);
  const stopping = render({ kind: "auto_research.stop", reason: "Round limit reached; uncertainty remains." });
  assert.match(stopping, /Round limit reached; uncertainty remains/);
  assert.doesNotMatch(stopping, /unretractable|guaranteed|verified fact/i);
  assert.match(render({ kind: "auto_research.evaluation_invalid" }), /no Keep or Revert/);
  assert.match(render({ kind: "auto_research.repair" }), /format-only request/);
  assert.match(render({ kind: "auto_research.format_repair" }), /format-only request/, "Earlier archived records remain readable.");

  const { AutoResearch } = await vite.ssrLoadModule("/ui/src/editor/AutoResearch.jsx");
  const pausedRun = {
    id: "paused-research", slotId: "story-a", storyId: "story-a", status: "paused",
    phase: "experiment", recovery: { step: "experiment", status: "paused" },
    round: 2, completedRounds: 1, maxRounds: 3, kept: 1, reverted: 0,
    resumable: true, remainingRequests: 2, currentEvaluation: { supported: 2, claimsTotal: 2,
      unresolved: 0, contradicted: 0, goalsMet: 2, goalsTotal: 2 },
    lastDecision: { decision: "keep", reason: "The previous evaluation supported the kept copy." },
    summary: "1 kept, 0 reverted across 1 completed round. Round 2 is incomplete.",
    stopReason: "The candidate response remains malformed. The saved step is preserved.",
  };
  const pausedUi = renderToStaticMarkup(React.createElement(AutoResearch, {
    story: { ...original, id: "story-a", slotId: "story-a" },
    state: { autoResearchRuns: [pausedRun], jobs: [] },
    controller: { pending: [], connection: { isConnected: true } },
  }));
  assert.match(pausedUi, /Resume saved step/);
  assert.match(pausedUi, /Round 2 is incomplete/);
  assert.match(pausedUi, /Metrics from the last completed evaluation/);
  assert.match(pausedUi, /Last completed decision: Keep/);
  assert.match(pausedUi, /2 model requests remain/);
  assert.doesNotMatch(pausedUi, /Run ended|Research &amp; strengthen/);

  // An executionId can open an archived phase even when it has fallen out of
  // the compact state. Only that selected record is needed for the inspector.
  const { Execution } = await vite.ssrLoadModule("/ui/src/shared/Execution.jsx");
  const client = new QueryClient();
  t.after(() => client.clear());
  client.setQueryData(["execution-record", "test-paper", evaluated.id], {
    ...evaluated, taskId, parentId: "root", label: "Evaluate this candidate",
  });
  const inspector = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(Execution, {
      issueId: "test-paper", initialRecordId: evaluated.id, trace: [], jobs: [],
      getExecutionRecord() { throw new Error("SSR must use only the supplied selected record"); },
    })));
  assert.match(inspector, /Evaluate this candidate/);
  assert.match(inspector, /Browse research cycle/);
  assert.match(inspector, /Inspect model and tool requests/);
  assert.match(inspector, /Open parent record/);
  assert.match(inspector, /Complete sanitized JSON tree/);
  assert.match(inspector, /Expand tree/);
  assert.doesNotMatch(inspector, /Child:/);
});
