import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog } from "../shared/Dialog.jsx";
import { JsonInspector } from "../shared/Inspector.jsx";
import { FACT_CHECK_QUESTION, factCheckDisplay, hasFactCheck } from "../shared/state.mjs";
import { FactCheck } from "./FactCheck.jsx";
import { assessmentDetails, assessmentReference } from "../shared/editorial.mjs";
import { RevisionDemo } from "./RevisionDemo.jsx";
import { EditorialStatus } from "./EditorialStatus.jsx";
import { AutoResearch } from "./AutoResearch.jsx";

export function Evidence({ story, state, controller, onClose, onInspect, onTrace }) {
  const sources = state.issue.sources.filter((source) => story.sourceIds?.includes(source.id));
  const check = story.factCheck ?? {};
  const status = factCheckDisplay(story);
  const reference = assessmentReference(check);
  const query = useQuery({
    queryKey: ["execution-record", state.issue.id, reference],
    queryFn: ({ signal }) => controller.getExecutionRecord(reference, signal),
    enabled: hasFactCheck(state.settings.stage) && reference != null,
    retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false,
  });
  const record = query.data;
  const { question: suppliedQuestion, response } = assessmentDetails(check, record, story.id);
  const assessmentRecord = {
    assessment: check,
    proposition: FACT_CHECK_QUESTION,
    question: suppliedQuestion ?? "The exact supplied question is unavailable.",
    response: response ?? "The original model response is unavailable.",
    execution: record ?? null,
  };
  return (
    <Dialog title="Evidence & fact-checking" subtitle={story.headline || story.prompt} onClose={onClose} className="evidence-dialog">
      {state.settings.stage === "research" && <AutoResearch key={story.slotId}
        story={story} state={state} controller={controller} onExecution={onTrace} evidence />}
      {hasFactCheck(state.settings.stage) && (
        <section className="assessment-detail">
          <FactCheck story={story} editorial={state.editorial} onClick={() => onInspect(assessmentRecord, "Fact-check assessment")} />
          <p className="hint">Native Noul estimates the need for additional factual verification. A low estimate does not establish verification; human and source review are recorded separately.</p>
          {state.editorial?.requestId && state.editorial.requestId !== reference && <>
            <EditorialStatus editorial={state.editorial} issueRevision={state.issue.revision} compact onExecution={onTrace} />
            <p className="hint">The question and answer below belong to the saved assessment. Open the current request in Execution to inspect its outcome.</p>
          </>}
          {reference && query.isPending && <p role="status">Loading the exact assessment question and output…</p>}
          {query.error && <p className="notice" role="alert">{query.error.message} <button type="button" className="text-button" onClick={() => query.refetch()}>Retry assessment read</button></p>}
          <dl className="record-metadata">
            <dt>Review scope</dt><dd>{FACT_CHECK_QUESTION}</dd>
            <dt>Exact question</dt><dd>{typeof suppliedQuestion === "string" ? suppliedQuestion : suppliedQuestion?.instructions || "Not available in the recorded assessment."}</dd>
            <dt>Model</dt><dd>{record?.resolvedModel ?? record?.model ?? check.model ?? "Not reported"}</dd>
            <dt>Saved assessment state</dt><dd>{status.status}</dd>
            <dt>Input revision</dt><dd>{check.inputRevision ?? check.issueRevision ?? "Not reported"}</dd>
            <dt>Copy version</dt><dd>{check.contentVersion ?? check.inputContentVersion ?? "Not reported"}</dd>
            <dt>Human review</dt><dd>{story.reviewStatus || check.humanReviewStatus || "Not reviewed"}</dd>
          </dl>
          <div className="button-row">
            <button type="button" className="quiet" disabled={Boolean(reference && query.isPending)} onClick={() => onInspect(assessmentRecord, "Complete Noul assessment")}>Question, response & JSON</button>
            {reference && <button type="button" className="quiet" onClick={() => onTrace(reference)}>Open Execution record</button>}
          </div>
          {response !== undefined && <details><summary>Supplied question & returned answer</summary><JsonInspector value={{ question: suppliedQuestion, response }} /></details>}
          {state.settings.stage === "final" && <RevisionDemo controller={controller} onExecution={onTrace} />}
        </section>
      )}
      <section className="evidence-list">
        <h3>Supplied sources</h3>
        {sources.map((source) => (
          <article key={source.id}>
            <div className="section-head"><h3>{source.title}</h3><span className="trace-badge">{source.evidenceLevel || source.kind}</span></div>
            <p className="evidence-text">{source.text || source.excerpt || source.summary || "Metadata only; no article text supplied."}</p>
            <div className="button-row">
              <button className="quiet" type="button" onClick={() => onInspect(source, source.title)}>Full source record</button>
              {(source.canonicalUrl || source.url) && <button className="text-button" type="button"
                onClick={() => controller.openLink(source.canonicalUrl || source.url)}>Open original ↗</button>}
            </div>
          </article>
        ))}
        {!sources.length && <p className="empty">This treatment has no observed supporting source references.</p>}
      </section>
      <details><summary>Complete editorial treatment</summary><JsonInspector value={story} /></details>
    </Dialog>
  );
}
