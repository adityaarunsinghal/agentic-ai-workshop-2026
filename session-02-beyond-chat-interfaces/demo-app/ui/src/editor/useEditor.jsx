// LEARNING: Start with useEditor(): MCP actions reconcile local edits with authoritative snapshots.
// Next: ui/src/editor/Editor.jsx to see how this controller drives the visible newspaper.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyIntent,
  mergeSnapshots,
  normalizeSnapshot,
  sameStory,
  storyKey,
  structuredResult,
  supersedeFailedIntents,
  toolError,
} from "../shared/state.mjs";
import {
  boundFrame,
  retainFramePrecision,
  sameFrame,
  sameFrameSize,
} from "../shared/geometry.mjs";
import {
  executionPage,
  executionParams,
  executionRecord,
} from "../shared/execution.mjs";
import {
  persistenceAcknowledgesFailure,
  supersedePersistenceFailures,
} from "../shared/persistence.mjs";
import { OpenExecutionNotification } from "../shared/host-actions.mjs";
import {
  RpcLifecycleTransport,
  transportFailure,
  transportLogParts,
} from "../shared/rpc-transport.mjs";

const STATE_KEY = ["editor-state"];
const activeJob = (job) => {
  return ["pending", "queued", "researching", "reading", "writing", "running"].includes(
    job.status,
  );
};
// The shared intent matcher compares canonical IDs as well as slot IDs.
// These stay inside the UI; RPC arguments below contain only slotId.
const targetOf = (story) => {
  return { id: storyKey(story), slotId: storyKey(story) };
};
const equals = (a, b) => {
  return JSON.stringify(a) === JSON.stringify(b);
};

// LEARNING: MAIN BEHAVIOR
export function useEditor() {
  const queryClient = useQueryClient();
  const appRef = useRef(null);
  const entriesRef = useRef([]);
  const draftsRef = useRef({});
  const flushRef = useRef(async () => {
    return true;
  });
  const promises = useRef(new Set());
  const timers = useRef(new Map());
  const serial = useRef(0);
  const resetPending = useRef(false);
  const resetTask = useRef(null);
  const paperEpoch = useRef(0);
  const replacingState = useRef(false);
  const retiredJobs = useRef(new Set());
  const persistenceFailures = useRef(new Map());
  const renderedReports = useRef(new Map());
  const [entries, setEntries] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [resetting, setResetting] = useState(false);
  const [paperGeneration, setPaperGeneration] = useState(0);
  const [problem, setProblem] = useState(null);
  const [transportProblem, setTransportProblem] = useState(null);
  const [connection, setConnection] = useState({
    app: null,
    isConnected: false,
    error: null,
  });
  const [hostContext, setHostContext] = useState(null);

  const updateEntries = useCallback((update) => {
    entriesRef.current = update(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);
  const updateDrafts = useCallback((update) => {
    draftsRef.current = update(draftsRef.current);
    setDrafts(draftsRef.current);
  }, []);
  const adopt = useCallback(
    (result) => {
      const next = normalizeSnapshot(result);
      if (next) {
        queryClient.setQueryData(STATE_KEY, next);
      }
      return next;
    },
    [queryClient],
  );
  const shareState = useCallback((previous, next) => {
    const before = previous?.documentVersion ?? 0;
    const after = next?.documentVersion ?? before;
    if (after < before) {
      return previous;
    }
    if (after > before) {
      for (const job of previous?.jobs ?? []) {
        retiredJobs.current.add(job.id);
      }
    }
    const shared =
      replacingState.current || after > before ? next : mergeSnapshots(previous, next);
    // A host notification may still contain merged summaries from the old
    // paper. Keep that history in Execution, not in the new paper's active jobs.
    return shared && retiredJobs.current.size
      ? {
          ...shared,
          jobs: shared.jobs.filter((job) => {
            return !retiredJobs.current.has(job.id);
          }),
        }
      : shared;
  }, []);

  // LEARNING: The embedded App receives host results through the SDK bridge, with teardown preserving edits.
  useEffect(() => {
    let disposed = false;
    const app = new App(
      { name: "Interactive Editor View", version: "2.0.0" },
      {},
      { autoResize: false },
    );
    appRef.current = app;
    const report = (diagnostic) => {
      // This uses the existing host logging/archive channel, never the editor
      // mutation queue. Failed logging must not recursively report itself.
      void (async () => {
        for (const part of transportLogParts(diagnostic)) {
          await app.sendLog(part);
        }
      })().catch(() => {
        if (!disposed) {
          setTransportProblem(
            "Editor connection details could not reach Execution. Keep unsaved text and reconnect the view.",
          );
        }
      });
    };
    app.ontoolresult = (result) => {
      adopt(result);
    };
    app.ontoolcancelled = ({ reason }) => {
      return setProblem(reason || "The host cancelled the request.");
    };
    app.onhostcontextchanged = (context) => {
      return setHostContext((previous) => {
        return { ...previous, ...context };
      });
    };
    app.onerror = (error) => {
      if (disposed) {
        return;
      }
      const diagnostic = transportFailure(error);
      report(diagnostic);
      setTransportProblem(diagnostic.message);
    };
    app.onclose = () => {
      if (disposed) {
        return;
      }
      setConnection({ app: null, isConnected: false, error: null });
      setTransportProblem(
        "The editor connection closed. Copy any unsaved text, then reload the page.",
      );
    };
    app.onteardown = async () => {
      if (!(await flushRef.current())) {
        throw new Error(
          "Save or resolve the retained local changes before leaving Interactive Editor View.",
        );
      }
      return {};
    };
    // useApp constructs its own transport. Create the same App explicitly so
    // cancellation tracking runs before the SDK sees a late response.
    const transport = new RpcLifecycleTransport(
      new PostMessageTransport(window.parent, window.parent),
      {
        onDiagnostic: report,
      },
    );
    void app
      .connect(transport)
      .then(() => {
        if (!disposed) {
          setConnection({ app, isConnected: true, error: null });
        }
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        app.onerror(error);
        setConnection({ app: null, isConnected: false, error: null });
      });
    return () => {
      disposed = true;
      if (appRef.current === app) {
        appRef.current = null;
      }
      void app.close();
    };
  }, [adopt]);
  const query = useQuery({
    queryKey: STATE_KEY,
    enabled: connection.isConnected && !resetting,
    queryFn: async ({ signal }) => {
      const epoch = paperEpoch.current;
      const result = await appRef.current.callServerTool(
        { name: "get_editor_state", arguments: {} },
        { signal },
      );
      signal.throwIfAborted();
      if (epoch !== paperEpoch.current) {
        throw new Error("The newspaper changed during this state read.");
      }
      const error = toolError(result);
      if (error) {
        throw error;
      }
      const snapshot = normalizeSnapshot(result);
      if (!snapshot) {
        throw new Error("get_editor_state did not return an issue snapshot.");
      }
      setTransportProblem(null);
      return snapshot;
    },
    structuralSharing: shareState,
    staleTime: 1500,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (current) => {
      return current.state.data?.jobs.some(activeJob) ||
        current.state.data?.autoResearchRuns?.some((run) => {
          return ["queued", "running"].includes(run.status);
        }) ||
        current.state.data?.editorial?.status === "running"
        ? 3000
        : 15000;
    },
  });
  const readState = useCallback(async () => {
    const result = await appRef.current.callServerTool({
      name: "get_editor_state",
      arguments: {},
    });
    const error = toolError(result);
    if (error) {
      throw error;
    }
    return adopt(result);
  }, [adopt]);

  // The embedded App has no HTTP access to the host. Archive reads use the
  // app-only MCP tools and never enter the serialized editor mutation queue.
  const listExecution = useCallback(
    async (options = {}, signal) => {
      if (!appRef.current || !connection.isConnected) {
        throw new Error("Wait for the Interactive Editor View to reconnect.");
      }
      const result = await appRef.current.callServerTool(
        {
          name: "list_execution",
          arguments: executionParams(options),
        },
        { signal },
      );
      const error = toolError(result);
      if (error) {
        throw error;
      }
      return executionPage(structuredResult(result));
    },
    [connection.isConnected],
  );
  const getExecutionRecord = useCallback(
    async (id, signal, options = {}) => {
      if (!appRef.current || !connection.isConnected) {
        throw new Error("Wait for the Interactive Editor View to reconnect.");
      }
      const result = await appRef.current.callServerTool(
        {
          name: "get_execution_record",
          arguments: {
            id,
            ...(options.includeExchange === true ? { includeExchange: true } : {}),
          },
        },
        { signal },
      );
      const error = toolError(result);
      if (error) {
        throw error;
      }
      return executionRecord(structuredResult(result));
    },
    [connection.isConnected],
  );
  const clearExecution = useCallback(async () => {
    if (!appRef.current || !connection.isConnected) {
      throw new Error("Wait for the Interactive Editor View to reconnect.");
    }
    const result = await appRef.current.callServerTool({
      name: "clear_execution",
      arguments: {},
    });
    const error = toolError(result);
    if (error) {
      throw error;
    }
    adopt(result);
    return result;
  }, [connection.isConnected, adopt]);

  const supersedeStorageFailures = useCallback(
    (intent, epoch) => {
      const issueId = queryClient.getQueryData(STATE_KEY)?.issue.id;
      const retained = supersedePersistenceFailures(
        [...persistenceFailures.current.values()],
        intent,
        { issueId, epoch },
      );
      persistenceFailures.current = new Map(
        retained.map((failure) => {
          return [failure.id, failure];
        }),
      );
    },
    [queryClient],
  );

  useEffect(() => {
    const current = query.data;
    const persistence = current?.persistence;
    if (
      persistence?.phase !== "saved" ||
      persistence.error ||
      !persistenceFailures.current.size
    ) {
      return;
    }
    const recovered = [];
    for (const [id, failure] of persistenceFailures.current) {
      if (
        failure.epoch !== paperEpoch.current ||
        failure.issueId !== current.issue.id
      ) {
        persistenceFailures.current.delete(id);
        continue;
      }
      // A memory mutation or an old saved snapshot is not an acknowledgement.
      // An equal version is valid when only its journal acknowledgement failed.
      if (
        persistenceAcknowledgesFailure(persistence, failure) &&
        (!failure.intent || satisfied(current, failure.intent))
      ) {
        recovered.push(failure);
        persistenceFailures.current.delete(id);
      }
    }
    if (!recovered.length) {
      return;
    }
    const ids = new Set(
      recovered.map((failure) => {
        return failure.id;
      }),
    );
    updateEntries((previous) => {
      return previous.filter((entry) => {
        return !ids.has(entry.id);
      });
    });
    setProblem((previous) => {
      return recovered.some((failure) => {
        return failure.message === previous;
      }) &&
        ![...persistenceFailures.current.values()].some((failure) => {
          return failure.message === previous;
        })
        ? null
        : previous;
    });
  }, [query.data, updateEntries]);

  // LEARNING: A mutation owns its pending intent. An acknowledgement removes only that intent.
  const mutation = useMutation({
    mutationKey: ["editor-action"],
    scope: { id: "editor-writes" },
    retry: false,
    mutationFn: async (entry) => {
      if (entry.epoch !== paperEpoch.current) {
        return null;
      }
      if (!connection.isConnected || !appRef.current) {
        throw new Error("Wait for the Interactive Editor View to reconnect.");
      }
      const argumentsValue = { ...entry.arguments };
      if (entry.target && entry.name !== "create_story") {
        const authoritative = queryClient.getQueryData(STATE_KEY);
        const story = authoritative?.issue.stories.find((item) => {
          return sameStory(item, entry.target);
        });
        if (!story && entry.name === "report_story_fit") {
          return null;
        }
        if (!story) {
          throw new Error(
            "This block has not been saved. Retry its creation before other changes.",
          );
        }
        argumentsValue.slotId = entry.target.slotId;
        if (entry.name === "move_story") {
          // Earlier queued moves may already have reached this exact placement.
          // Locked stories still go to the server's ordinary authority check.
          argumentsValue.frame = retainFramePrecision(
            story.frame,
            argumentsValue.frame,
          );
          if (!story.locked && sameFrame(story.frame, argumentsValue.frame)) {
            return true;
          }
        }
        if (entry.name === "request_auto_research") {
          if (authoritative.settings.stage !== "research") {
            throw new Error("Auto research is available in Stage 4.");
          }
          if (story.locked) {
            throw new Error("Unlock this story before starting auto research.");
          }
          if (!story.body?.trim()) {
            throw new Error(
              "Add body copy to this story before starting auto research.",
            );
          }
          if (
            authoritative.jobs.some((job) => {
              return (
                job.type !== "auto_research" &&
                job.slotId === story.slotId &&
                activeJob(job)
              );
            })
          ) {
            throw new Error(
              "Wait for the current story request to finish before starting auto research.",
            );
          }
        }
        if (["request_story", "request_auto_research"].includes(entry.name)) {
          argumentsValue.contentVersion = story.contentVersion;
        }
      }
      const result = await appRef.current.callServerTool({
        name: entry.name,
        arguments: argumentsValue,
      });
      const snapshot = adopt(result);
      const error = toolError(result);
      if (error) {
        throw error;
      }
      if (!snapshot && !["export_newspaper", "revise_copy_demo"].includes(entry.name)) {
        await readState();
      }
      return result;
    },
    onSuccess: (_result, entry) => {
      supersedeStorageFailures(entry.intent, entry.epoch);
      updateEntries((previous) => {
        return supersedeFailedIntents(previous, entry.intent).filter((item) => {
          return item.id !== entry.id;
        });
      });
      setProblem(null);
    },
    onError: async (error, entry) => {
      // A move can commit before its semantic assessment fails. Recover with a
      // free read, and never replay the paid action automatically.
      try {
        await readState();
      } catch {
        /* Preserve the current usable issue. */
      }
      const current = queryClient.getQueryData(STATE_KEY);
      const storageError = current?.persistence?.error;
      if (
        storageError?.code?.startsWith("STORAGE_") &&
        storageError.message &&
        error.message.endsWith(storageError.message)
      ) {
        supersedeStorageFailures(entry.intent, entry.epoch);
        persistenceFailures.current.set(entry.id, {
          id: entry.id,
          epoch: entry.epoch,
          issueId: current.issue.id,
          revision: current.issue.revision,
          version: current.persistence.version,
          intent: entry.intent,
          message: error.message,
        });
      }
      const applied = satisfied(current, entry.intent) || !entry.intent;
      updateEntries((previous) => {
        return coverFailedChanges(
          applied
            ? previous.filter((item) => {
                return item.id !== entry.id;
              })
            : previous.map((item) => {
                return item.id === entry.id
                  ? {
                      ...item,
                      status: "failed",
                      error: error.message,
                    }
                  : item;
              }),
        );
      });
      setProblem(error.message);
    },
  });

  // LEARNING: Actions below share this dispatch path; draft text and optimistic state stay separate.
  const run = useCallback(
    (name, argumentsValue = {}, intent = null, options = {}) => {
      if (resetPending.current) {
        return Promise.resolve(null);
      }
      const entry = {
        id: crypto.randomUUID(),
        order: ++serial.current,
        name,
        arguments: argumentsValue,
        intent,
        status: "saving",
        ...options,
        epoch: paperEpoch.current,
      };
      supersedeStorageFailures(intent, entry.epoch);
      updateEntries((previous) => {
        return [...supersedeFailedIntents(previous, intent), entry];
      });
      const promise = mutation.mutateAsync(entry).catch(() => {
        return null;
      });
      promises.current.add(promise);
      void promise.finally(() => {
        return promises.current.delete(promise);
      });
      return promise;
    },
    [mutation.mutateAsync, updateEntries, supersedeStorageFailures],
  );

  const flushDraft = useCallback(
    (key) => {
      if (resetPending.current) {
        return Promise.resolve(false);
      }
      const draft = draftsRef.current[key];
      clearTimeout(timers.current.get(key));
      timers.current.delete(key);
      if (!draft) {
        return Promise.resolve(true);
      }
      if (draft.patch.body?.length > 6000) {
        setProblem(
          "Shorten the body to 6,000 characters before saving. Your full local copy is retained.",
        );
        return Promise.resolve(false);
      }
      const promise = run(
        "edit_story",
        { slotId: draft.target.slotId, patch: draft.patch },
        { kind: "patch", target: draft.target, patch: draft.patch },
        { target: draft.target },
      );
      updateDrafts((previous) => {
        if (previous[key]?.version !== draft.version) {
          return previous;
        }
        const next = { ...previous };
        delete next[key];
        return next;
      });
      return promise;
    },
    [run, updateDrafts],
  );

  const draftStory = useCallback(
    (story, patch) => {
      if (resetPending.current) {
        return;
      }
      const key = storyKey(story);
      updateDrafts((previous) => {
        return {
          ...previous,
          [key]: {
            target: targetOf(story),
            patch: { ...previous[key]?.patch, ...patch },
            version: ++serial.current,
          },
        };
      });
      clearTimeout(timers.current.get(key));
      timers.current.set(
        key,
        setTimeout(() => {
          void flushDraft(key);
        }, 1200),
      );
    },
    [flushDraft, updateDrafts],
  );
  const flushAll = useCallback(async () => {
    do {
      if (resetPending.current) {
        return false;
      }
      const draftsToSave = Object.keys(draftsRef.current).map(flushDraft);
      const results = await Promise.all([...promises.current, ...draftsToSave]);
      if (
        resetPending.current ||
        !results.every(Boolean) ||
        entriesRef.current.some((entry) => {
          return entry.status === "failed";
        })
      ) {
        return false;
      }
      // Include edits made while an earlier save was awaiting its acknowledgment.
    } while (Object.keys(draftsRef.current).length || promises.current.size);
    return true;
  }, [flushDraft]);
  flushRef.current = flushAll;

  useEffect(() => {
    return () => {
      for (const timer of timers.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  const state = useMemo(() => {
    let projected = query.data;
    if (!projected) {
      return null;
    }
    for (const entry of entries) {
      if (entry.epoch === paperGeneration) {
        projected = projectEdit(projected, entry.intent);
      }
    }
    for (const draft of Object.values(drafts)) {
      projected = projectEdit(projected, {
        kind: "patch",
        target: draft.target,
        patch: draft.patch,
      });
    }
    return projected;
  }, [query.data, entries, drafts, paperGeneration]);

  // LEARNING: NEWSPAPER ACTIONS
  // Follow createSlot, requestStory and moveStory from the visible controls to their MCP tool names.
  const createSlot = useCallback(
    (frame) => {
      if (resetPending.current) {
        return null;
      }
      const id = crypto.randomUUID();
      const slot = {
        id,
        slotId: id,
        frame: boundFrame(frame),
        prompt: "",
        headline: "",
        body: "",
        sourceIds: [],
        section: "news",
        locked: false,
        status: "draft",
        contentVersion: 0,
      };
      void run(
        "create_story",
        { slotId: id, frame: slot.frame },
        { kind: "reserve", target: targetOf(slot), story: slot },
        { target: targetOf(slot) },
      );
      return slot;
    },
    [run],
  );
  const draftPrompt = useCallback(
    (story, prompt) => {
      return draftStory(story, { prompt });
    },
    [draftStory],
  );
  const requestStory = useCallback(
    async (story, prompt) => {
      const epoch = paperEpoch.current;
      if (resetPending.current) {
        return null;
      }
      if (!prompt.trim() || !(await flushDraft(storyKey(story)))) {
        return null;
      }
      if (resetPending.current || epoch !== paperEpoch.current) {
        return null;
      }
      return run(
        "request_story",
        { slotId: storyKey(story), prompt: prompt.trim() },
        null,
        { target: targetOf(story) },
      );
    },
    [flushDraft, run],
  );
  const reportRenderedFit = useCallback(
    (story, measurement) => {
      const authoritative = queryClient.getQueryData(STATE_KEY);
      // Hot-reloaded UI can outlive its backend. Only a current backend response
      // may enable this new app-only tool.
      if (
        authoritative?.uiCapabilities?.renderedCopyFit !== true ||
        !connection.isConnected ||
        resetPending.current ||
        !measurement.ready ||
        entriesRef.current.length ||
        Object.keys(draftsRef.current).length ||
        authoritative.editorial?.status === "running"
      ) {
        return;
      }
      const key = storyKey(story);
      if (
        authoritative.jobs.some((job) => {
          return job.slotId === key && activeJob(job);
        })
      ) {
        return;
      }
      const signature = JSON.stringify([
        authoritative.issue.id,
        measurement.key,
        measurement.overflow,
        Math.round(measurement.bodyHeight),
        Math.round(measurement.availableBodyHeight),
      ]);
      if (renderedReports.current.get(key) === signature) {
        return;
      }
      renderedReports.current.set(key, signature);
      void run(
        "report_story_fit",
        {
          issueId: authoritative.issue.id,
          slotId: key,
          contentVersion: story.contentVersion,
          frame: story.frame,
          key: measurement.key,
          overflow: measurement.overflow,
          bodyHeight: measurement.bodyHeight,
          availableBodyHeight: measurement.availableBodyHeight,
          minimumLineHeight: measurement.minimumLineHeight,
          requiredHeight: measurement.requiredHeight,
        },
        null,
        { target: targetOf(story) },
      ).then((result) => {
        const outcome = structuredResult(result);
        // A review may have started after this report was queued. Its next state
        // update should retry the observation, without replaying a paid action.
        if (
          outcome?.accepted === false &&
          outcome.reason === "working" &&
          renderedReports.current.get(key) === signature
        ) {
          renderedReports.current.delete(key);
        }
      });
    },
    [queryClient, connection.isConnected, run],
  );
  const requestAutoResearch = useCallback(
    async (story) => {
      const epoch = paperEpoch.current;
      if (resetPending.current) {
        return null;
      }
      if (!(await flushAll())) {
        throw new Error(
          "Save or retry the outstanding edits before starting auto research.",
        );
      }
      if (resetPending.current || epoch !== paperEpoch.current) {
        return null;
      }
      return run("request_auto_research", { slotId: storyKey(story) }, null, {
        target: targetOf(story),
      });
    },
    [flushAll, run],
  );
  const cancelAutoResearch = useCallback(
    (runId) => {
      return run("cancel_auto_research", { runId });
    },
    [run],
  );
  const moveStory = useCallback(
    async (story, frame) => {
      const epoch = paperEpoch.current;
      if (resetPending.current) {
        return null;
      }
      const bounded = retainFramePrecision(story.frame, boundFrame(frame));
      const failedMove = entriesRef.current.some((entry) => {
        return (
          entry.status === "failed" &&
          entry.name === "move_story" &&
          sameStory(story, entry.target)
        );
      });
      if (!story.locked && !failedMove && sameFrame(story.frame, bounded)) {
        return true;
      }
      const resized = !sameFrameSize(bounded, story.frame);
      if (resized && !(await flushDraft(storyKey(story)))) {
        return null;
      }
      if (resetPending.current || epoch !== paperEpoch.current) {
        return null;
      }
      return run(
        "move_story",
        { slotId: storyKey(story), frame: bounded },
        { kind: "patch", target: targetOf(story), patch: { frame: bounded } },
        { target: targetOf(story) },
      );
    },
    [run, flushDraft],
  );
  const editStory = useCallback(
    (story, patch) => {
      return run(
        "edit_story",
        { slotId: storyKey(story), patch },
        { kind: "patch", target: targetOf(story), patch },
        { target: targetOf(story) },
      );
    },
    [run],
  );
  const cancelStory = useCallback(
    (story) => {
      return run("cancel_story", { slotId: storyKey(story) }, null, {
        target: targetOf(story),
      });
    },
    [run],
  );
  const lockStory = useCallback(
    async (story) => {
      const epoch = paperEpoch.current;
      if (resetPending.current) {
        return null;
      }
      if (!(await flushDraft(storyKey(story)))) {
        return null;
      }
      if (resetPending.current || epoch !== paperEpoch.current) {
        return null;
      }
      return run(
        "lock_story",
        { slotId: storyKey(story), locked: !story.locked },
        { kind: "patch", target: targetOf(story), patch: { locked: !story.locked } },
        { target: targetOf(story) },
      );
    },
    [run, flushDraft],
  );
  const deleteStory = useCallback(
    (story) => {
      if (resetPending.current) {
        return Promise.resolve(null);
      }
      const key = storyKey(story);
      clearTimeout(timers.current.get(key));
      updateDrafts((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      return run(
        "delete_story",
        { slotId: key },
        { kind: "delete", target: targetOf(story) },
        { target: targetOf(story) },
      );
    },
    [run, updateDrafts],
  );
  const useAlternate = useCallback(
    (story) => {
      if (resetPending.current) {
        return Promise.resolve(false);
      }
      const alternate = story.alternateDraft;
      if (
        !alternate ||
        story.locked ||
        story.pinned ||
        !equals(story.sourceIds, alternate.sourceIds)
      ) {
        return Promise.resolve(false);
      }
      draftStory(story, { headline: alternate.headline, body: alternate.body });
      return flushDraft(storyKey(story));
    },
    [draftStory, flushDraft],
  );

  const retry = useCallback(
    (entry) => {
      if (
        resetPending.current ||
        !entriesRef.current.some((item) => {
          return item.id === entry.id;
        })
      ) {
        return Promise.resolve(null);
      }
      const retried = {
        ...entry,
        epoch: paperEpoch.current,
        status: "saving",
        error: null,
      };
      updateEntries((previous) => {
        return previous.map((item) => {
          return item.id === entry.id ? retried : item;
        });
      });
      const promise = mutation.mutateAsync(retried).catch(() => {
        return null;
      });
      promises.current.add(promise);
      void promise.finally(() => {
        return promises.current.delete(promise);
      });
      return promise;
    },
    [mutation.mutateAsync, updateEntries],
  );

  // LEARNING: Reset retires old reads and pending work before adopting the new newspaper.
  const newNewspaper = useCallback(() => {
    if (resetTask.current) {
      return resetTask.current;
    }
    if (!connection.isConnected || !appRef.current) {
      setProblem(
        "Wait for the Interactive Editor View to reconnect before starting a new newspaper.",
      );
      return Promise.resolve(null);
    }
    resetPending.current = true;
    setResetting(true);
    setPaperGeneration(++paperEpoch.current);
    setProblem(null);
    persistenceFailures.current.clear();
    for (const timer of timers.current.values()) {
      clearTimeout(timer);
    }
    timers.current.clear();
    updateDrafts(() => {
      return {};
    });
    const task = (async () => {
      try {
        await queryClient.cancelQueries({ queryKey: STATE_KEY, exact: true });
        // Finish already-dispatched/queued writes, without flushing discarded
        // text or admitting more actions. The server then cancels background work.
        while (promises.current.size) {
          await Promise.allSettled([...promises.current]);
        }
        const result = await appRef.current.callServerTool({
          name: "new_newspaper",
          arguments: {},
        });
        const error = toolError(result);
        if (error) {
          throw error;
        }
        const snapshot = normalizeSnapshot(result);
        if (!snapshot || snapshot.issue.stories.length) {
          throw new Error("The reset did not return a cleared newspaper snapshot.");
        }
        updateEntries(() => {
          return [];
        });
        updateDrafts(() => {
          return {};
        });
        for (const timer of timers.current.values()) {
          clearTimeout(timer);
        }
        timers.current.clear();
        renderedReports.current.clear();
        // A reset snapshot is authoritative: merging old jobs/intents here could
        // resurrect cleared work. Archive, funding and settings come from the server.
        replacingState.current = true;
        try {
          queryClient.setQueryData(STATE_KEY, snapshot);
        } finally {
          replacingState.current = false;
        }
        setProblem(null);
        return result;
      } catch (error) {
        setProblem(error.message);
        // A free state refresh can resolve an uncertain response; never replay
        // the reset or discarded body writes automatically.
        void queryClient
          .invalidateQueries({ queryKey: STATE_KEY, refetchType: "none" })
          .catch(() => {});
        return null;
      } finally {
        resetPending.current = false;
        setResetting(false);
      }
    })();
    resetTask.current = task;
    void task.finally(() => {
      if (resetTask.current === task) {
        resetTask.current = null;
      }
    });
    return task;
  }, [connection.isConnected, queryClient, updateDrafts, updateEntries]);

  return {
    state,
    authoritative: query.data,
    connection,
    hostContext,
    resetting,
    paperGeneration,
    newNewspaper,
    error:
      problem || transportProblem || connection.error?.message || query.error?.message,
    dismissError: () => {
      setProblem(null);
      setTransportProblem(null);
    },
    run,
    createSlot,
    draftPrompt,
    requestStory,
    reportRenderedFit,
    moveStory,
    editStory,
    deleteStory,
    draftStory,
    cancelStory,
    lockStory,
    useAlternate,
    requestAutoResearch,
    cancelAutoResearch,
    listExecution,
    getExecutionRecord,
    clearExecution,
    flushDraft,
    flushAll,
    retry,
    dirty: Object.keys(drafts).length > 0,
    pending: entries.filter((entry) => {
      return entry.status === "saving";
    }),
    failed: entries.filter((entry) => {
      return entry.status === "failed";
    }),
    refresh: () => {
      return query.refetch();
    },
    openExecution: async (recordId = null, taskId = "") => {
      try {
        if (!connection.isConnected) {
          throw new Error("Wait for the editor to reconnect.");
        }
        await appRef.current.notification(
          OpenExecutionNotification.parse({
            method: "notifications/workshop/open-execution",
            params: { recordId, taskId },
          }),
        );
      } catch (error) {
        setProblem(error.message);
      }
    },
    openLink: async (url) => {
      try {
        const result = await appRef.current.openLink({ url });
        if (result.isError) {
          throw new Error("The host could not open this link.");
        }
        return true;
      } catch (error) {
        setProblem(error.message);
        return false;
      }
    },
  };
}

// LEARNING: SUPPORTING HELPERS
// Pure intent matching and projection used by useEditor.
function satisfied(snapshot, intent) {
  if (!snapshot || !intent) {
    return false;
  }
  if (intent.kind === "issue") {
    return Object.entries(intent.patch).every(([key, value]) => {
      return equals(snapshot.issue[key], value);
    });
  }
  if (intent.kind === "settings") {
    return Object.entries(intent.patch).every(([key, value]) => {
      return equals(snapshot.settings[key], value);
    });
  }
  const story = snapshot.issue.stories.find((item) => {
    return sameStory(item, intent.target ?? intent.story);
  });
  if (intent.kind === "reserve") {
    return Boolean(story);
  }
  if (intent.kind === "delete") {
    return !story;
  }
  return Boolean(
    story &&
    Object.entries(intent.patch ?? {}).every(([key, value]) => {
      return key === "frame"
        ? sameFrame(story.frame, value)
        : equals(story[key], value);
    }),
  );
}

function coverFailedChanges(entries) {
  return entries.reduce((previous, entry) => {
    return [...supersedeFailedIntents(previous, entry.intent), entry];
  }, []);
}

function projectEdit(state, intent) {
  const next = applyIntent(state, intent);
  if (!next || intent?.kind !== "patch" || !Object.hasOwn(intent.patch ?? {}, "body")) {
    return next;
  }
  return {
    ...next,
    issue: {
      ...next.issue,
      stories: next.issue.stories.map((story) => {
        return sameStory(story, intent.target) ? { ...story, typography: null } : story;
      }),
    },
  };
}
