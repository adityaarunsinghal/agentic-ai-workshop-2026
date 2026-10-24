import { compactRecords, LOCAL_SUMMARY_LIMIT } from "./execution.mjs";
import { STAGE_PROFILES } from "../../../src/stages.mjs";

export const EDITOR_RESOURCE = "ui://session-02/editor-view.html";
export const DECISION_MODELS = Object.freeze([
  { id: "typesafe/jev-1.13", label: "Jev · 1.13" },
  { id: "perplexity/pplx-decider-v1.1-27b", label: "Perplexity · Decider 27B" },
]);
// Session 3 opens on the fact-check. The Session 2 stages stay on the server for saved
// editions, but the editor only offers the fact-check view.
export const STAGES = Object.freeze([
  { ...STAGE_PROFILES.research, label: "Fact-check", description: "Agents check each claim in the story against the archive. Their corrections become an edit you can undo." },
]);
export const TOPOLOGIES = Object.freeze([
  { id: "single", label: "Single agent", description: "One agent checks every claim and corrects the story." },
  { id: "graph", label: "Graph", description: "One agent checks each claim. Contradicted claims are then corrected." },
  { id: "swarm", label: "Swarm", description: "Specialists hand claims to each other as they go." },
]);
export const hasFactCheck = (stage) => STAGE_PROFILES[stage]?.noulBars === true;
export const FACT_CHECK_QUESTION =
  "Does this proposed newspaper treatment need additional factual verification before publication, based on the supplied evidence?";
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value : [];
const revision = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function structuredResult(result) {
  if (!isObject(result)) return null;
  if (isObject(result.structuredContent)) return result.structuredContent;
  for (const block of list(result.content)) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (isObject(parsed)) return parsed;
    } catch { /* Ordinary MCP text is not a snapshot. */ }
  }
  return result;
}

export function normalizeSnapshot(result) {
  let value = structuredResult(result);
  for (let i = 0; i < 4 && isObject(value) && !isObject(value.issue); i++) {
    value = value.state ?? value.snapshot ?? value.editor ?? null;
  }
  if (!isObject(value?.issue) || typeof value.issue.id !== "string") return null;
  return {
    ...value,
    issue: {
      ...value.issue,
      revision: revision(value.issue.revision) ?? 0,
      stories: list(value.issue.stories).filter(isObject),
      sources: list(value.issue.sources ?? value.sources).filter(isObject),
    },
    jobs: list(value.jobs).filter(isObject),
    autoResearchRuns: list(value.autoResearchRuns).filter(isObject),
    briefings: list(value.briefings).filter(isObject),
    trace: compactRecords(value.trace),
    ...(Array.isArray(value.hostRecords) ? { hostRecords: compactRecords(value.hostRecords, LOCAL_SUMMARY_LIMIT) } : {}),
    editorialHistory: list(value.editorialHistory).filter(isObject).slice(-12),
    approvals: list(value.approvals ?? (value.approval ? [value.approval] : [])).filter(isObject),
    suggestions: list(value.suggestions).filter(isObject),
    settings: {
      stage: "research", topology: "single", decisionModel: DECISION_MODELS[0].id, maxTurns: 10,
      ...(isObject(value.settings) ? value.settings : {}),
    },
  };
}

const terminal = new Set(["completed", "complete", "done", "ready", "overflow", "incomplete", "interrupted", "failed", "cancelled", "canceled", "superseded"]);
function mergeRecords(previous, next) {
  const result = new Map(previous.map((record) => [record.id, record]));
  for (const record of next) {
    const old = result.get(record.id);
    if (old && ((terminal.has(old.status) && !terminal.has(record.status)) ||
      (Number.isFinite(old.turn) && Number.isFinite(record.turn) && old.turn > record.turn))) continue;
    result.set(record.id, { ...old, ...record });
  }
  return [...result.values()];
}

// Stream revision and issue revision have different jobs. An old callback must
// not roll back copy; equal issue revisions may have newer research/trace events.
export function mergeSnapshots(previous, next) {
  if (!next) return previous;
  const bounded = {
    ...next, trace: compactRecords(next.trace),
    ...(Array.isArray(next.hostRecords) ? { hostRecords: compactRecords(next.hostRecords, LOCAL_SUMMARY_LIMIT) } : {}),
  };
  if (!previous || previous.issue.id !== next.issue.id) return bounded;
  const oldDocument = previous.documentVersion ?? 0, newDocument = next.documentVersion ?? 0;
  if (newDocument < oldDocument) return previous;
  if (newDocument > oldDocument) return bounded;
  const oldStream = revision(previous.streamRevision ?? previous.revision);
  const newStream = revision(next.streamRevision ?? next.revision);
  if (oldStream !== null && newStream !== null && newStream < oldStream) return previous;
  if (next.executionClearedAt && next.executionClearedAt !== previous.executionClearedAt)
    return { ...bounded, hostRecords: [] };
  if (next.issue.revision < previous.issue.revision) {
    return { ...previous, trace: compactRecords(mergeRecords(previous.trace, bounded.trace)), jobs: mergeRecords(previous.jobs, next.jobs) };
  }
  return { ...previous, ...bounded, jobs: mergeRecords(previous.jobs, next.jobs), trace: compactRecords(mergeRecords(previous.trace, bounded.trace)) };
}

export const storyKey = (story) => story.slotId;
export const sameStory = (story, target) =>
  Boolean(target?.slotId && story.slotId === target.slotId);

export function applyIntent(state, intent) {
  if (!state || !intent) return state;
  if (intent.kind === "issue") return { ...state, issue: { ...state.issue, ...intent.patch } };
  if (intent.kind === "settings") return { ...state, settings: { ...state.settings, ...intent.patch } };
  let stories = state.issue.stories;
  if (intent.kind === "reserve") {
    if (!stories.some((story) => sameStory(story, intent.story))) stories = [...stories, intent.story];
  } else if (intent.kind === "delete") {
    stories = stories.filter((story) => !sameStory(story, intent.target));
  } else {
    stories = stories.map((story) => {
      if (!sameStory(story, intent.target)) return story;
      const patch = intent.patch ?? {};
      const changesTreatment = ["headline", "body", "section", "sourceIds"].some((key) => key in patch);
      return {
        ...story, ...patch,
        ...(changesTreatment && story.factCheck ? { factCheck: { ...story.factCheck, status: "stale" } } : {}),
      };
    });
  }
  return { ...state, issue: { ...state.issue, stories } };
}

export function projectIntents(state, entries) {
  return entries.reduce((current, entry) => applyIntent(current, entry.intent), state);
}

// A later explicit edit supersedes failed local intent for the same fields.
// Keep unrelated unsaved fields, including their corresponding retry payload.
export function supersedeFailedIntents(entries, intent) {
  if (!intent) return entries;
  return entries.flatMap((entry) => {
    const old = entry.intent;
    if (entry.status !== "failed" || !old) return [entry];
    const matchingTarget = old.target && intent.target && sameStory(old.target, intent.target);
    if (intent.kind === "delete" && matchingTarget) return [];
    const sameScope = (old.kind === "patch" && intent.kind === "patch" && matchingTarget) ||
      (old.kind === intent.kind && ["issue", "settings"].includes(intent.kind));
    if (!sameScope) return [entry];
    const patch = Object.fromEntries(Object.entries(old.patch ?? {}).filter(([key]) => !(key in (intent.patch ?? {}))));
    if (!Object.keys(patch).length) return [];
    return [{
      ...entry, intent: { ...old, patch },
      ...(entry.name === "edit_story" ? { arguments: { ...entry.arguments, patch } } : {}),
    }];
  });
}

export function factCheckDisplay(story, editorial) {
  const review = story.factCheck ?? {};
  const probability = review.probability ?? review.noul;
  const valid = typeof probability === "number" && probability >= 0 && probability <= 1;
  const latestStatus = editorial?.backend === "decisions" && editorial.requestId !== review.requestId
    ? ({ running: "running", failed: "failed", superseded: "stale" })[editorial.status] : null;
  const stale = review.status === "stale" || latestStatus === "stale" ||
    (Number.isSafeInteger(review.contentVersion) && review.contentVersion !== story.contentVersion);
  const status = latestStatus ?? (stale ? "stale" : review.status ?? (valid ? "complete" : "unavailable"));
  const unavailable = ["pending", "queued", "running", "failed", "error", "unavailable", "stale"].includes(status);
  return {
    status, probability: valid ? probability : null,
    percentage: valid && !unavailable ? Math.round(probability * 100) : null,
    label: status === "stale" ? "Stale estimate" : ["failed", "error"].includes(status) ? "Assessment failed"
      : ["pending", "queued", "running"].includes(status) ? "Assessment pending"
      : status === "unavailable" ? "Assessment unavailable"
      : valid ? `${Math.round(probability * 100)}%` : "Not assessed",
  };
}

export function exportDescriptor(result) {
  const data = structuredResult(result);
  const descriptor = data?.artifact ?? data?.export ?? data?.download ?? data;
  return typeof descriptor?.url === "string" ? descriptor : null;
}

export function toolError(result) {
  if (!result?.isError) return null;
  const data = structuredResult(result);
  return new Error(typeof data?.error === "string" ? data.error
    : list(result.content).find((block) => block.type === "text")?.text ?? "The MCP tool could not complete this action.");
}

export const errorMessage = (value) => typeof value === "string" ? value
  : typeof value?.message === "string" ? value.message
  : typeof value?.error === "string" ? value.error
  : String(value?.code || "The action could not complete.");

export function safeHttpUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

const privateKey = /^(authorization|proxy-authorization|cookie|set-cookie|(?:x[-_])?api[-_]?key|token|access[-_]?token|refresh[-_]?token|(?:x[-_])?workshop[-_]?token|run[-_]?token|visit[-_]?token|development[-_]?token|secret|password|credentials?|private[-_]?key|provider[-_]?replay|reasoning|reasoning[-_](details|content)|encrypted[-_]content)$/i;
export function sanitizeForInspection(value, seen = new WeakSet()) {
  if (typeof value === "string") return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:api_key|access_token|token|key)=)[^&#\s]*/gi, "$1[redacted]");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular reference]";
  seen.add(value);
  const clean = Array.isArray(value) ? value.map((item) => sanitizeForInspection(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, privateKey.test(key) ? "[redacted]" : sanitizeForInspection(item, seen),
    ]));
  seen.delete(value);
  return clean;
}

export function formatCost(value) {
  const amount = typeof value === "number" ? value : value?.usd ?? value?.totalUsd ?? value?.total;
  return Number.isFinite(amount) ? `$${amount.toFixed(amount !== 0 && amount < 0.01 ? 5 : 3)}` : "Cost not reported";
}

export function recordCost(record) {
  const direct = typeof record.cost === "number" ? record.cost
    : record.cost?.usd ?? record.cost?.totalUsd ?? record.cost?.total;
  // Use reported charges only; SDK token-price estimates are not settled cost.
  for (let value of [record.costUsd, record.knownCostUsd, direct, record.usage?.cost, record.usage?.cost_usd,
    record.usage?.total_cost, record.usage?.knownCostUsd]) {
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function inferenceRequests(trace = []) {
  const requests = new Map();
  for (const record of trace) {
    if (!record.operationId ||
      !["model", "chat", "choice", "noul", "decision", "model.request", "decision.request"].includes(record.kind ?? record.type)) continue;
    const previous = requests.get(record.operationId) || {};
    requests.set(record.operationId, {
      ...previous, ...record,
      usage: record.usage ?? previous.usage,
      costUsd: recordCost(record) ?? recordCost(previous),
    });
  }
  return [...requests.values()];
}
