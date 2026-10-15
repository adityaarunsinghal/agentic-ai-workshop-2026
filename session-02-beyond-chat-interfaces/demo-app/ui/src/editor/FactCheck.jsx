import React from "react";
import { factCheckDisplay } from "../shared/state.mjs";

export function FactCheck({ story, editorial, onClick, compact = false }) {
  const assessment = factCheckDisplay(story, editorial);
  const value = assessment.percentage !== null ? `${assessment.percentage}%`
    : ({ pending: "Pending", queued: "Pending", running: "Pending", stale: "Stale",
      failed: "Failed", error: "Failed", unavailable: "—" }[assessment.status] ?? "—");
  return (
    <button
      type="button"
      className={`fact-check ${compact ? "compact" : ""}`}
      onClick={onClick}
      data-status={assessment.status}
      aria-label={`Fact-check needed: ${assessment.label}. Model estimate of additional factual verification needed before publication, based on the supplied evidence. Open evidence and assessment.`}
      title={`${assessment.label} · model estimate, not a factual-verification status`}
    >
      <span className="fact-check-label">Factual verification needed</span>
      <span className="fact-check-track" aria-hidden="true">
        {assessment.percentage !== null && (
          <span style={{ width: `${assessment.percentage}%` }} data-high={assessment.percentage >= 60} />
        )}
      </span>
      <strong className="fact-check-value">{value}</strong>
    </button>
  );
}
