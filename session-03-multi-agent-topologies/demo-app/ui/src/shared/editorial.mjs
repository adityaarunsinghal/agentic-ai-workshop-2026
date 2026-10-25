import { PAPER_TEMPLATES } from "../../../src/layout-templates.mjs";

export const EDITORIAL_VIEWS = Object.freeze(Object.entries(PAPER_TEMPLATES)
  .map(([id, { label }]) => ({ id, label })));
export function recommendedView(settings) {
  return EDITORIAL_VIEWS.find((view) => view.id === settings.editorLayout) ?? null;
}
export function suggestedLead(issue) {
  return issue.stories.find((story) => story.id === issue.leadSuggestion || story.slotId === issue.leadSuggestion) ?? null;
}
export function editorialPairs(issue) {
  return (issue.relationships ?? []).map((relationship, index) => ({
    ...relationship, number: index + 1,
    label: relationship.kind === "counterpoint" ? "Counterpoint" : "Related coverage",
    stories: (relationship.storyIds ?? []).map((id) =>
      issue.stories.find((story) => story.id === id || story.slotId === id),
    ).filter(Boolean),
  })).filter((pair) => ["counterpoint", "related"].includes(pair.kind) && pair.stories.length >= 2);
}

export function editorialOutcome(receipt, issueRevision) {
  if (!receipt) return { status: "idle", label: "Ready for editorial choices" };
  if (receipt.status === "running") return { status: "running", label: "Choosing layout, lead and relationships…" };
  if (receipt.status === "failed") return { status: "failed", label: "Editorial request failed" };
  if (receipt.status === "interrupted") return { status: "interrupted", label: "Review interrupted; completion was not recorded" };
  if (receipt.status === "superseded") return { status: "superseded", label: "Superseded; result was not applied" };
  if (receipt.status === "complete") {
    if (Number.isSafeInteger(receipt.resultRevision) && Number.isSafeInteger(issueRevision) &&
        issueRevision > receipt.resultRevision) return { status: "stale", label: "Earlier choices; the issue has changed" };
    return { status: "complete", label: `Choices applied${receipt.resultRevision != null ? ` at revision ${receipt.resultRevision}` : ""}` };
  }
  return { status: receipt.status || "unavailable", label: "Editorial status unavailable" };
}

export function sameEditorialInputs(left, right) {
  return Boolean(left?.inputDigest && left?.questionDigest &&
    left.inputDigest === right?.inputDigest && left.questionDigest === right?.questionDigest);
}

export function sameEditorialChoiceInputs(left, right) {
  return Boolean(left?.inputDigest && left?.choiceQuestionDigest &&
    left.inputDigest === right?.inputDigest && left.choiceQuestionDigest === right?.choiceQuestionDigest);
}

export function receiptInputSets(receipts = []) {
  const groups = [], choiceGroups = [];
  return receipts.slice(-12).map((receipt) => {
    let inputSet = null, choiceSet = null;
    if (receipt.inputDigest && receipt.questionDigest) {
      let index = groups.findIndex((other) => sameEditorialInputs(receipt, other));
      if (index < 0) { index = groups.length; groups.push(receipt); }
      inputSet = index + 1;
    }
    if (receipt.inputDigest && receipt.choiceQuestionDigest) {
      let index = choiceGroups.findIndex((other) => sameEditorialChoiceInputs(receipt, other));
      if (index < 0) { index = choiceGroups.length; choiceGroups.push(receipt); }
      choiceSet = index + 1;
    }
    return { receipt, inputSet, choiceSet };
  });
}

export const assessmentReference = (check = {}) => check.traceId ?? check.executionId ?? check.requestId ?? null;

export function assessmentDetails(check = {}, record, storyId) {
  const questionId = check.questionId ?? `check_${storyId}`;
  const question = record?.payload?.questions?.[questionId] ?? record?.questions?.[questionId] ??
    record?.input?.questions?.[questionId] ?? check.question;
  const response = record?.result?.answers?.[questionId] ?? record?.answers?.[questionId] ??
    record?.output?.answers?.[questionId] ?? record?.response?.answers?.[questionId] ?? check.response;
  return { question, response, record: record ?? null };
}
