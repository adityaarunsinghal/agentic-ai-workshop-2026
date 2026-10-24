import React, { useState } from "react";
import { requestRevisionDemo, REVISION_DEMO_LABEL } from "../shared/revision-demo.mjs";

export function RevisionDemo({ controller, disabled = false, onExecution }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  return (
    <section className="revision-demo" aria-label="Revision demonstration">
      <p className="hint">Teaching placeholder: this records the proposed next step. It does not start research, call a model or change copy.</p>
      <button type="button" disabled={disabled || pending} onClick={async () => {
        setPending(true); setError(""); setResult(null);
        try { setResult(await requestRevisionDemo(controller.run)); }
        catch (failure) { setError(failure.message); }
        finally { setPending(false); }
      }}>{REVISION_DEMO_LABEL}</button>
      {pending && <p className="hint" role="status">Recording the demonstration…</p>}
      {result && <p role="status">{result.message}</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      {result?.requestId && onExecution && <button type="button" className="text-button"
        onClick={() => onExecution(result.requestId)}>Open Execution</button>}
    </section>
  );
}
