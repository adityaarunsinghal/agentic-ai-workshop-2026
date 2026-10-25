// LEARNING: Start with AutoResearch(): request or stop a run and display its reported research cycle.
// Next: ui/src/shared/Execution.jsx to inspect the requests and Keep/Revert records behind these states.

import React, { useRef, useState } from "react";
import { TOPOLOGIES, errorMessage } from "../shared/state.mjs";

const active = (run) => {
  return ["queued", "running"].includes(run?.status);
};
const writing = new Set([
  "queued",
  "pending",
  "researching",
  "reading",
  "writing",
  "running",
  "resizing",
]);
const phases = [
  ["audit", "Audit"],
  ["research", "Research"],
  ["experiment", "Experiment"],
  ["evaluate", "Evaluate"],
  ["decision", "Keep / Revert"],
];
const phaseLabels = {
  audit: "Auditing claims",
  research: "Researching sources",
  experiment: "Trying a revision",
  evaluate: "Evaluating the revision",
  keep: "Keeping the revision",
  revert: "Reverting the experiment",
  check: "Checking claims",
  finished: "Finished",
};
const statusLabels = {
  queued: "Queued",
  completed: "Completed",
  stopped: "Stopped",
  failed: "Failed",
  superseded: "Superseded by newer edits",
  interrupted: "Interrupted",
  paused: "Paused; step saved",
};
const count = (value) => {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const fraction = (value, total) => {
  return count(value) === null
    ? "Not reported"
    : count(total) === null
      ? String(value)
      : `${value} / ${total}`;
};

// LEARNING: MAIN BEHAVIOR
export function AutoResearch({
  story,
  state,
  controller,
  onExecution,
  evidence = false,
  compact = false,
  onDetails,
}) {
  const [pending, setPending] = useState(null);
  const [failure, setFailure] = useState("");
  const [stopRequested, setStopRequested] = useState(null);
  // Session 3: the arrangement chosen in the host header. The run itself still crosses
  // the controller boundary; execution and the Keep gate stay on the server.
  const topology = state.settings?.topology ?? "single";
  const arrangement =
    TOPOLOGIES.find((item) => {
      return item.id === topology;
    })?.label ?? "Single agent";
  const submitting = useRef(false);
  const runs = state.autoResearchRuns ?? [];
  const run =
    story &&
    runs.find((item) => {
      return item.slotId === story.slotId && item.storyId === story.id;
    });
  const running = active(run);
  const hasCopy = Boolean(story?.headline?.trim() || story?.body?.trim());
  const activeCount = runs.filter(active).length;
  const forStory = (entry) => {
    return Boolean(
      story && (entry.arguments?.slotId ?? entry.target?.slotId) === story.slotId,
    );
  };
  const queuedAction = controller.pending.some((entry) => {
    return entry.name === "request_auto_research" && forStory(entry);
  });
  const writerBusy = Boolean(
    story &&
    (state.jobs.some((job) => {
      return (
        job.type !== "auto_research" &&
        job.slotId === story.slotId &&
        writing.has(job.status)
      );
    }) ||
      controller.pending.some((entry) => {
        return ["request_story", "move_story"].includes(entry.name) && forStory(entry);
      })),
  );
  const stopping =
    pending === "stop" ||
    (running && stopRequested === run.id) ||
    controller.pending.some((entry) => {
      return (
        entry.name === "cancel_auto_research" && entry.arguments?.runId === run?.id
      );
    });
  const busy = Boolean(pending || queuedAction || stopping);
  const canStart =
    Boolean(story?.body?.trim()) &&
    !story.locked &&
    !running &&
    !busy &&
    !writerBusy &&
    !controller.resetting &&
    controller.connection.isConnected;
  const round = count(run?.round);
  const maxRounds = count(run?.maxRounds);
  const resumable = Boolean(run?.resumable);
  const recovery = run?.recovery;
  const startLabel = resumable
    ? "Resume saved step"
    : `Fact-check with the ${arrangement.toLowerCase()}`;

  const outcome = ["keep", "revert"].includes(run?.lastDecision?.decision)
    ? run.lastDecision.decision
    : null;
  const invalidEvaluation = run?.lastDecision?.decision === "invalid";
  const progress =
    recovery?.status === "repairing" && running
      ? "Repairing response format"
      : invalidEvaluation
        ? running
          ? "Rechecking the evaluation"
          : "Evaluation unavailable; copy preserved"
        : run?.status === "running"
          ? phaseLabels[run.phase] || "Working"
          : statusLabels[run?.status] || "Status not reported";
  // LEARNING: Scores and Keep/Revert outcomes come from the saved run; this component does not judge copy.
  const evaluation = run?.currentEvaluation;
  const reportedMetrics =
    evaluation && typeof evaluation === "object"
      ? [
          ["Supported claims", fraction(evaluation.supported, evaluation.claimsTotal)],
          ["Unresolved claims", count(evaluation.unresolved) ?? "Not reported"],
          ["Contradicted claims", count(evaluation.contradicted) ?? "Not reported"],
          ["Reader goals met", fraction(evaluation.goalsMet, evaluation.goalsTotal)],
          ...(evaluation.omitted > 0
            ? [["Omitted claims", count(evaluation.omitted)]]
            : []),
        ]
      : [];
  const reason = story?.locked
    ? "Unlock this story to fact-check it."
    : !story
      ? `Select a written story to fact-check it.${activeCount ? ` ${activeCount} run${activeCount === 1 ? "" : "s"} active.` : ""}`
      : writerBusy
        ? "Wait for the current story request to finish before starting a fact-check."
        : !story.body?.trim()
          ? "Add body copy to this story first."
          : null;

  // LEARNING: Start, resume and stop cross the controller boundary; execution remains on the server.
  async function act(action) {
    if (submitting.current) {
      return;
    }
    submitting.current = true;
    setPending(action);
    setFailure("");
    try {
      const result =
        action === "stop"
          ? await controller.cancelAutoResearch(run.id)
          : await controller.requestFactCheck(story, topology);
      if (result && action === "stop") {
        setStopRequested(run.id);
      }
      if (!result) {
        setFailure(
          action === "stop"
            ? "Stop was not acknowledged. Check the run’s current status in Execution."
            : "The request was not acknowledged. Check Execution before starting another run.",
        );
      }
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      submitting.current = false;
      setPending(null);
    }
  }

  if (compact) {
    return (
      <section
        className="auto-research-compact"
        aria-label="Fact-check"
        data-status={run?.status || "idle"}
        data-run-id={run?.id}
      >
        <strong>Fact-check · {arrangement}</strong>
        <span
          className="auto-research-current"
          role="status"
          title={reason || story?.headline || story?.prompt}
        >
          {run
            ? `${round > 0 ? `Round ${round}${maxRounds ? `/${maxRounds}` : ""} · ` : ""}${progress}`
            : reason || story?.headline || "Ready"}
        </span>

        {outcome && (
          <button
            type="button"
            className="text-button auto-research-verdict"
            data-decision={outcome}
            title={run.lastDecision.reason}
            onClick={onDetails}
          >
            {outcome === "keep" ? "Keep" : "Revert"} ↗
          </button>
        )}
        {running ? (
          <button
            type="button"
            className="quiet"
            disabled={
              busy || controller.resetting || !controller.connection.isConnected
            }
            onClick={() => {
              return act("stop");
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          hasCopy && (
            <button
              type="button"
              disabled={!canStart}
              onClick={() => {
                return act("start");
              }}
            >
              {pending === "start" || queuedAction
                ? resumable
                  ? "Resuming…"
                  : "Starting…"
                : startLabel}
            </button>
          )
        )}
        <button type="button" className="text-button" onClick={onDetails}>
          Fact-check details
        </button>
        {failure && (
          <p className="auto-research-error" role="alert">
            {failure}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      className={`auto-research ${evidence ? "auto-research-evidence" : "auto-research-toolbar"}`}
      aria-label="Fact-check"
      data-status={run?.status || "idle"}
      data-run-id={run?.id}
    >
      <div className="auto-research-heading">
        <div>
          <h3>Fact-check · {arrangement}</h3>
          {!evidence && story && (
            <p className="auto-research-story" title={story.headline || story.prompt}>
              {story.headline || story.prompt || "Selected story"}
            </p>
          )}
          {reason && <p className="hint">{reason}</p>}
        </div>
        <div className="auto-research-actions">
          {running ? (
            <button
              type="button"
              className="quiet"
              disabled={
                busy || controller.resetting || !controller.connection.isConnected
              }
              onClick={() => {
                return act("stop");
              }}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            hasCopy && (
              <>
                <button
                  type="button"
                  disabled={!canStart}
                  onClick={() => {
                    return act("start");
                  }}
                >
                  {pending === "start" || queuedAction
                    ? resumable
                      ? "Resuming\u2026"
                      : "Starting\u2026"
                    : startLabel}
                </button>
              </>
            )
          )}
          {run?.executionId && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                return onExecution(null, run.id);
              }}
            >
              Open Execution
            </button>
          )}
        </div>
      </div>
      {hasCopy && (
        <>
          <ol className="auto-research-cycle" aria-label="Research cycle">
            {phases.map(([id, label]) => {
              return (
                <li
                  key={id}
                  aria-current={
                    running &&
                    (id === run.phase ||
                      (id === "decision" && ["keep", "revert"].includes(run.phase)))
                      ? "step"
                      : undefined
                  }
                >
                  {label}
                </li>
              );
            })}
          </ol>
          {!run && (
            <p className="hint">
              Agents check each claim against the archive. Open Execution to watch them work.
            </p>
          )}
        </>
      )}
      {run && (
        <>
          <div className="auto-research-progress" role="status" aria-live="polite">
            <strong>
              {round > 0
                ? `Round ${round}${maxRounds > 0 ? ` of ${maxRounds}` : ""} · `
                : ""}
              {progress}
            </strong>
            <span>
              {count(run.kept) !== null && `Kept ${run.kept}`}
              {count(run.kept) !== null && count(run.reverted) !== null && " · "}
              {count(run.reverted) !== null && `Reverted ${run.reverted}`}
            </span>
          </div>
          {outcome && (
            <p className="auto-research-outcome" data-decision={outcome}>
              <strong>
                {recovery ? "Last completed decision: " : ""}
                {outcome === "keep" ? "Keep" : "Revert"}
              </strong>
              {run.lastDecision.reason && <span>{run.lastDecision.reason}</span>}
            </p>
          )}
          {invalidEvaluation && (
            <p className="auto-research-summary">{run.lastDecision.reason}</p>
          )}
          {reportedMetrics.length > 0 && (
            <dl
              className="auto-research-metrics"
              aria-label="Recorded evaluation metrics"
            >
              {reportedMetrics.map(([label, value]) => {
                return (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                );
              })}
            </dl>
          )}
          {recovery && reportedMetrics.length > 0 && (
            <p className="hint">Metrics from the last completed evaluation.</p>
          )}
          {outcome && !reportedMetrics.length && (
            <p className="hint">
              Comparable evaluation not reported. Inspect the decision in Execution.
            </p>
          )}
          {typeof run.summary === "string" &&
            run.summary &&
            run.summary !== run.lastDecision?.reason && (
              <p className="auto-research-summary">{run.summary}</p>
            )}
          {run.stopReason && (
            <p className="auto-research-stop">
              {run.status === "paused" ? "Paused: " : ""}
              {run.stopReason}
            </p>
          )}
          {resumable && (
            <p className="hint">
              Resume {phaseLabels[run.phase]?.toLowerCase() || "the saved step"} with
              the same sources.{" "}
              {count(run.remainingRequests) ??
                Math.max(0, (run.maxTurns ?? 0) - (run.turn ?? 0))}{" "}
              model requests remain.
            </p>
          )}
          {!running && (
            <p className="hint">
              Open Execution to see each verdict and its sources.
            </p>
          )}
        </>
      )}
      {failure && (
        <p className="auto-research-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
