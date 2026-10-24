import React from "react";
import { persistenceDisplay } from "../shared/persistence.mjs";

export function PersistenceStatus({ persistence, inline = false, retrying = false, exporting = false,
  onRetry, onExport, actionError = "" }) {
  const status = persistenceDisplay(persistence);
  if (!status.failed)
    return inline ? <span className="host-connection" role="status">{status.label}</span> : null;
  if (inline) return null;
  return (
    <div className="notice host-notice" role="alert">
      <div>
        <strong>{status.label}. </strong>
        <span>{actionError || persistence.error?.message || "The save has not been acknowledged. Your changes remain in this visit."}</span>
        <div>Keep this visit open while you retry or export. Export includes changes already sent by the editor.</div>
      </div>
      <div className="button-row">
        <button type="button" className="quiet" disabled={retrying || exporting} onClick={onRetry}>
          {retrying ? "Retrying save…" : "Retry save"}
        </button>
        <button type="button" className="quiet" disabled={retrying || exporting} onClick={onExport}>
          {exporting ? "Preparing HTML…" : "Export HTML"}
        </button>
      </div>
    </div>
  );
}
