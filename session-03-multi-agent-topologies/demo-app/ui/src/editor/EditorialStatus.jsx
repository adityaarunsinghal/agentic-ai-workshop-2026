import React, { useEffect, useState } from "react";
import { editorialOutcome } from "../shared/editorial.mjs";
import { durationLabel } from "../shared/execution.mjs";
import { errorMessage } from "../shared/state.mjs";
import { resultExecutionHistory } from "../shared/briefings.mjs";
import { Dialog } from "../shared/Dialog.jsx";
import { JsonInspector } from "../shared/Inspector.jsx";

export function EditorialStatus({ editorial, issueRevision, onExecution, scope = "all", compact = false, summary = false, settled = false }) {
  const [now, setNow] = useState(Date.now);
  const [savedResult, setSavedResult] = useState(null);
  useEffect(() => {
    if (editorial?.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [editorial?.status, editorial?.requestId]);
  if (!editorial) return null;
  const outcome = settled && editorial.status === "complete"
    ? { status: "complete", label: "Layout settled" } : editorialOutcome(editorial, issueRevision);
  const history = resultExecutionHistory(editorial);
  const started = Date.parse(editorial.startedAt);
  const elapsed = editorial.status === "running" && Number.isFinite(started)
    ? Math.max(0, now - started) : editorial.durationMs;
  const label = editorial.status === "running"
    ? editorial.phase === "queued" ? "Editorial review queued…"
      : editorial.phase === "bootstrap" ? "Resolving the selected model…"
        : ({ layout: "Choosing layout and lead…", relationships: "Reviewing story relationships…" }[scope] ?? outcome.label)
    : outcome.label;
  const batchCount = Number.isSafeInteger(editorial.batchCount) ? editorial.batchCount : 0;
  const batchIndex = Number.isSafeInteger(editorial.batchIndex) ? editorial.batchIndex : 0;
  const cachedBatches = Number.isSafeInteger(editorial.cachedBatchCount) ? editorial.cachedBatchCount : 0;
  const requestedBatches = Number.isSafeInteger(editorial.requestedBatchCount) ? editorial.requestedBatchCount : null;
  const partialCache = cachedBatches > 0 && cachedBatches < batchCount;
  const backend = editorial.backend === "chat" ? "General" : editorial.backend === "decisions" ? "Native" : "Editorial";
  const modelName = editorial.model?.split("/").at(-1)?.replace(/^jev(?=-|$)/i, "Jev") || "Model not reported";
  if (summary) return <div className="editorial-summary" data-status={outcome.status}>
    <strong role="status">{settled && editorial.status === "complete" ? "Layout settled" : editorial.status === "running"
      ? editorial.phase === "queued" ? "Review queued" : editorial.phase === "bootstrap" ? "Resolving model…" : "Reviewing issue…"
      : ({ complete: "Choices ready", stale: "Earlier choices", failed: "Review failed",
        interrupted: "Review interrupted", superseded: "Review superseded" }[outcome.status] || outcome.label)}</strong>
    <span className="editorial-model" title={`${backend} · ${editorial.model || "Model not reported"}`}>
      {backend} · {modelName}
    </span>
    <span className="editorial-time" aria-label={editorial.status === "running" ? "Elapsed request time" : "Recorded request duration"}>
      {durationLabel(elapsed)}{editorial.cached ? " · cached" : ""}
    </span>
  </div>;
  return (
    <div className={`editorial-status ${compact ? "compact" : ""}`} data-status={outcome.status}>
      <div role="status" aria-live="polite">
        <strong>{label}</strong>
        <span>{editorial.model || "Model not reported"} · {editorial.backend === "chat" ? "General model" : editorial.backend === "decisions" ? "Native decisions" : "Editorial request"}</span>
        {editorial.status === "running" && batchCount > 1 && <span>
          {batchIndex > 0 && batchIndex <= batchCount ? `Batch ${batchIndex} of ${batchCount}` : `Preparing ${batchCount} batches`}
        </span>}
        {editorial.cached && <span>Cached result</span>}
        {partialCache && <span>Partial cache · {cachedBatches} of {batchCount} batches reused
          {requestedBatches !== null ? ` · ${requestedBatches} requested` : ""}</span>}
      </div>
      <span className="editorial-time" aria-label={editorial.status === "running" ? "Elapsed request time" : "Recorded request duration"}>
        {durationLabel(elapsed)}{editorial.status === "running" && Number.isFinite(started) ? " elapsed" : ""}
      </span>
      {editorial.status === "running" && <progress aria-label={label} />}
      {editorial.error && <p className="editorial-error" role="alert">{errorMessage(editorial.error)}</p>}
      {editorial.status === "superseded" && editorial.supersededReason && <p className="editorial-error">{editorial.supersededReason}</p>}
      {history.available === false ? <>
        <p className="hint" role="status">{history.label}</p>
        <button type="button" className="text-button" onClick={() => setSavedResult(editorial)}>Inspect saved result</button>
      </> : editorial.requestId && onExecution && <button type="button" className="text-button"
        onClick={() => onExecution(editorial.requestId)}>Open Execution</button>}
      {savedResult && <Dialog title="Saved editorial result" className="record-dialog" onClose={() => setSavedResult(null)}>
        <p className="hint" role="status">{resultExecutionHistory(savedResult).label}</p>
        <p className="hint">This is the compact result saved with the newspaper. It does not contain the full Execution trace.</p>
        <JsonInspector value={savedResult} />
      </Dialog>}
    </div>
  );
}
