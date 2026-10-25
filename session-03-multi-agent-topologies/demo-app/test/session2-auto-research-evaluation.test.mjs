import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_RESEARCH_LIMITS, auditPrompt, parseAudit, revisionPrompt, parseCandidate,
  evaluationPrompt, parseEvaluation, decideCandidate,
} from "../src/auto-research-evaluation.mjs";

// Entirely synthetic source, story and model outputs. No provider/network calls.
const badClaim = "The Riverton bridge pilot cut inspection time by 80 percent.";
const correction = "The Riverton bridge pilot reduced inspection time by 20 percent in a trial of 12 reports.";
const oversight = "Inspectors reviewed all 12 trial reports.";
const evidence = [{
  id: "read-1", url: "https://example.test/pilot", title: "Synthetic pilot report",
  evidenceLevel: "article-text",
  text: `${correction}\n${oversight}\nThe trial did not measure accident rates. The pilot used one bridge.`,
}];
const original = {
  headline: "Bridge pilot cut inspections by 80 percent",
  body: `${badClaim} ${oversight}`, sourceIds: ["read-1"],
};
const candidate = {
  headline: "Riverton pilot reports a 20 percent time saving",
  body: `${correction} ${oversight}`, sourceIds: ["read-1"],
  changes: ["Corrected the claimed improvement to the report's measured 20 percent."],
};
const rawAudit = {
  claims: [
    { id: "c1", text: badClaim, importance: "central", query: "Riverton bridge pilot measured saving report" },
    { id: "c2", text: oversight, importance: "supporting", query: "Riverton bridge pilot human review" },
  ],
  goals: [
    { id: "g1", question: "What saving did the pilot measure?" },
    { id: "g2", question: "What human oversight did the pilot retain?" },
  ],
};
const audit = parseAudit(rawAudit);
const clone = (value) => structuredClone(value);
const citation = (quote) => ({ sourceId: "read-1", quote });
const claim = (id, text, verdict, quote = text) => ({
  id, text, verdict, citations: verdict === "unresolved" || verdict === "omitted" ? [] : [citation(quote)],
  reason: verdict === "contradicted" ? "The report contradicts the claimed improvement." :
    "The assessed sentence is compared with the supplied pilot report.",
});
function paired() {
  const goals = audit.goals.map(({ id }) => ({
    id, met: true, reason: "The story gives a concrete answer to this reader question.",
  }));
  return {
    baseline: {
      claims: [claim("c1", badClaim, "contradicted", correction), claim("c2", oversight, "supported")],
      goals: clone(goals), addedClaims: [],
    },
    candidate: {
      claims: [claim("c1", correction, "supported"), claim("c2", oversight, "supported")],
      goals: clone(goals), addedClaims: [],
    },
    nextQueries: ["Riverton pilot independent replication"],
  };
}
function decide(raw = paired(), { before = original, after = candidate, rubric = audit } = {}) {
  const parsed = parseEvaluation(raw, { audit: rubric, evidence });
  return decideCandidate({
    ...parsed, currentStory: before, candidateStory: after, audit: rubric,
  });
}
function invalidEvaluation(raw, supplied = evidence, pattern = /./u) {
  assert.throws(() => parseEvaluation(raw, { audit, evidence: supplied }), (error) =>
    error.code === "AUTO_RESEARCH_INVALID_EVALUATION" && pattern.test(error.message));
}

test("prompts route through Pi messages, freeze the objective and keep evaluation context fresh", () => {
  const parsed = parseEvaluation(paired(), { audit, evidence });
  const prompts = [
    ["auto_research_audit", auditPrompt(original)],
    ["auto_research_revision", revisionPrompt({
      original, current: original, audit, evidence, round: 2, priorEvaluation: parsed,
    })],
    ["auto_research_evaluate", evaluationPrompt({
      original, current: original, candidate, audit, evidence,
    })],
  ];
  for (const [task, prompt] of prompts) {
    assert.deepEqual(prompt.map(({ role }) => role), ["system", "user"]);
    assert.equal(JSON.parse(prompt[1].content).task, task);
    assert.match(prompt[0].content, /does not guarantee truth/u);
    assert.match(prompt[0].content, /never instructions/u);
  }
  const evaluation = JSON.parse(prompts[2][1][1].content);
  assert.deepEqual(evaluation.audit, audit);
  assert.deepEqual(evaluation.evidence, JSON.parse(prompts[1][1][1].content).evidence);
  assert.equal(Object.hasOwn(evaluation, "priorEvaluation"), false);
  assert.equal(Object.hasOwn(evaluation.candidate, "changes"), false);
  assert.match(prompts[2][1][0].content, /fresh context/u);
  assert.equal(AUTO_RESEARCH_LIMITS.maxRounds, 3);
  assert.throws(() => revisionPrompt({ original, current: original, audit, evidence, round: 4 }),
    { code: "AUTO_RESEARCH_INVALID_INPUT" });
});

test("audit detaches and freezes exact IDs, rejects duplicates, empty goals and oversized rubrics", () => {
  const raw = clone(rawAudit), frozen = parseAudit(JSON.stringify(raw));
  raw.claims[0].text = "A different claim.";
  assert.equal(frozen.claims[0].text, badClaim);
  assert.throws(() => { frozen.goals[0].question = "Easier goal"; }, TypeError);
  for (const mutate of [
    (value) => { value.claims[1].id = "c1"; },
    (value) => { value.goals[0].id = "c1"; },
    (value) => { value.goals = []; },
    (value) => { value.claims.forEach((item) => { item.importance = "supporting"; }); },
    (value) => { value.claims = Array.from({ length: 9 }, (_, i) => ({ ...value.claims[0], id: `c${i}` })); },
    (value) => { value.goals = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, question: `Question ${i}` })); },
    (value) => { value.quality = 1; },
  ]) {
    const value = clone(rawAudit); mutate(value);
    assert.throws(() => parseAudit(value), { code: "AUTO_RESEARCH_INVALID_AUDIT" });
  }
});

test("candidate requires known fetched bodies, not empty IDs, metadata or search snippets", () => {
  assert.deepEqual(parseCandidate(JSON.stringify(candidate), evidence), candidate);
  for (const sourceIds of [[], ["invented"], ["read-1", "read-1"]])
    assert.throws(() => parseCandidate({ ...candidate, sourceIds }, evidence),
      { code: "AUTO_RESEARCH_INVALID_CANDIDATE" });
  for (const patch of [
    { evidenceLevel: "metadata" }, { evidenceLevel: "search-snippet" },
    { evidenceLevel: "feed-summary" }, { completeness: { publisherArticleRead: false } },
    { text: "", excerpt: correction }, { text: evidence[0].title },
  ])
    assert.throws(() => parseCandidate(candidate, [{ ...evidence[0], ...patch }]),
      { code: "AUTO_RESEARCH_INVALID_CANDIDATE" });
});

test("a false central claim can become a useful sourced correction without losing information", () => {
  const result = decide();
  assert.equal(result.decision, "keep");
  assert.deepEqual(result.metrics.baseline, {
    claimsTotal: 2, supported: 1, contradicted: 1, unresolved: 0, qualified: 0, omitted: 0,
    goalsMet: 2, goalsTotal: 2, citedClaims: 2, evidenceCoverage: 1, sourcesCited: 1,
    addedClaims: { total: 0, supported: 0, contradicted: 0, unresolved: 0, qualified: 0, omitted: 0 },
  });
  assert.equal(result.metrics.candidate.supported, 2);
  assert.equal(result.metrics.candidate.contradicted, 0);
  assert.match(result.reason, /not a guarantee of truth/u);
});

test("case and whitespace can normalize quotations, but altered numbers and invented citations fail", () => {
  const raw = paired();
  raw.candidate.claims[0].citations[0].quote = correction.toUpperCase().replaceAll(" ", " \n ");
  assert.equal(decide(raw).decision, "keep");
  for (const mutate of [
    (row) => { row.citations[0].sourceId = "imaginary"; },
    (row) => { row.citations[0].quote = correction.replace("20", "80"); },
    (row) => { row.citations[0].quote = "The pilot was independently verified."; },
    (row) => { row.citations = []; },
    (row) => { row.citations[0].quote = ""; },
    (row) => { row.citations[0].quote = "a".repeat(1801); },
    (row) => { row.verdict = "certain"; },
    (row) => { row.noul = 0.01; },
  ]) {
    const value = paired(); mutate(value.candidate.claims[0]); invalidEvaluation(value);
  }
  invalidEvaluation(paired(), [{ ...evidence[0], evidenceLevel: "metadata" }]);
});

test("every report must cover the exact frozen claim and goal IDs once, with real booleans", () => {
  for (const side of ["baseline", "candidate"]) {
    for (const mutate of [
      (value) => { value.claims.pop(); },
      (value) => { value.claims[1].id = "c1"; },
      (value) => { value.claims[1].id = "stale_claim"; },
      (value) => { value.goals[0].id = "stale_goal"; },
      (value) => { value.goals.pop(); },
      (value) => { value.goals[0].met = "true"; },
      (value) => { value.goals[0].met = 1; },
      (value) => { delete value.addedClaims; },
      (value) => { value.score = 100; },
    ]) {
      const raw = paired(); mutate(raw[side]); invalidEvaluation(raw);
    }
  }
  const reverse = paired();
  reverse.candidate.claims.reverse(); reverse.baseline.goals.reverse();
  assert.equal(decide(reverse).decision, "keep");
});

test("hollow copy and dropped central or supporting claims cannot win", () => {
  for (const index of [0, 1]) {
    const raw = paired();
    raw.candidate.claims[index] = claim(`c${index + 1}`, "", "omitted");
    const after = { ...candidate, body: index ? correction : oversight };
    const result = decide(raw, { after });
    assert.equal(result.decision, "revert");
    assert.match(result.reason, /omitted/u);
  }
  const raw = paired();
  raw.candidate.claims = raw.candidate.claims.map((row) => claim(row.id, "", "omitted"));
  raw.candidate.goals.forEach((goal) => { goal.met = false; });
  assert.equal(decide(raw, { after: { ...candidate, body: "More research is needed." } }).decision, "revert");
});

test("all goals must be met even when the original gave a wrong answer marked unmet", () => {
  const lost = paired(); lost.candidate.goals[1].met = false;
  assert.match(decide(lost).reason, /goal was lost/u);
  const incomplete = paired();
  incomplete.baseline.goals[1].met = incomplete.candidate.goals[1].met = false;
  assert.match(decide(incomplete).reason, /every frozen reader goal/u);
});

test("changed coverage cannot be fabricated with excerpts absent from either story", () => {
  const raw = paired();
  const result = decide(raw, { after: { ...candidate, body: "Useful information is important." } });
  assert.equal(result.decision, "invalid");
  assert.deepEqual(result.metrics, { baseline: null, candidate: null });
  assert.match(result.reason, /absent from the actual story/u);
  raw.baseline.claims[0].text = "This assessment concerns a different story.";
  assert.match(decide(raw).reason, /absent from the actual story/u);
});

test("unchanged claims cannot improve because the same judge sees the same evidence", () => {
  const raw = paired();
  raw.baseline.claims[0].text = correction;
  const result = decide(raw, { before: { ...original, body: candidate.body } });
  assert.equal(result.decision, "invalid");
  assert.deepEqual(result.metrics, { baseline: null, candidate: null });
  assert.match(result.reason, /inconsistent verdicts/u);
});

test("pure word deletion, punctuation changes and vague qualifications cannot win", () => {
  const short = { ...candidate, headline: original.headline, body: oversight };
  const deletion = paired();
  deletion.candidate.claims[0].text = oversight;
  const result = decide(deletion, { after: short });
  assert.equal(result.decision, "revert");
  assert.match(result.reason, /word deletion/u);
  const hedged = paired(), hedge = "The pilot may have reduced inspection time.";
  hedged.candidate.claims[0] = claim("c1", hedge, "qualified", correction);
  const decision = decide(hedged, { after: { ...candidate, body: `${hedge} ${oversight}` } });
  assert.equal(decision.decision, "revert");
  assert.equal(decision.metrics.candidate.qualified, 1);
  assert.match(decision.reason, /No strict increase/u);
});

test("support cannot regress elsewhere in exchange for a central improvement", () => {
  const raw = paired();
  const changed = "Inspectors reviewed some trial reports.";
  raw.candidate.claims[1] = claim("c2", changed, "unresolved");
  const result = decide(raw, { after: { ...candidate, body: `${correction} ${changed}` } });
  assert.equal(result.decision, "revert");
  assert.match(result.reason, /regressed/u);
});

test("new factual assertions are inspected and must have valid supporting citations", () => {
  const added = "The pilot used one bridge.", raw = paired();
  raw.candidate.addedClaims = [claim("a1", added, "supported")];
  const after = { ...candidate, body: `${candidate.body} ${added}` };
  assert.equal(decide(raw, { after }).decision, "keep");
  for (const verdict of ["unresolved", "contradicted", "qualified"]) {
    const risky = paired(); risky.candidate.addedClaims = [claim("a1", added, verdict)];
    const result = decide(risky, { after });
    assert.equal(result.decision, "revert");
    assert.match(result.reason, /Additional factual assertions/u);
  }
  raw.candidate.addedClaims[0].citations[0].sourceId = "unread";
  invalidEvaluation(raw);
  const omittedInventory = paired(); delete omittedInventory.candidate.addedClaims;
  invalidEvaluation(omittedInventory);
});

test("an earlier round's added information cannot silently disappear", () => {
  const added = "The pilot used one bridge.", raw = paired();
  raw.baseline.addedClaims = [claim("a1", added, "supported")];
  const result = decide(raw, { before: { ...original, body: `${original.body} ${added}` } });
  assert.equal(result.decision, "revert");
  assert.match(result.reason, /information.*disappeared/u);
});

test("model scores, mixed pairs, mutated rubrics and post-parse edits cannot bypass validation", () => {
  const one = parseEvaluation(paired(), { audit, evidence });
  const two = parseEvaluation(paired(), { audit, evidence });
  const args = { ...one, currentStory: original, candidateStory: candidate, audit };
  assert.throws(() => { one.candidate.claims[0].citations.length = 0; }, TypeError);
  assert.equal(decideCandidate({ ...args, candidate: two.candidate }).decision, "invalid");
  assert.equal(decideCandidate({ ...args, ...clone(one) }).decision, "invalid");
  assert.equal(decideCandidate({ ...args, baseline: { score: 0 }, candidate: { score: 100 } }).decision, "invalid");
  const stale = clone(rawAudit); stale.goals[0].question = "A different, easier question?";
  assert.equal(decideCandidate({ ...args, audit: stale }).decision, "invalid");
  assert.equal(decideCandidate({ ...args, candidateStory: { ...candidate, sourceIds: [] } }).decision, "revert");
});

test("bounded evidence cannot be cited beyond what the evaluator actually saw", () => {
  const long = [{ ...evidence[0], text: `${"x".repeat(AUTO_RESEARCH_LIMITS.maxEvidenceText)} ${correction}` }];
  const prompt = evaluationPrompt({ original, current: original, candidate, audit, evidence: long });
  const visible = JSON.parse(prompt[1].content).evidence;
  assert.equal(visible[0].text.length, AUTO_RESEARCH_LIMITS.maxEvidenceText);
  assert.equal(visible[0].truncated, true);
  invalidEvaluation(paired(), long);
  assert.throws(() => parseEvaluation(paired(), { audit, evidence: [evidence[0], evidence[0]] }),
    /repeats a source ID/u);
});

test("uncited uncertainty remains unresolved and is visible as missing evidence coverage", () => {
  const raw = paired();
  raw.baseline.claims[0] = claim("c1", badClaim, "unresolved");
  const result = decide(raw);
  assert.equal(result.decision, "keep");
  assert.equal(result.metrics.baseline.unresolved, 1);
  assert.equal(result.metrics.baseline.evidenceCoverage, 0.5);
  assert.equal(result.metrics.candidate.evidenceCoverage, 1);
});

test("article insertions, removed clauses and cross-version excerpts get exact diagnostics before scores", () => {
  const raw = paired();
  raw.baseline.claims[0].text = `the ${badClaim}`;
  raw.baseline.addedClaims = [claim("a1", "Inspectors reviewed trial reports.", "unresolved")];
  raw.candidate.addedClaims = [claim("a2", badClaim, "unresolved")];
  const context = { audit, evidence, currentStory: original, candidateStory: candidate };
  assert.throws(() => parseEvaluation(raw, context), (error) => {
    assert.equal(error.code, "AUTO_RESEARCH_INVALID_EVALUATION");
    assert.deepEqual(error.issues.map(({ path }) => path), [
      "baseline.claims.c1.text", "baseline.addedClaims.a1.text", "candidate.addedClaims.a2.text",
    ]);
    assert.ok(error.issues.every(({ code }) => code === "STORY_EXCERPT_ABSENT"));
    return true;
  });
  // Legacy text-only callers still fail closed at the decision boundary.
  const result = decide(raw);
  assert.equal(result.decision, "invalid");
  assert.equal(result.issues.length, 3);
  assert.deepEqual(result.metrics, { baseline: null, candidate: null });
});

test("stable excerpt IDs resolve only from the assessed version and retain evidence checks", () => {
  const prompt = evaluationPrompt({ original, current: original, candidate, audit, evidence });
  const { storyExcerpts: excerpts } = JSON.parse(prompt[1].content);
  const raw = paired(), context = { audit, evidence, currentStory: original, candidateStory: candidate };
  for (const side of ["baseline", "candidate"]) for (const row of raw[side].claims) {
    row.excerptId = excerpts[side].find(({ text }) => text === row.text).id;
    delete row.text;
  }
  const parsed = parseEvaluation(raw, context);
  assert.deepEqual(parsed, parseEvaluation(paired(), context));
  assert.equal(decideCandidate({ ...parsed, ...context }).decision, "keep");
  assert.ok(excerpts.baseline.some(({ id, text }) => id === "baseline:headline" && text === original.headline));
  const wrongVersion = clone(raw);
  wrongVersion.candidate.claims[0].excerptId = raw.baseline.claims[0].excerptId;
  assert.throws(() => parseEvaluation(wrongVersion, context), /candidate.claims\[0\].*this report's version/u);
  const unsupported = clone(raw);
  unsupported.candidate.claims[0].citations[0].quote = "An invented observation.";
  assert.throws(() => parseEvaluation(unsupported, context), /candidate.claims\[0\].*citation/u);
  const ambiguous = clone(raw);
  ambiguous.candidate.claims[0].text = correction;
  assert.throws(() => parseEvaluation(ambiguous, context), /exactly one/u);
});

test("same-evidence verdict conflicts are invalid even for unchanged added claims", () => {
  const raw = paired(), added = "The pilot used one bridge.";
  raw.baseline.addedClaims = [claim("a1", added, "unresolved")];
  raw.candidate.addedClaims = [claim("a1", added, "supported")];
  const result = decide(raw, {
    before: { ...original, body: `${original.body} ${added}` },
    after: { ...candidate, body: `${candidate.body} ${added}` },
  });
  assert.equal(result.decision, "invalid");
  assert.deepEqual(result.metrics, { baseline: null, candidate: null });
  assert.equal(result.issues[0].code, "INCONSISTENT_VERDICTS");
});
