// LEARNING: Start with Host(): choose a teaching stage and observe the server's state.
// Next: ui/src/host/ToolsStage.jsx for the briefing, then AppFrame.jsx for the embedded editor.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppFrame } from "./AppFrame.jsx";
import { ToolsStage } from "./ToolsStage.jsx";
import { PersistenceStatus } from "./PersistenceStatus.jsx";
import { Execution } from "../shared/Execution.jsx";
import { Dialog } from "../shared/Dialog.jsx";
import { RecordDialog } from "../shared/Inspector.jsx";
import { Popover, PopoverClose } from "../shared/Popover.jsx";
import {
  TOPOLOGIES,
  exportDescriptor,
  mergeSnapshots,
  normalizeSnapshot,
  safeHttpUrl,
  toolError,
} from "../shared/state.mjs";
import { compactRecords } from "../shared/execution.mjs";
import { savedExecutionResult } from "../shared/briefings.mjs";
import { contextLimitNotice } from "../shared/context-limit.mjs";
import { persistBrowserRecord } from "./browser-records.mjs";
import {
  absoluteArtifact,
  getExecutionRecord,
  getState,
  listExecution,
  postBrowserRecord,
  postTool,
  resourceUri,
  retryPersistence,
  stateFromEvent,
} from "./transport.mjs";

const KEY = ["workshop-state"];

// LEARNING: MAIN BEHAVIOR
export function Host() {
  const queryClient = useQueryClient();
  const frameController = useRef(null);
  const artifacts = useRef(new Map());
  const toolCalls = useRef(new Set());
  const [presentation, setPresentation] = useState(null);
  const [hostRecords, setHostRecords] = useState([]);
  const [connection, setConnection] = useState("Connecting");
  const [problem, setProblem] = useState("");
  const [inspection, setInspection] = useState(null);
  const [execution, setExecution] = useState(null);
  const [executionViewCount, setExecutionViewCount] = useState(null);
  const [newspaperConfirm, setNewspaperConfirm] = useState(false);
  const [dismissedContext, setDismissedContext] = useState(null);
  const [instance, setInstance] = useState(0);
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => {
      return getState(signal);
    },
    structuralSharing: mergeSnapshots,
    retry: false,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });
  const record = useCallback(
    (entry) => {
      const issueId = queryClient.getQueryData(KEY)?.issue.id;
      const clearedAt = queryClient.getQueryData(KEY)?.executionClearedAt;
      const stillCurrent = () => {
        return queryClient.getQueryData(KEY)?.executionClearedAt === clearedAt;
      };
      void persistBrowserRecord(entry, {
        send: postBrowserRecord,
        updateLocal: (update) => {
          if (stillCurrent()) {
            setHostRecords(update);
          }
        },
        onAcknowledged: (acknowledged) => {
          if (!stillCurrent()) {
            return;
          }
          queryClient.setQueryData(KEY, (previous) => {
            return previous && previous.issue.id === issueId
              ? {
                  ...previous,
                  trace: compactRecords([
                    ...previous.trace.filter((item) => {
                      return item.id !== acknowledged.id;
                    }),
                    acknowledged,
                  ]),
                }
              : previous;
          });
          // Only an already-open Execution page refetches. Server snapshots still
          // own archive totals, costs and every application state transition.
          void queryClient
            .invalidateQueries({
              queryKey: ["execution-page", issueId],
              refetchType: "active",
            })
            .catch(() => {});
        },
      }).catch(() => {});
    },
    [queryClient],
  );
  const adopt = useCallback(
    (result) => {
      const next = normalizeSnapshot(result);
      if (next) {
        queryClient.setQueryData(KEY, (previous) => {
          return mergeSnapshots(previous, next);
        });
      }
    },
    [queryClient],
  );
  const adoptPersistenceFailure = useCallback(
    (error) => {
      if (error.persistence) {
        queryClient.setQueryData(KEY, (previous) => {
          return previous
            ? {
                ...previous,
                persistence: error.persistence,
              }
            : previous;
        });
        // The mutation may have reached the server before its durable save
        // failed. Read that state without replaying the mutation.
        void queryClient.invalidateQueries({ queryKey: KEY });
      }
    },
    [queryClient],
  );
  const callTool = useCallback(
    async (name, args = {}, signal) => {
      // LEARNING: The host forwards MCP calls and adopts their replies; domain changes belong to the server.
      let result;
      const pending = postTool(name, args, signal);
      toolCalls.current.add(pending);
      try {
        result = await pending;
      } catch (error) {
        adoptPersistenceFailure(error);
        throw error;
      } finally {
        toolCalls.current.delete(pending);
      }
      if (name === "export_newspaper" && !result.isError) {
        const converted = absoluteArtifact(result, window.location.origin);
        result = converted.result;
        if (converted.artifact) {
          artifacts.current.set(converted.artifact.url, {
            ...converted.artifact,
            executionRecordId: result._meta?.executionRecordId,
          });
        }
      }
      adopt(result);
      return result;
    },
    [adopt, adoptPersistenceFailure],
  );
  const clearExecution = useCallback(async () => {
    const result = await callTool("clear_execution");
    const error = toolError(result);
    if (error) {
      throw error;
    }
    setHostRecords([]);
    return result;
  }, [callTool]);
  useEffect(() => {
    if (!query.data?.executionClearedAt) {
      return;
    }
    setHostRecords([]);
    queryClient.removeQueries({ queryKey: ["execution-record", query.data.issue.id] });
    void queryClient.invalidateQueries({
      queryKey: ["execution-page", query.data.issue.id],
    });
  }, [query.data?.executionClearedAt, queryClient]);
  const openLink = useCallback(
    async (raw) => {
      const url = safeHttpUrl(raw, window.location.origin);
      if (!url) {
        return { isError: true };
      }
      const artifact = artifacts.current.get(url.href);
      const link = document.createElement("a");
      link.href = url.href;
      link.rel = "noopener noreferrer";
      if (artifact) {
        link.download = artifact.filename || "newspaper";
      } else {
        link.target = "_blank";
      }
      document.body.appendChild(link);
      link.click();
      link.remove();
      record({
        id: crypto.randomUUID(),
        kind: artifact ? "export.download" : "app.open-link",
        actor: "host",
        status: "complete",
        startedAt: new Date().toISOString(),
        ...(artifact?.executionRecordId
          ? { parentId: artifact.executionRecordId }
          : {}),
        payload: { url: url.href },
        result: artifact
          ? { downloadRequested: true, artifact }
          : { navigationRequested: true },
      });
      return {};
    },
    [record],
  );

  useEffect(() => {
    const events = new EventSource("/api/events");
    // LEARNING: This channel observes work. A missing revision triggers a read, not another action.
    events.onopen = () => {
      setConnection("Live");
      void queryClient.invalidateQueries({ queryKey: KEY });
    };
    events.onerror = () => {
      return setConnection("Reconnecting");
    };
    function receive(event) {
      try {
        const data = JSON.parse(event.data);
        let gap = false;
        queryClient.setQueryData(KEY, (previous) => {
          const next = stateFromEvent(previous, data, event.type);
          gap = next.gap;
          return next.state;
        });
        if (gap) {
          void queryClient.invalidateQueries({ queryKey: KEY });
        }
      } catch {
        void queryClient.invalidateQueries({ queryKey: KEY });
      }
    }
    for (const kind of [
      "snapshot",
      "state",
      "patch",
      "trace",
      "jobs",
      "change",
      "message",
      "reset",
    ]) {
      events.addEventListener(kind, receive);
    }
    return () => {
      return events.close();
    };
  }, [queryClient]);

  useEffect(() => {
    const reload = (event) => {
      event.preventDefault();
      Promise.resolve()
        .then(() => {
          return frameController.current?.prepare();
        })
        .then(() => {
          return window.location.reload();
        })
        .catch((error) => {
          return setProblem(
            `Save your current edits before reloading the updated UI: ${error.message}`,
          );
        });
    };
    window.addEventListener("workshop:ui-update", reload);
    return () => {
      return window.removeEventListener("workshop:ui-update", reload);
    };
  }, []);

  const stage = query.data?.settings.stage;
  useEffect(() => {
    if (!stage) {
      return;
    }
    // Session 3 opens on the fact-check view; an edition saved in another stage moves there.
    if (stage !== "research") {
      setPresentation(null);
      callTool("set_stage", { stage: "research" }).catch((error) => {
        setProblem(error.message);
      });
      return;
    }
    if (presentation) {
      return;
    }
    const abort = new AbortController();
    // Opening an existing issue is a free MCP state read, not a writer request.
    callTool("get_editor_state", {}, abort.signal)
      .then((result) => {
        const error = toolError(result);
        if (error) {
          throw error;
        }
        setPresentation({
          id: crypto.randomUUID(),
          name: "get_editor_state",
          arguments: {},
          result,
        });
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setProblem(error.message);
        }
      });
    return () => {
      return abort.abort();
    };
  }, [stage, Boolean(presentation), callTool]);

  // LEARNING: Changing stages awaits App teardown so pending editor writes can finish.
  const action = useMutation({
    scope: { id: "host-settings" },
    retry: false,
    mutationFn: async ({ name, args }) => {
      if (name === "set_stage" && frameController.current) {
        await frameController.current.prepare();
      }
      const result = await callTool(name, args);
      const error = toolError(result);
      if (error) {
        throw error;
      }
      return result;
    },
    onSuccess: () => {
      return setProblem("");
    },
    onError: (error) => {
      return setProblem(error.message);
    },
  });
  const newspaperReset = useMutation({
    scope: { id: "host-settings" },
    retry: false,
    mutationFn: async () => {
      // Finish already-dispatched app calls before the server clears their work.
      while (toolCalls.current.size) {
        await Promise.allSettled([...toolCalls.current]);
      }
      const result = await callTool("new_newspaper");
      const error = toolError(result);
      if (error) {
        throw error;
      }
      const state = normalizeSnapshot(result);
      if (!state || state.issue.stories.length) {
        throw new Error("The reset did not return a cleared newspaper snapshot.");
      }
      return result;
    },
    onSuccess: () => {
      setProblem("");
      setNewspaperConfirm(false);
      setInspection(null);
      setExecution(null);
    },
    onError: (error) => {
      return setProblem(error.message);
    },
  });
  const saveRetry = useMutation({
    retry: false,
    mutationFn: () => {
      return retryPersistence();
    },
    onSuccess: (state) => {
      adopt(state);
      setProblem("");
    },
    onError: adoptPersistenceFailure,
  });
  const recoveryExport = useMutation({
    retry: false,
    mutationFn: async () => {
      const result = await callTool("export_newspaper", { format: "html" });
      const error = toolError(result);
      if (error) {
        throw error;
      }
      const artifact = exportDescriptor(result);
      if (!artifact) {
        throw new Error("The export returned no downloadable artifact.");
      }
      await openLink(artifact.url);
    },
  });
  const snapshot = useMemo(() => {
    return query.data
      ? {
          ...query.data,
          hostRecords,
        }
      : null;
  }, [query.data, hostRecords]);
  const inspect = useCallback((value, title) => {
    return setInspection({ value, title });
  }, []);
  const showExecution = useCallback(
    (recordId = null, taskId = "") => {
      const retained = savedExecutionResult(
        queryClient.getQueryData(KEY),
        recordId ?? taskId,
      );
      if (retained) {
        setInspection({ value: retained, title: "Saved result from an earlier visit" });
        return;
      }
      setExecutionViewCount(null);
      setExecution({ recordId, taskId });
    },
    [queryClient],
  );

  if (!snapshot) {
    return (
      <main className="host-loading">
        <span className="identity-mark">03</span>
        <p className="eyebrow">AGENTIC AI WORKSHOP</p>
        <h1>Multi-agent topologies</h1>
        <p role={query.error ? "alert" : "status"}>
          {query.error?.message || "Connecting to the workshop…"}
        </p>
        {query.error && (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              return query.refetch();
            }}
          >
            Reconnect
          </button>
        )}
      </main>
    );
  }
  const error =
    (problem !== snapshot.persistence?.error?.message ? problem : "") ||
    query.error?.message;
  const generalModel =
    snapshot.inferenceSelection?.model ||
    (!["development", "hosted"].includes(snapshot.settings.mode)
      ? snapshot.settings.model
      : null);
  const executionCount = execution
    ? executionViewCount
    : snapshot.execution?.teachingRecords;
  const contextFailure = contextLimitNotice(snapshot);
  return (
    <main
      className={`workshop-host ${snapshot.settings.stage === "tools" ? "tools-host" : "editor-host"}`}
    >
      <a className="skip-link" href="#host-workspace">
        Skip to workshop
      </a>
      <header className="host-toolbar" aria-label="Workshop controls">
        <h1>Multi-agent topologies</h1>
        <label>
          <span>Arrangement</span>
          <select
            aria-label="Fact-check arrangement"
            value={snapshot.settings.topology ?? "single"}
            title={
              TOPOLOGIES.find((item) => {
                return item.id === (snapshot.settings.topology ?? "single");
              })?.description
            }
            disabled={action.isPending}
            onChange={(event) => {
              return action.mutate({
                name: "set_topology",
                args: { topology: event.target.value },
              });
            }}
          >
            {TOPOLOGIES.map((item) => {
              return (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              );
            })}
          </select>
        </label>
        <span
          className="host-account"
          title={`Selected general model: ${generalModel || "Not reported"}`}
        >
          General · {generalModel || "Resolving model…"}
        </span>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            return showExecution();
          }}
        >
          Execution
          {executionCount != null && (
            <span className="count-badge">{executionCount}</span>
          )}
        </button>
        <Popover
          label="Usage and limits"
          className="host-settings-menu"
          trigger={
            <button
              type="button"
              className="text-button session-details-button"
              aria-label="Usage, funding and limits"
            >
              {snapshot.inferenceSelection?.fundingMode === "class"
                ? "Class"
                : snapshot.inferenceSelection?.fundingMode === "personal"
                  ? "Personal"
                  : "Usage"}
              {Number.isFinite(snapshot.execution?.budget?.knownCostUsd)
                ? ` · $${snapshot.execution.budget.knownCostUsd.toFixed(4)}`
                : " details"}
            </button>
          }
        >
          <p>General model: {generalModel || "Workshop selection not reported"}</p>
          <p>
            {connection} · revision {snapshot.issue.revision}
            <br />
            Maximum 10 turns per agent run
          </p>
          <PersistenceStatus persistence={snapshot.persistence} inline />
          <InferenceStatus state={snapshot} onRecovered={adopt} details />
        </Popover>
        {connection !== "Live" && (
          <span className="host-connection" role="status">
            {connection}
          </span>
        )}
        {snapshot.settings.mode === "fixture" && (
          <span
            className="fixture-note"
            title="Fixture session · synthetic evidence and responses"
          >
            Simulated
          </span>
        )}
        <button
          type="button"
          className="text-button"
          onClick={() => {
            return inspect(snapshot, "App State");
          }}
        >
          Inspect App State ↗
        </button>
        {snapshot.settings.stage === "tools" && (
          <Popover
            label="Newspaper menu"
            className="host-settings-menu"
            trigger={
              <button
                type="button"
                className="quiet icon-button"
                aria-label="Newspaper menu"
                title="Newspaper menu"
              >
                •••
              </button>
            }
          >
            <div className="popover-actions">
              <PopoverClose asChild>
                <button
                  type="button"
                  className="text-button"
                  disabled={action.isPending || connection !== "Live"}
                  onClick={() => {
                    newspaperReset.reset();
                    setNewspaperConfirm(true);
                  }}
                >
                  Start new newspaper
                </button>
              </PopoverClose>
            </div>
          </Popover>
        )}
      </header>
      {contextFailure && contextFailure.id !== dismissedContext && (
        <section className="context-limit-notice" role="alert">
          <div>
            <h2>{contextFailure.title}</h2>
            <p>{contextFailure.message}</p>
          </div>
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                return showExecution(contextFailure.recordId, contextFailure.taskId);
              }}
            >
              Inspect request
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                return setDismissedContext(contextFailure.id);
              }}
            >
              Dismiss
            </button>
          </div>
        </section>
      )}
      <InferenceStatus state={snapshot} onRecovered={adopt} />
      <PersistenceStatus
        persistence={snapshot.persistence}
        retrying={saveRetry.isPending}
        exporting={recoveryExport.isPending}
        actionError={saveRetry.error?.message || recoveryExport.error?.message}
        onRetry={() => {
          recoveryExport.reset();
          saveRetry.mutate();
        }}
        onExport={() => {
          saveRetry.reset();
          recoveryExport.mutate();
        }}
      />
      {error && (
        <div className="notice host-notice" role="alert">
          <span>{error}</span>
          <div className="button-row">
            <button
              type="button"
              className="quiet"
              onClick={async () => {
                try {
                  if (frameController.current) {
                    await frameController.current.prepare();
                  }
                  setProblem("");
                  setInstance((value) => {
                    return value + 1;
                  });
                  void query.refetch();
                } catch (failure) {
                  setProblem(failure.message);
                }
              }}
            >
              Reconnect view
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                return setProblem("");
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div
        id="host-workspace"
        className={`host-workspace stage-${snapshot.settings.stage}`}
        tabIndex={-1}
      >
        {snapshot.settings.stage === "tools" ? (
          <>
            <div>
              <ToolsStage
                key={`${snapshot.issue.id}:${snapshot.documentVersion ?? 0}`}
                state={snapshot}
                callTool={callTool}
                onInspect={inspect}
                onExecution={showExecution}
                onOpenLink={openLink}
              />
              {snapshot.approvals.map((proposal) => {
                return (
                  <div className="approval-strip" key={proposal.id}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        return inspect(proposal, "Proposed saved change");
                      }}
                    >
                      {proposal.kind} · review exact change ↗
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        return action.mutate({
                          name: "approve_change",
                          args: { approvalId: proposal.id, accepted: true },
                        });
                      }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        return action.mutate({
                          name: "approve_change",
                          args: { approvalId: proposal.id, accepted: false },
                        });
                      }}
                    >
                      Decline
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : presentation ? (
          <AppFrame
            key={`${resourceUri(presentation.result)}:${instance}`}
            uri={resourceUri(presentation.result)}
            initialTool={presentation}
            snapshot={snapshot}
            callTool={callTool}
            openLink={openLink}
            onExecution={showExecution}
            onRecord={record}
            onError={setProblem}
            controllerRef={frameController}
          />
        ) : (
          <div className="host-view-opening" role="status">
            Opening your existing issue…
          </div>
        )}
      </div>
      {newspaperConfirm && (
        <Dialog
          title="Start new newspaper?"
          onClose={() => {
            if (!newspaperReset.isPending) {
              setNewspaperConfirm(false);
            }
          }}
        >
          <p>
            This clears your briefings, sources, newspaper and execution history, and
            stops pending work. Your connection, reader preferences and spending totals
            stay as they are.
          </p>
          {newspaperReset.error && (
            <p className="notice" role="alert">
              {newspaperReset.error.message}
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="quiet"
              disabled={newspaperReset.isPending}
              onClick={() => {
                return setNewspaperConfirm(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={newspaperReset.isPending || connection !== "Live"}
              onClick={() => {
                return newspaperReset.mutate();
              }}
            >
              {newspaperReset.isPending
                ? "Starting new newspaper…"
                : "Start new newspaper"}
            </button>
          </div>
        </Dialog>
      )}
      {execution && (
        <Dialog
          title="Execution"
          onClose={() => {
            return setExecution(null);
          }}
          className="execution-dialog"
        >
          <Execution
            key={snapshot.issue.id}
            issueId={snapshot.issue.id}
            trace={snapshot.trace}
            jobs={snapshot.jobs}
            onViewCount={setExecutionViewCount}
            clearExecution={clearExecution}
            hostRecords={snapshot.hostRecords}
            summary={snapshot.execution}
            gateway={snapshot.gateway ?? snapshot.inference ?? snapshot.budget}
            autoResearchRuns={snapshot.autoResearchRuns}
            stories={snapshot.issue.stories}
            demoMode={snapshot.settings?.demoMode === true}
            listExecution={listExecution}
            getExecutionRecord={getExecutionRecord}
            initialRecordId={execution.recordId}
            initialTaskId={execution.taskId}
          />
        </Dialog>
      )}
      {inspection && (
        <RecordDialog
          record={inspection.value}
          title={inspection.title}
          onClose={() => {
            return setInspection(null);
          }}
        />
      )}
    </main>
  );
}

// LEARNING: SUPPORTING HELPERS
// Display the server's reported usage and recovery status.
function InferenceStatus({ state, onRecovered, details = false }) {
  const [now, setNow] = useState(Date.now());
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const budget = state.execution?.budget;
  const activity = state.inferenceActivity;
  const retry = activity?.retrying?.[0];
  useEffect(() => {
    if (!retry) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => {
      return setNow(Date.now());
    }, 1000);
    return () => {
      return clearInterval(timer);
    };
  }, [retry?.retryAt]);
  if (!budget) {
    return null;
  }
  if (!details && !activity?.blocked && !retry && !activity?.queued) {
    return null;
  }
  const usd = (value) => {
    return Number.isFinite(value) ? `$${value.toFixed(4)}` : "unknown";
  };
  return (
    <div
      className="notice host-notice inference-status"
      aria-label="AI usage and availability"
    >
      <div>
        {details && (
          <span>
            AI usage {usd(budget.knownCostUsd)} · pending {usd(budget.reservedUsd)} ·
            app ceiling ${budget.maxInferenceCostUsd?.toFixed(2)}
            {state.inferenceSelection?.run?.budgetUsd
              ? ` · portal ceiling $${state.inferenceSelection.run.budgetUsd}`
              : ""}
          </span>
        )}
        {activity?.blocked ? (
          <p role="status">{activity.blocked.message}</p>
        ) : retry ? (
          <p role="status">
            Waiting for AI capacity. Retrying in{" "}
            {Math.max(0, Math.ceil((Date.parse(retry.retryAt) - now) / 1000))}s. The
            rejected attempt was not charged. Editing remains available.
          </p>
        ) : activity?.queued > 0 ? (
          <p role="status">
            {activity.queued} AI request{activity.queued === 1 ? "" : "s"} queued;{" "}
            {activity.active} running. Editing remains available.
          </p>
        ) : null}
        {error && <p role="alert">{error}</p>}
      </div>
      {budget.unsettledOperations?.length > 0 && (
        <button
          type="button"
          className="quiet"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            setError("");
            try {
              const response = await fetch("/api/inference/recover", {
                method: "POST",
              });
              const result = await response.json();
              if (!response.ok) {
                throw new Error(result.error || "Accounting status is unavailable.");
              }
              onRecovered(result);
            } catch (failure) {
              setError(failure.message);
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? "Checking…" : "Check pending charges"}
        </button>
      )}
    </div>
  );
}
