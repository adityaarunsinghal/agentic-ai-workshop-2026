import React, { useEffect, useRef, useState } from "react";
import { tidyLayoutPlan } from "../shared/geometry.mjs";
import { PAPER_TEMPLATES, planPaperTemplate } from "../../../src/layout-templates.mjs";
import { LayoutProposalCallout } from "./LayoutProposalCallout.jsx";

const active = (job) => ["pending", "queued", "researching", "reading", "writing", "running", "resizing"].includes(job.status);
const storageKey = (issueId) => `session-2.layout-suggestions:${issueId}`;

function remembered(issueId) {
  try {
    const values = JSON.parse(window.sessionStorage.getItem(storageKey(issueId)) ?? "[]");
    return Array.isArray(values) ? values.filter((value) => typeof value === "string").slice(-32) : [];
  } catch { return []; }
}

function remember(issueId, receiptKey) {
  try {
    window.sessionStorage.setItem(storageKey(issueId), JSON.stringify([...new Set([...remembered(issueId), receiptKey])].slice(-32)));
  } catch { /* Sandboxed visits still retain the in-memory choice. */ }
}

function candidatePlan(kind, state, measurements, template) {
  if (kind === "template") return planPaperTemplate(state.issue, template, measurements);
  if (state.issue.stories.some((story) => !story.hidden && story.section !== "hidden" &&
    measurements[story.slotId ?? story.id]?.paperTemplate !== (state.issue.layoutTemplate ?? null))) return null;
  const plan = tidyLayoutPlan(state.issue.stories, measurements, { leadSlotId: state.issue.leadSuggestion });
  if (!plan) return null;
  return { ...plan, ok: true, changes: plan.frames.map((change) => {
    const original = state.issue.stories.find((story) => (story.slotId ?? story.id) === change.slotId).frame;
    return { ...change, original, resized: original.width !== change.frame.width || original.height !== change.frame.height };
  }) };
}

const samePlan = (left, right) => left && right && left.ok === right.ok && left.reason === right.reason &&
  JSON.stringify(left.frames) === JSON.stringify(right.frames);

export function LayoutSuggestion({ state, measurements, controller, onProposalChange }) {
  const seen = useRef(new Set());
  const [proposal, setProposal] = useState(null);
  const [applying, setApplying] = useState(false);
  const template = Object.hasOwn(PAPER_TEMPLATES, state.settings.editorLayout) ? state.settings.editorLayout : null;
  // One geometry notification at a time. Cleanup remains a separate proposal
  // when the recommendation already matches the applied newspaper template.
  const kind = template && template !== state.issue.layoutTemplate ? "template" : "tidy";
  const requestId = kind === "template" ? state.editorial?.requestId
    : state.settings.layoutCleanupRequestId ?? state.editorial?.requestId;
  const sourceRequestId = kind === "template" ? state.editorial?.sourceRequestId ?? requestId
    : state.settings.layoutCleanupSourceRequestId ?? requestId;
  const documentVersion = state.documentVersion ?? 0;
  const operation = state.layoutOperation;
  const receiptKey = `${state.issue.id}:${documentVersion}:${kind}:${template}:${operation?.id ?? sourceRequestId}`;
  const occupied = controller.dirty || controller.pending.length > 0 || controller.failed.length > 0 || state.jobs.some(active);
  const eligible = (kind === "template" || state.settings.layoutCleanup === "offer_tidy") &&
    state.editorial?.status === "complete" && requestId && state.editorial.requestId === requestId &&
    state.editorial.resultRevision === state.issue.revision && !occupied &&
    (!operation || (operation.status === "offered" && operation.reviewRequestId === requestId));

  useEffect(() => { onProposalChange?.(proposal); }, [proposal, onProposalChange]);

  useEffect(() => {
    if (applying) return;
    const plan = eligible ? candidatePlan(kind, state, measurements, template) : null;
    if (proposal) {
      if (!eligible || proposal.issueId !== state.issue.id || proposal.baseRevision !== state.issue.revision ||
        proposal.receiptKey !== receiptKey || !samePlan(plan, proposal)) setProposal(null);
      return;
    }
    if (!plan || plan.pending || plan.alreadyApplied ||
      seen.current.has(receiptKey) || remembered(state.issue.id).includes(receiptKey)) return;
    setProposal({ ...plan, kind, template, issueId: state.issue.id, baseRevision: state.issue.revision, documentVersion, receiptKey });
  }, [state, measurements, eligible, receiptKey, proposal, applying, kind, template, documentVersion]);

  if (!proposal) return operation?.status === "failed" && operation.reason
    ? <p className="notice" role="alert">{operation.reason}</p> : null;
  const dismiss = () => {
    seen.current.add(proposal.receiptKey);
    remember(proposal.issueId, proposal.receiptKey);
    while (seen.current.size > 32) seen.current.delete(seen.current.values().next().value);
    setProposal(null);
  };
  return <LayoutProposalCallout proposal={proposal} applying={applying}
    onDecline={dismiss}
    onApprove={async () => {
        const latest = controller.authoritative;
        const plan = candidatePlan(proposal.kind, state, measurements, proposal.template);
        if (applying || !eligible || !plan?.ok || latest?.issue.id !== proposal.issueId ||
          latest.issue.revision !== proposal.baseRevision || (latest.documentVersion ?? 0) !== proposal.documentVersion ||
          !samePlan(plan, proposal)) { setProposal(null); return; }
        setApplying(true);
        try {
          const result = await controller.run("apply_layout", {
            issueId: proposal.issueId, baseRevision: proposal.baseRevision, frames: proposal.frames,
            ...(proposal.kind === "template" ? { template: proposal.template } : {}),
            ...(operation ? { approval: {
              intentId: operation.id, reviewRequestId: operation.reviewRequestId,
              documentVersion: proposal.documentVersion, kind: proposal.kind,
            } } : {}),
          });
          if (result) dismiss();
        } finally { setApplying(false); setProposal(null); }
      }} />;
}
