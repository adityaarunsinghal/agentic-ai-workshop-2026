// LEARNING: Start with Execution(): browse summaries, then load the selected record's complete detail.
// Next: ui/src/shared/Inspector.jsx for the paired model input/output and JSON trees.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "./Dialog.jsx";
import { JsonInspector, RecordDialog } from "./Inspector.jsx";
import { errorMessage, formatCost, recordCost } from "./state.mjs";
import { editorialOutcome, receiptInputSets } from "./editorial.mjs";
import { resultExecutionHistory, savedExecutionResult } from "./briefings.mjs";
import { AutoResearchRecord, autoResearchPhase } from "./AutoResearchRecord.jsx";
import {
  actorOf,
  compactRecords,
  correlatedExchange,
  durationLabel,
  exchangeStillCapturing,
  exchangeTitle,
  executionParams,
  executionRunScope,
  executionTotals,
  groupTeachingRecords,
  isRunning,
  kindOf,
  LOCAL_SUMMARY_LIMIT,
  recordDepth,
  relatedRecordIds,
  statusOf,
  titleOf,
} from "./execution.mjs";

// LEARNING: MAIN BEHAVIOR
export function Execution({
  issueId,
  trace = [],
  jobs = [],
  hostRecords = [],
  summary = {},
  gateway = {},
  editorialHistory = [],
  listExecution,
  getExecutionRecord,
  onClose,
  onViewCount,
  clearExecution,
  initialRecordId = null,
  initialTaskId = "",
  compact = false,
}) {
  const queryClient = useQueryClient();
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const refreshTimer = useRef(null);
  const [filters, setFilters] = useState(() => {
    return {
      view: "teaching",
      query: "",
      taskId: executionRunScope({
        recordId: initialRecordId,
        taskId: initialTaskId,
        records: trace,
        jobs,
      }),
    };
  });
  const [search, setSearch] = useState("");
  const [trail, setTrail] = useState([null]);
  const [selection, setSelection] = useState({
    ids: initialRecordId != null ? [initialRecordId] : [],
    index: 0,
    open: initialRecordId != null,
  });
  const [localRecordId, setLocalRecordId] = useState(null);
  const cursor = trail[trail.length - 1];
  // LEARNING: Fetch a summary page here; ExecutionDetail loads original records only when selected.
  const query = useQuery({
    queryKey: ["execution-page", issueId, filters, cursor],
    queryFn: ({ signal }) => {
      return listExecution(executionParams({ ...filters, cursor }), signal);
    },
    enabled: typeof listExecution === "function",
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    // This component is mounted only while Execution is open. At most one page
    // and one selected original record stay in the query cache.
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (initialRecordId != null) {
      setSelection({ ids: [initialRecordId], index: 0, open: true });
      setFilters((previous) => {
        return {
          ...previous,
          taskId: executionRunScope({
            recordId: initialRecordId,
            taskId: initialTaskId,
            records: trace,
            jobs,
          }),
        };
      });
      setTrail([null]);
    } else if (initialTaskId) {
      setFilters((previous) => {
        return { ...previous, taskId: initialTaskId };
      });
      setTrail([null]);
    }
    // A live snapshot must not override a run or All runs selected by the user.
  }, [initialRecordId, initialTaskId]);
  const page = query.data;
  useEffect(() => {
    if (refreshTimer.current !== null) {
      return;
    }
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: ["execution-page", issueId] });
    }, 400);
  }, [summary?.latestSequence, queryClient, issueId]);
  useEffect(() => {
    return () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [issueId]);
  const rows = page?.records ?? [];
  // LEARNING: View filters change the rows and count; spending totals retain their broader scope.
  const totals = executionTotals(summary, gateway, page?.summary);
  const viewCount =
    page?.total ??
    (filters.query || filters.taskId
      ? null
      : (summary?.[filters.view === "teaching" ? "teachingRecords" : "totalRecords"] ??
        null));
  useEffect(() => {
    onViewCount?.(viewCount);
  }, [onViewCount, viewCount]);
  const local = compactRecords(hostRecords, LOCAL_SUMMARY_LIMIT);
  const localRecord = local.find((record) => {
    return record.id === localRecordId;
  });
  const records = useMemo(() => {
    return new Map(
      [...trace, ...rows].map((record) => {
        return [record.id, record];
      }),
    );
  }, [trace, rows]);
  const groups = groupTeachingRecords(rows);
  const scopedJob = jobs.find((job) => {
    return (job.taskId || job.id) === filters.taskId;
  });
  function selectRecord(id) {
    if (id == null) {
      return;
    }
    setSelection((previous) => {
      if (previous.ids[previous.index] === id) {
        return { ...previous, open: true };
      }
      const ids = [...previous.ids.slice(0, previous.index + 1), id].slice(-40);
      return { ids, index: ids.length - 1, open: true };
    });
  }
  function changeFilters(patch) {
    setFilters((previous) => {
      return { ...previous, ...patch };
    });
    setTrail([null]);
  }
  async function clearRecords() {
    setClearing(true);
    setClearError("");
    try {
      await queryClient.cancelQueries({ queryKey: ["execution-page", issueId] });
      await queryClient.cancelQueries({ queryKey: ["execution-record", issueId] });
      await clearExecution();
      setSelection({ ids: [], index: 0, open: false });
      setLocalRecordId(null);
      setSearch("");
      changeFilters({ query: "", taskId: "" });
      queryClient.removeQueries({ queryKey: ["execution-record", issueId] });
      queryClient.setQueriesData(
        { queryKey: ["execution-page", issueId] },
        (previous) => {
          return {
            ...previous,
            records: [],
            total: 0,
            nextCursor: null,
          };
        },
      );
      onViewCount?.(0);
      setClearConfirm(false);
      await queryClient.invalidateQueries({ queryKey: ["execution-page", issueId] });
    } catch (error) {
      setClearError(error.message);
    } finally {
      setClearing(false);
    }
  }
  return (
    <section
      className={`execution-panel ${compact ? "compact" : ""}`}
      aria-label="Execution timeline"
    >
      <div className="section-head">
        <div>
          <p className="eyebrow">OBSERVE THE WORK</p>
          <h2>Execution</h2>
        </div>
        {onClose && (
          <button className="quiet" type="button" onClick={onClose}>
            Back to editor
          </button>
        )}
      </div>
      <p className="hint execution-record-count" role="status">
        {viewCount !== null ? `${viewCount} records` : "Counting records…"}
        {` · ${filters.view === "teaching" ? "Simplified View" : "Protocol records"}`}
        {filters.query || filters.taskId ? " · current scope" : ""}
      </p>
      <p className="hint execution-totals">
        All runs
        {totals.requests !== null ? ` · ${totals.requests} model requests` : ""}
        {totals.live !== null ? ` · ${totals.live} live` : ""}
        {` · ${totals.knownCostUsd === null ? "Cost not reported" : `${formatCost(totals.knownCostUsd)} reported`}`}
        {totals.unknown !== null
          ? ` · ${totals.unknown} charge${totals.unknown === 1 ? "" : "s"} unknown or unsettled`
          : " · Settlement completeness not reported"}
        {totals.reservedUsd !== null
          ? ` · ${formatCost(totals.reservedUsd)} reserved`
          : ""}
        {totals.simulated ? " · Simulated" : ""}
      </p>
      <p className="hint">
        Simplified View pairs each model request with its captured response. The final
        request of each finished run has an outlined row. Protocol shows the original
        records. Counts follow the selected view and filters; spending totals cover all
        runs.
      </p>
      {totals.accountingUnavailable && (
        <p className="notice" role="alert">
          Cost accounting unavailable
          {totals.accountingError ? `: ${errorMessage(totals.accountingError)}` : "."}{" "}
          Charges are unknown until accounting recovers.
        </p>
      )}
      {totals.capture?.status === "partial" && (
        <p className="notice" role="status">
          Execution capture is partial
          {totals.capture.droppedRecords != null
            ? ` · ${totals.capture.droppedRecords} records not captured`
            : ""}
          .{totals.capture.reason ? ` ${totals.capture.reason}` : ""} Open Capture
          status for details.
        </p>
      )}
      {totals.capture && (
        <details>
          <summary>Capture status</summary>
          <JsonInspector value={{ ...page?.summary, ...summary }} />
        </details>
      )}
      <EditorialReceipts history={editorialHistory} onSelect={selectRecord} />
      {jobs.length > 0 && (
        <details className="execution-runs">
          <summary>Agent runs</summary>
          <div className="execution-jobs">
            {jobs.slice(-12).map((job) => {
              return (
                <button
                  key={job.id}
                  type="button"
                  className="job-record quiet"
                  onClick={() => {
                    return changeFilters({ taskId: job.taskId ?? job.id });
                  }}
                >
                  <span>{job.prompt || "Agent run"}</span>
                  <small>
                    {job.status} · Turn {job.turn ?? 0}/{job.maxTurns ?? 10}
                  </small>
                  {isRunning(job) && (
                    <progress
                      value={Math.min(job.maxTurns ?? 10, job.turn ?? 0)}
                      max={job.maxTurns ?? 10}
                      aria-label="Agent turns"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </details>
      )}
      <div
        className="execution-log-controls"
        role="group"
        aria-label="Execution controls"
      >
        <button
          className="quiet"
          type="button"
          aria-pressed={!filters.taskId}
          onClick={() => {
            return changeFilters({ taskId: "" });
          }}
        >
          All runs
        </button>
        {clearExecution && summary?.clearSupported && (
          <button
            className="quiet"
            type="button"
            disabled={clearing}
            onClick={() => {
              setClearError("");
              setClearConfirm(true);
            }}
          >
            Clear visible log
          </button>
        )}
        {selection.ids.length > 0 && !selection.open && (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              return setSelection((previous) => {
                return { ...previous, open: true };
              });
            }}
          >
            Return to record
          </button>
        )}
      </div>
      {clearConfirm && (
        <Dialog
          title="Start a new visible log?"
          onClose={() => {
            if (!clearing) {
              setClearConfirm(false);
            }
          }}
        >
          <p>
            Both views will start empty. Captured history stays in the application's
            archive. Your newspaper and spending totals stay as they are.
          </p>
          <p className="hint">
            History is retained in this application's storage. A new hosted visit does
            not yet restore the full archive from an earlier visit.
          </p>
          {clearError && (
            <p className="notice" role="alert">
              {clearError}
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="quiet"
              disabled={clearing}
              onClick={() => {
                return setClearConfirm(false);
              }}
            >
              Cancel
            </button>
            <button type="button" disabled={clearing} onClick={clearRecords}>
              {clearing ? "Saving…" : "Start new visible log"}
            </button>
          </div>
        </Dialog>
      )}
      {filters.taskId && (
        <p className="hint" role="status">
          Run: {scopedJob?.prompt || filters.taskId}. All runs also includes issue-level
          editorial and native-decision records.
        </p>
      )}
      <form
        className="execution-filters"
        onSubmit={(event) => {
          event.preventDefault();
          changeFilters({ query: search.trim() });
        }}
      >
        <input
          value={search}
          onChange={(event) => {
            return setSearch(event.target.value);
          }}
          placeholder="Find actor, model, request…"
          aria-label="Search Execution archive"
        />
        <button type="submit" className="quiet">
          Search
        </button>
        <select
          value={filters.view}
          onChange={(event) => {
            return changeFilters({ view: event.target.value });
          }}
          aria-label="Execution view"
        >
          <option value="teaching">Simplified View</option>
          <option value="protocol">Protocol records</option>
        </select>
        {summary?.sortSupported && (
          <select
            value={filters.order ?? "desc"}
            aria-label="Time order"
            onChange={(event) => {
              return changeFilters({ order: event.target.value });
            }}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        )}
      </form>
      {query.isFetching && !page && (
        <p className="hint" role="status">
          Loading Execution summaries…
        </p>
      )}
      {(query.error || !listExecution) && (
        <p className="notice" role="alert">
          {query.error?.message || "Execution archive access is not connected."}
        </p>
      )}
      {query.error && listExecution && (
        <button
          type="button"
          className="quiet"
          onClick={() => {
            return query.refetch();
          }}
        >
          Retry loading records
        </button>
      )}
      {filters.view === "teaching" ? (
        groups.map((group) => {
          return (
            <section className="execution-group" key={group.id}>
              <h3>
                {group.records.some(autoResearchPhase)
                  ? titleOf(
                      group.records.find((record) => {
                        return autoResearchPhase(record) === "run";
                      }) ?? { label: "Auto research" },
                    )
                  : jobs.find((job) => {
                      return job.id === group.id;
                    })?.prompt || titleOf(group.root)}
              </h3>
              <ol className="trace-list">
                {group.records.map((record, index) => {
                  return (
                    <ExecutionRow
                      key={record.id ?? index}
                      record={record}
                      records={records}
                      onSelect={selectRecord}
                    />
                  );
                })}
              </ol>
            </section>
          );
        })
      ) : (
        <ol className="trace-list">
          {rows.map((record, index) => {
            return (
              <ExecutionRow
                key={record.id ?? index}
                record={record}
                records={records}
                onSelect={selectRecord}
              />
            );
          })}
        </ol>
      )}
      {page && !rows.length && (
        <p className="empty">
          {filters.query || filters.taskId
            ? "No records match this search."
            : "Requests, turns, tool calls and harness actions appear here."}
        </p>
      )}
      <nav className="execution-pagination" aria-label="Execution pages">
        <button
          type="button"
          className="quiet"
          disabled={trail.length === 1 && cursor == null}
          onClick={() => {
            return setTrail([null]);
          }}
        >
          First page
        </button>
        <button
          type="button"
          className="quiet"
          disabled={trail.length <= 1}
          onClick={() => {
            return setTrail((previous) => {
              return previous.slice(0, -1);
            });
          }}
        >
          Previous page
        </button>
        <span className="hint">
          {rows.length} summaries on this page
          {page?.total != null ? ` · ${page.total} records in scope` : ""}
        </span>
        <button
          type="button"
          className="quiet"
          disabled={
            query.isFetching || page?.nextCursor == null || page.nextCursor === cursor
          }
          onClick={() => {
            return setTrail((previous) => {
              return [...previous.slice(-99), page.nextCursor];
            });
          }}
        >
          Next page
        </button>
      </nav>
      {local.length > 0 && (
        <details
          className="local-execution"
          open={local.some((record) => {
            return record.deliveryStatus === "failed";
          })}
        >
          <summary>Browser reports · this tab only · {local.length}</summary>
          <p className="hint">
            Archive receipt is not confirmed for these reports. Their fallback summaries
            are retained in this tab only.
          </p>
          {local.map((record, index) => {
            return (
              <button
                type="button"
                className="text-button"
                key={record.id ?? index}
                onClick={() => {
                  return setLocalRecordId(record.id);
                }}
              >
                {titleOf(record)} ·{" "}
                {record.deliveryStatus === "pending"
                  ? "Sending to archive"
                  : "This tab only"}
                {record.deliveryError && <small>{record.deliveryError}</small>}
              </button>
            );
          })}
        </details>
      )}
      {localRecord && (
        <RecordDialog
          record={localRecord}
          title={titleOf(localRecord)}
          onClose={() => {
            return setLocalRecordId(null);
          }}
          description="This tab only · archive receipt not confirmed"
        >
          <p className="hint">
            This summary describes a browser observation. It does not verify a server
            action.
          </p>
        </RecordDialog>
      )}
      {selection.open && selection.ids[selection.index] != null && (
        <ExecutionDetail
          id={selection.ids[selection.index]}
          issueId={issueId}
          getExecutionRecord={getExecutionRecord}
          savedResult={savedExecutionResult(
            { editorialHistory },
            selection.ids[selection.index],
          )}
          summaries={[...records.values()]}
          selection={selection}
          onNavigate={(offset) => {
            return setSelection((previous) => {
              return {
                ...previous,
                index: Math.max(
                  0,
                  Math.min(previous.ids.length - 1, previous.index + offset),
                ),
              };
            });
          }}
          onSelect={selectRecord}
          onClose={() => {
            return setSelection((previous) => {
              return { ...previous, open: false };
            });
          }}
          onRelated={(record, view = "protocol") => {
            const taskId =
              record.taskId ??
              record.jobId ??
              (autoResearchPhase(record)
                ? (record.runId ?? record.payload?.runId)
                : "") ??
              "";
            const query = taskId ? "" : String(record.id);
            setSearch(query);
            changeFilters({ view, query, taskId });
            setTrail([null]);
            setSelection((previous) => {
              return { ...previous, open: false };
            });
          }}
        />
      )}
    </section>
  );
}

// LEARNING: SUPPORTING HELPERS
// Summary rows and on-demand record details used by Execution.
function RecordNavigation({ selection, onNavigate }) {
  return (
    <nav className="button-row" aria-label="Record history">
      <button
        type="button"
        className="quiet"
        disabled={selection.index <= 0}
        onClick={() => {
          return onNavigate(-1);
        }}
      >
        ← Previous record
      </button>
      <button
        type="button"
        className="quiet"
        disabled={selection.index >= selection.ids.length - 1}
        onClick={() => {
          return onNavigate(1);
        }}
      >
        Next record →
      </button>
    </nav>
  );
}

function ExecutionDetail({
  id,
  issueId,
  getExecutionRecord,
  savedResult,
  summaries,
  selection,
  onNavigate,
  onSelect,
  onRelated,
  onClose,
}) {
  const query = useQuery({
    queryKey: ["execution-record", issueId, id],
    queryFn: ({ signal }) => {
      return getExecutionRecord(id, signal, { includeExchange: true });
    },
    enabled: !savedResult && id != null && typeof getExecutionRecord === "function",
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (current) => {
      return current.state.data && exchangeStillCapturing(current.state.data)
        ? 2000
        : false;
    },
  });
  if (savedResult) {
    return (
      <Dialog
        title="Saved editorial result"
        onClose={onClose}
        className="record-dialog"
      >
        <RecordNavigation selection={selection} onNavigate={onNavigate} />
        <p className="hint" role="status">
          {resultExecutionHistory(savedResult).label}
        </p>
        <p className="hint">
          This is the compact result saved with the newspaper. It does not contain the
          full Execution trace.
        </p>
        <JsonInspector value={savedResult} />
      </Dialog>
    );
  }
  if (!query.data) {
    return (
      <Dialog title="Execution record" onClose={onClose} className="record-dialog">
        <RecordNavigation selection={selection} onNavigate={onNavigate} />
        <p role={query.error ? "alert" : "status"}>
          {query.error?.message ??
            (getExecutionRecord
              ? "Loading the original record…"
              : "Execution detail access is not connected.")}
        </p>
        {query.error && (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              return query.refetch();
            }}
          >
            Retry record read
          </button>
        )}
      </Dialog>
    );
  }
  // Derived presentation is separate from the original JSON shown below.
  const { executionPresentation, ...record } = query.data;
  const presentation =
    executionPresentation ??
    summaries.find((entry) => {
      return entry.id === id;
    }) ??
    record;
  const researchPhase = autoResearchPhase(record);
  const exchange = correlatedExchange(record);
  const children = researchPhase || exchange ? [] : relatedRecordIds(record, summaries);
  return (
    <RecordDialog
      record={record}
      title={exchangeTitle(record)}
      onClose={onClose}
      description={
        record.captureIncomplete
          ? "Partial captured record · inspect the capture limitation below"
          : undefined
      }
    >
      <RecordNavigation selection={selection} onNavigate={onNavigate} />
      {presentation.costRole === "aggregate" && (
        <p className="hint">
          <WorkflowTotal record={presentation} />
        </p>
      )}
      {presentation.jsonRecovery && (
        <p className="hint">
          JSON formatting repair · additional model request for the same step.
        </p>
      )}
      {presentation.localJsonRecovery && (
        <p className="hint">
          JSON recovered locally from this response. No additional model request.
        </p>
      )}
      <RecordOutcome record={presentation} />
      <RecordLinks record={presentation} onSelect={onSelect} />
      {presentation.affectedSteps?.length > 0 && (
        <details>
          <summary>Affected steps · {presentation.affectedSteps.length}</summary>
          <div className="button-row">
            {presentation.affectedSteps.map((step) => {
              return (
                <button
                  type="button"
                  className="quiet"
                  key={step.id}
                  onClick={() => {
                    return onSelect(step.id);
                  }}
                >
                  {step.label}
                </button>
              );
            })}
          </div>
        </details>
      )}
      {record.backend && <p className="hint">{editorialOutcome(record).label}</p>}
      <div className="button-row">
        {record.parentId && (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              return onSelect(record.parentId);
            }}
          >
            Open parent record
          </button>
        )}
        {children.map((child) => {
          return (
            <button
              type="button"
              className="quiet"
              key={child}
              onClick={() => {
                return onSelect(child);
              }}
            >
              Child:{" "}
              {titleOf(
                summaries.find((entry) => {
                  return entry.id === child;
                }) ?? { id: child, label: child },
              )}
            </button>
          );
        })}
        {researchPhase && (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              return onRelated(record, "teaching");
            }}
          >
            Browse research cycle
          </button>
        )}
        <button
          type="button"
          className="quiet"
          onClick={() => {
            return onRelated(record, "protocol");
          }}
        >
          {researchPhase
            ? "Inspect model and tool requests"
            : record.taskId || record.jobId
              ? "Browse run in protocol"
              : "Find related records"}
        </button>
      </div>
      <AutoResearchRecord record={record} />
      {query.error && (
        <p className="notice" role="alert">
          This record could not refresh: {query.error.message}
        </p>
      )}
    </RecordDialog>
  );
}

function WorkflowTotal({ record }) {
  const total = record.workflowRequestCount;
  return (
    <>
      {record.kind === "editorial" ? "Review" : "Run"} total · {total} model request
      {total === 1 ? "" : "s"}
      {record.workflowKnownCostUsd != null
        ? ` · ${formatCost(record.workflowKnownCostUsd)} reported across these requests`
        : ""}
      {record.workflowUnknownCostCount > 0
        ? ` · ${record.workflowUnknownCostCount} charge${record.workflowUnknownCostCount === 1 ? "" : "s"} unknown or unsettled`
        : ""}
      {record.cachedBatchCount > 0
        ? ` · ${record.cachedBatchCount} cached batch${record.cachedBatchCount === 1 ? "" : "es"}`
        : ""}
    </>
  );
}

function RecordOutcome({ record }) {
  const status = statusOf(record);
  const cancelled = ["superseded", "cancelled", "canceled"].includes(status);
  const label =
    status === "superseded" ? "Superseded" : cancelled ? "Cancelled" : status;
  return (
    <span className="request-outcome">
      {record.failureCauseId
        ? "Affected by request failure"
        : record.reportedBy === "browser"
          ? `Reported ${label}`
          : label}
      {!record.failureCauseId && (cancelled ? record.statusReason : record.error) && (
        <span> · {cancelled ? record.statusReason : record.error}</span>
      )}
    </span>
  );
}

function RecordLinks({ record, onSelect }) {
  const links = [
    [record.failureCauseId, "Inspect failure cause"],
    [record.recoveryOfRecordId, "Inspect original request"],
    [record.recoveryRecordId, "Inspect repair request"],
    [record.recoveryEventId, "Inspect formatting recovery"],
    [record.localRecoveryEventId, "Inspect local JSON recovery"],
    [record.outputLimitEventId, "Inspect output limit"],
    [record.sourceRequestRecordId, "Inspect model request"],
  ].filter(([id]) => {
    return id && id !== record.id;
  });
  if (!links.length) {
    return null;
  }
  return (
    <div className="button-row">
      {links.map(([id, label]) => {
        return (
          <button
            key={`${id}:${label}`}
            className="text-button"
            type="button"
            onClick={() => {
              return onSelect(id);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ExecutionRow({ record, records, onSelect }) {
  const status = statusOf(record);
  const researchPhase = autoResearchPhase(record);
  const final = record.finalExchange === true;
  if (record.costRole === "aggregate") {
    return (
      <li
        className="request-step workflow-overview"
        style={{ "--trace-depth": recordDepth(record, records) }}
      >
        <details open={["failed", "error"].includes(status) && !record.failureCauseId}>
          <summary>
            <strong>{titleOf(record)}</strong>
            <span className="trace-meta">
              <WorkflowTotal record={record} />
            </span>
          </summary>
          <p className="hint">
            This total summarizes the individual exchanges below; it is not an
            additional charge.
          </p>
          <RecordOutcome record={record} />
          <div className="button-row">
            <button
              className="text-button"
              type="button"
              onClick={() => {
                return onSelect(record.id);
              }}
            >
              Inspect {record.kind === "editorial" ? "review" : "run"}
            </button>
          </div>
          <RecordLinks record={record} onSelect={onSelect} />
        </details>
      </li>
    );
  }
  const showCost = record.costRole !== "metadata";
  return (
    <li
      className={`request-step ${final ? "final-exchange" : ""} ${isRunning(record) ? "active" : ""} ${["failed", "error"].includes(status) ? "failed" : ""}`}
      data-final-exchange={final ? "true" : undefined}
      style={{ "--trace-depth": recordDepth(record, records) }}
    >
      <button
        className="request-button"
        type="button"
        onClick={() => {
          return onSelect(record.id);
        }}
        disabled={record.id == null}
        style={
          final
            ? {
                border: "2px solid var(--accent)",
                borderLeftWidth: 6,
                padding: "12px",
                background: "var(--surface)",
              }
            : undefined
        }
      >
        {final && (
          <span
            className="trace-badge"
            style={{
              background: "var(--accent)",
              color: "var(--background)",
              borderColor: "var(--accent)",
              alignSelf: "flex-start",
            }}
          >
            Final request in this run
          </span>
        )}
        {!researchPhase && (
          <span className="trace-labels">
            <span className="trace-badge" data-role={actorOf(record)}>
              {actorOf(record)}
            </span>
            {record.reportedBy === "browser" && (
              <span className="trace-badge">Browser report</span>
            )}
            <span>
              {kindOf(record)}
              {record.requestKind && record.requestKind !== kindOf(record)
                ? ` · ${record.requestKind}`
                : ""}
            </span>
          </span>
        )}
        <strong>{exchangeTitle(record)}</strong>
        <span className="trace-meta">
          {record.rawCount > 1 && <span>×{record.rawCount} captured records</span>}
          {record.questionsCount != null && (
            <span>
              {record.questionsCount} judgment{record.questionsCount === 1 ? "" : "s"}
            </span>
          )}
          {record.model && <span>{record.model}</span>}
          {record.exchangeKind && (
            <span>
              Exchange {record.exchangeIndex} of {record.exchangeCount}
              {isRunning({ status: record.exchangeJobStatus }) ? " so far" : ""} · Input
              + output
            </span>
          )}
          {(record.turn != null || record.agentTurn != null) && (
            <span>
              Turn {record.turn ?? record.agentTurn}
              {!record.exchangeKind && record.maxTurns != null
                ? `/${record.maxTurns}`
                : ""}
            </span>
          )}
          {record.durationMs != null && <span>{durationLabel(record.durationMs)}</span>}
          {showCost && recordCost(record) !== null && (
            <span>{formatCost(recordCost(record))} reported</span>
          )}
          {record.exchangeKind && recordCost(record) === null && (
            <span>Charge unknown or unsettled</span>
          )}
          {showCost && record.usage && (
            <span>
              {record.usage.input_tokens ??
                record.usage.prompt_tokens ??
                record.usage.input ??
                "?"}{" "}
              in /{" "}
              {record.usage.output_tokens ??
                record.usage.completion_tokens ??
                record.usage.output ??
                "?"}{" "}
              out
            </span>
          )}
          {record.jsonRecovery && <span>Additional request · same logical step</span>}
          {record.localJsonRecovery && <span>JSON recovered locally</span>}
          {record.outputLimitReached && <span>Output limit reached</span>}
          {record.affectedStepCount > 0 && (
            <span>
              {record.affectedStepCount} affected step
              {record.affectedStepCount === 1 ? "" : "s"}
            </span>
          )}
          {record.simulated && <span>Simulated</span>}
          {record.cached && <span>Cached</span>}
          {record.warning && <span>{record.warning}</span>}
        </span>
        <RecordOutcome record={record} />
      </button>
      <RecordLinks record={record} onSelect={onSelect} />
    </li>
  );
}

function EditorialReceipts({ history, onSelect }) {
  if (!history.length) {
    return null;
  }
  return (
    <details className="editorial-receipts">
      <summary>Recorded editorial timings</summary>
      <p className="hint">
        Matching Choice sets use the same state and choice questions. Jev also returns
        Noul assessments. Times cover the whole review, which can contain multiple model
        requests. Cached results are labeled.
      </p>
      <div className="execution-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Result</th>
              <th>Time</th>
              <th>Shared Choices</th>
              <th>Full question set</th>
              <th>Receipt</th>
            </tr>
          </thead>
          <tbody>
            {receiptInputSets(history).map(
              ({ receipt, inputSet, choiceSet }, index) => {
                return (
                  <tr key={receipt.requestId ?? index}>
                    <td>
                      {receipt.model || "Not reported"}
                      <small>
                        {receipt.backend === "chat"
                          ? "General model choices"
                          : receipt.backend === "decisions"
                            ? "Native decisions"
                            : receipt.backend}
                        {receipt.cached ? " · cached" : ""}
                        {receipt.mode === "fixture" || receipt.simulated
                          ? " · simulated"
                          : ""}
                      </small>
                    </td>
                    <td>{editorialOutcome(receipt).label}</td>
                    <td>{durationLabel(receipt.durationMs)}</td>
                    <td
                      title={`Input: ${receipt.inputDigest ?? "Not reported"}\nChoice questions: ${receipt.choiceQuestionDigest ?? "Not reported"}`}
                    >
                      {choiceSet
                        ? `Choice set ${choiceSet}`
                        : "Choice digest not reported"}
                      <small>
                        {Number.isSafeInteger(receipt.choiceCount) &&
                        receipt.choiceCount >= 0
                          ? `${receipt.choiceCount} Choice`
                          : "Choice count not reported"}
                        {Number.isSafeInteger(receipt.noulCount) &&
                        receipt.noulCount >= 0
                          ? ` + ${receipt.noulCount} Noul`
                          : " · Noul count not reported"}
                      </small>
                    </td>
                    <td
                      title={`Input: ${receipt.inputDigest ?? "Not reported"}\nAll questions: ${receipt.questionDigest ?? "Not reported"}`}
                    >
                      {inputSet ? `Full set ${inputSet}` : "Full digests not reported"}
                      <small>
                        {Number.isSafeInteger(receipt.questionsCount) &&
                        receipt.questionsCount >= 0
                          ? `${receipt.questionsCount} total questions`
                          : "Question count not reported"}
                      </small>
                    </td>
                    <td>
                      {resultExecutionHistory(receipt).available === false && (
                        <small>{resultExecutionHistory(receipt).label}</small>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        disabled={!receipt.requestId}
                        onClick={() => {
                          return onSelect(receipt.requestId);
                        }}
                      >
                        {resultExecutionHistory(receipt).available === false
                          ? "Inspect saved result"
                          : "Open Execution"}
                      </button>
                    </td>
                  </tr>
                );
              },
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}
