// LEARNING: createIssueStore owns the newspaper and every accepted edit.
// Read its methods, especially completeStory; MCP callers cannot bypass this state boundary.

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stageProfile } from "../stages.mjs";
import { retainFramePrecision, sameFrame } from "../../ui/src/shared/geometry.mjs";

const clone = (value) => {
  return structuredClone(value);
};
const text = (value, maximum = 24000) => {
  return String(value ?? "").slice(0, maximum);
};
const overlap = (a, b) => {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
};
const unfinished = new Set([
  "pending",
  "researching",
  "reading",
  "writing",
  "queued",
  "running",
]);
const terminal = new Set([
  "completed",
  "complete",
  "done",
  "incomplete",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "superseded",
  "interrupted",
  "paused",
]);
const activityOnly = new Set([
  "issue",
  "jobs",
  "briefings",
  "settings",
  "preferences",
  "approvals",
  "suggestions",
  "trace",
  "execution",
  "streamRevision",
  "documentVersion",
  "persistence",
]);
const emptyIssue = (id) => {
  return {
    id,
    title: "The Agentic Times",
    focus: "Practical ideas for building useful, reliable agents",
    audience: "builders",
    revision: 0,
    width: 297,
    height: 420,
    date: new Date().toISOString().slice(0, 10),
    stories: [],
    sources: [],
    relationships: [],
    layoutTemplate: null,
  };
};

export async function createIssueStore({
  trace,
  config = {},
  file,
  persistence,
  restored,
} = {}) {
  // MAIN BEHAVIOR: restore the edition, then expose revision-aware editing methods.
  if (config.mode === "hosted" && !config.readiness && !persistence) {
    throw Object.assign(
      new Error("Hosted issues require visitor-scoped persistence."),
      { code: "STORAGE_CONFIG" },
    );
  }
  const initial = {
    issue: emptyIssue(config.issueId ?? randomUUID()),
    documentVersion: 0,
    jobs: [],
    briefings: [],
    suggestions: [],
    approvals: [],
    autoResearchRuns: [],
    autoResearchCheckpoints: {},
    preferences: { topic: "", readingList: [] },
    settings: {
      stage: "research",
      topology: "single",
      model: ["development", "hosted"].includes(config.mode)
        ? null
        : config.model || "openai/gpt-6-luna",
      decisionModel: config.decisionModel || "typesafe/jev-1.13",
      maxTurns: 10,
      // Session 3 demo toggle. OFF is normal real execution (the default). ON places the
      // bundled demo story and branches every demo-specific override on it: the recorded
      // fact-check replay, the planted-error highlights and legend, and the fixed-copy
      // editorial skip. Persisted with the edition so a reload keeps the toggle state.
      demoMode: false,
      mode: config.mode || "fixture",
    },
  };
  let state = initial;
  const restoredResults = new Set();
  if (file || persistence) {
    try {
      // A hosted runtime file is only a cache. Never use it as visitor authority.
      const saved = persistence ? restored : JSON.parse(await readFile(file, "utf8"));
      if (saved?.issue?.stories && saved?.settings) {
        const {
          trace: _trace,
          execution: _execution,
          streamRevision: _revision,
          persistence: _persistence,
          inferenceSelection: _selection,
          inferenceActivity: _activity,
          ...savedState
        } = saved;
        state = {
          ...initial,
          ...savedState,
          jobs: [],
          approvals: [],
          settings: { ...initial.settings, ...saved.settings },
        };
        state.settings.mode = config.mode || "fixture";
        // A saved edition cannot select the model for a new broker capability.
        state.settings.model = initial.settings.model;
        for (const story of state.issue.stories) {
          // Normalize saved identifiers once; current tool inputs use slotId only.
          story.slotId ??= story.id;
          story.id ??= story.slotId;
          if (unfinished.has(story.status)) {
            story.status = "interrupted";
          }
        }
        for (const briefing of state.briefings)
          if (unfinished.has(briefing.status)) {
            briefing.status = briefing.phase = "interrupted";
          }
        const interruptReview = (receipt) => {
          return receipt?.status === "running"
            ? {
                ...receipt,
                status: "interrupted",
                durationMs: null,
                error:
                  "The process restarted before editorial completion was recorded. Inspect Execution before requesting another review.",
              }
            : receipt;
        };
        state.editorial = interruptReview(state.editorial);
        state.editorialHistory = (state.editorialHistory ?? []).map(interruptReview);
        state.autoResearchRuns = (state.autoResearchRuns ?? [])
          .slice(0, 12)
          .map((run) => {
            return unfinished.has(run.status)
              ? {
                  ...run,
                  status: "interrupted",
                  resumable: Boolean(state.autoResearchCheckpoints?.[run.id]),
                  stopReason:
                    "The process restarted. Kept copy is retained; resume the saved step explicitly.",
                }
              : run;
          });
        for (const story of state.issue.stories)
          if (["pending", "running"].includes(story.factCheck?.status)) {
            story.factCheck = {
              ...story.factCheck,
              status: "unavailable",
              error: "Assessment completion was not recorded before restart.",
            };
          }
        for (const result of [
          ...state.briefings,
          state.editorial,
          ...state.editorialHistory,
        ]) {
          const id = result?.requestId ?? result?.jobId ?? result?.id;
          if (id) {
            restoredResults.add(id);
          }
        }
      }
    } catch (error) {
      if (persistence) {
        throw error;
      }
      if (error.code !== "ENOENT") {
        trace?.record("storage", { error: error.message });
      }
    }
  }
  const listeners = new Set(),
    past = [],
    future = [];
  const actionMutations = new AsyncLocalStorage();
  let saving = Promise.resolve();
  let recovery = null;
  let pendingSave = null,
    saveRunning = false,
    saveTimer = null,
    mutationVersion = 0;
  let lastProjection = null;
  let persistenceState = config.readiness
    ? { mode: "readiness", phase: "readiness", error: null }
    : (persistence?.status() ?? {
        mode: file ? "local" : "memory",
        phase: "saved",
        error: null,
      });
  let saveError = persistenceState.error
    ? Object.assign(new Error(persistenceState.error.message), {
        code: persistenceState.error.code,
      })
    : null;
  let streamRevision = 0;

  const snapshot = () => {
    // Full resumable inputs stay on the server and in the saved edition; normal
    // editor updates carry only compact run progress, never repeated evidence.
    const { autoResearchCheckpoints, ...visible } = state;
    return clone({
      ...visible,
      settings: { ...state.settings, capabilities: stageProfile(state.settings.stage) },
      autoResearchRuns: state.autoResearchRuns.map((run) => {
        const checkpoint = autoResearchCheckpoints?.[run.id];
        const story = state.issue.stories.find((item) => {
          return item.slotId === run.slotId;
        });
        const resumable = Boolean(
          run.resumable &&
          checkpoint &&
          story &&
          checkpoint.requests < checkpoint.maxTurns &&
          state.issue.id === checkpoint.issueId &&
          state.documentVersion === checkpoint.documentVersion &&
          story.id === checkpoint.storyId &&
          story.contentVersion === checkpoint.contentVersion &&
          story.requestId === checkpoint.requestId &&
          story.frame.width === checkpoint.frame.width &&
          story.frame.height === checkpoint.frame.height,
        );
        return { ...run, resumable };
      }),
      briefings: state.briefings.map((briefing) => {
        return resultHistory(briefing, { briefing: true });
      }),
      ...(state.editorial ? { editorial: resultHistory(state.editorial) } : {}),
      ...(state.editorialHistory
        ? {
            editorialHistory: state.editorialHistory.map((receipt) => {
              return resultHistory(receipt);
            }),
          }
        : {}),
      persistence: persistenceState,
      streamRevision,
      trace: recentTrace(trace),
      execution: executionSummary(trace),
    });
  };
  const publish = () => {
    streamRevision++;
    for (const listener of listeners) {
      const value = snapshot();
      // Observers do not own mutations or durable save acknowledgements.
      // Detach a disconnected observer without poisoning the save queue.
      try {
        listener(value)?.catch?.(() => {
          return listeners.delete(listener);
        });
      } catch {
        listeners.delete(listener);
      }
    }
  };

  function update(mutator, event = {}) {
    writable();
    if (event.history !== false) {
      past.push(clone(state.issue));
      if (past.length > 40) {
        past.shift();
      }
      future.length = 0;
    }
    const before = state.issue.revision;
    mutator(state.issue, state);
    state.issue.revision++;
    trace?.record(event.kind || "editor", {
      actor: event.actor || "app",
      action: event.action || "update",
      beforeRevision: before,
      issueRevision: state.issue.revision,
      ...(event.data || {}),
    });
    notify({ urgent: event.flush || event.action === "stage_changed" });
    return snapshot();
  }
  function activity(mutator, event, urgent = event?.flush) {
    writable();
    mutator(state);
    if (event) {
      trace?.record(event.kind ?? "agent", event);
    }
    notify({ urgent });
    return snapshot();
  }
  function updateActivity(patch) {
    const clearingExecution =
      typeof patch?.executionClearedAt === "string" &&
      Number.isFinite(Date.parse(patch.executionClearedAt)) &&
      Array.isArray(patch.jobs);
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => {
        return (
          (activityOnly.has(key) && !(key === "jobs" && clearingExecution)) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        );
      })
    ) {
      throw new Error("Activity updates may only replace non-domain state.");
    }
    if (clearingExecution) {
      const terminal = new Set([
        "completed",
        "complete",
        "done",
        "incomplete",
        "failed",
        "error",
        "cancelled",
        "canceled",
        "stopped",
        "superseded",
        "interrupted",
      ]);
      const retained = state.jobs.filter((job) => {
        return !terminal.has(job.status);
      });
      if (JSON.stringify(patch.jobs) !== JSON.stringify(retained)) {
        throw new Error(
          "Execution clearing may only prune completed jobs; active jobs must be preserved.",
        );
      }
    }
    return activity(
      (current) => {
        return Object.assign(current, clone(patch));
      },
      undefined,
      terminal.has(patch.editorial?.status),
    );
  }
  const find = (id) => {
    return state.issue.stories.find((story) => {
      return story.slotId === id;
    });
  };
  // These methods are the public state API used by the agent, MCP tools and editor.
  const methods = {
    snapshot,
    update,
    updateActivity,
    get mutationVersion() {
      return mutationVersion;
    },
    async trackAction(callback) {
      const action = { active: true, changed: false };
      try {
        const result = await actionMutations.run(action, callback);
        return { result, changed: action.changed };
      } finally {
        action.active = false;
      }
    },
    applyInferenceSelection(selection) {
      if (
        !selection ||
        typeof selection.model !== "string" ||
        !selection.model.trim() ||
        selection.model.length > 256
      ) {
        throw new Error("The connection did not report a valid selected model.");
      }
      return activity((current) => {
        current.settings.model = selection.model;
        current.inferenceSelection = clone(selection);
      });
    },
    newNewspaper() {
      return update(
        (issue, current) => {
          current.issue = { ...emptyIssue(issue.id), revision: issue.revision };
          current.documentVersion = (current.documentVersion ?? 0) + 1;
          current.jobs = [];
          current.briefings = [];
          current.suggestions = [];
          current.approvals = [];
          current.editorial = null;
          current.editorialHistory = [];
          current.autoResearchRuns = [];
          current.autoResearchCheckpoints = {};
          current.layoutOperation = null;
          current.settings.editorLayout = "newspaper";
          for (const key of Object.keys(current.settings))
            if (key.startsWith("layoutCleanup")) {
              delete current.settings[key];
            }
        },
        { action: "newspaper_started", actor: "app" },
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        return listeners.delete(listener);
      };
    },
    getStory: (id) => {
      return clone(requireStory(id));
    },
    addSources(records) {
      return update(
        (issue) => {
          for (const record of records) {
            if (!record?.id || !record.title) {
              continue;
            }
            const index = issue.sources.findIndex((source) => {
              return source.id === record.id;
            });
            if (index < 0) {
              issue.sources.push(clone(record));
            } else {
              issue.sources[index] = { ...issue.sources[index], ...clone(record) };
            }
          }
          if (issue.sources.length > 80) {
            issue.sources = issue.sources.slice(-80);
          }
        },
        { action: "sources_added", history: false },
      );
    },
    // Session 3: place the bundled fact-check story as ordinary, editable copy. Its text
    // comes from the archive rather than a writer, so it is marked fixedCopy and is never
    // shortened by copy fitting; the frame takes the whole page when the page is empty.
    placeFixedStory({ headline, body, plantedClaims = [] } = {}) {
      const id = randomUUID();
      const frame = state.issue.stories.length
        ? vacantFrame()
        : normalizeFrame({ x: 12, y: 44, width: 273, height: 350 });
      const story = {
        id,
        slotId: id,
        prompt: "",
        headline: text(headline, 200),
        body: text(body, 24000),
        sourceIds: [],
        frame,
        section: "news",
        locked: false,
        status: "ready",
        fixedCopy: true,
        contentVersion: 1,
        requestId: null,
        factCheck: { status: "pending", probability: null },
        // Session 3 demo only: which sentences are planted errors, and (after a fact-check
        // run) which of those the arrangement caught. Display data; agents never read it.
        plantedClaims: (Array.isArray(plantedClaims) ? plantedClaims : [])
          .filter((claim) => typeof claim?.id === "string" && typeof claim?.text === "string")
          .map((claim) => ({ id: claim.id, text: claim.text })),
        plantedResult: null,
      };
      update(
        (issue) => {
          return issue.stories.push(story);
        },
        {
          action: "slot_reserved",
          data: { slotId: id, prompt: "", frame },
        },
      );
      return clone(story);
    },
    reserveStory({ slotId, prompt = "", frame, sourceIds = [] } = {}) {
      const id = slotId ?? randomUUID();
      const existing = find(id);
      if (existing) {
        return clone(existing);
      }
      const savedPrompt = text(prompt, 4000);
      const story = {
        id,
        slotId: id,
        prompt: savedPrompt,
        headline: "",
        body: "",
        sourceIds,
        frame: vacantFrame(frame),
        section: "news",
        locked: false,
        status: savedPrompt.trim() ? "pending" : "draft",
        contentVersion: 0,
        requestId: null,
        factCheck: { status: "pending", probability: null },
      };
      update(
        (issue) => {
          return issue.stories.push(story);
        },
        {
          action: "slot_reserved",
          data: { slotId: id, prompt: story.prompt, frame: story.frame },
        },
      );
      return clone(story);
    },
    applyLayout({ issueId, baseRevision, frames, template } = {}) {
      const reject = (code, message) => {
        throw Object.assign(new Error(message), { code });
      };
      if (issueId !== undefined && issueId !== state.issue.id) {
        reject("UNKNOWN_ISSUE", "This layout does not belong to the current issue.");
      }
      if (
        !Number.isSafeInteger(baseRevision) ||
        baseRevision !== state.issue.revision
      ) {
        reject(
          "STALE_LAYOUT",
          "The issue changed after this layout was measured. Prepare a new proposal.",
        );
      }
      if (
        template !== undefined &&
        !["newspaper", "breaking_news", "side_by_side"].includes(template)
      ) {
        reject("INVALID_TEMPLATE", "Choose a supported newspaper layout template.");
      }
      if (!Array.isArray(frames) || !frames.length || frames.length > 100) {
        reject("INVALID_LAYOUT", "Supply one to one hundred existing story frames.");
      }
      const keys = ["x", "y", "width", "height"];
      const exactFrame = (a, b) => {
        return keys.every((key) => {
          return a[key] === b[key];
        });
      };
      const validFrame = (frame) => {
        if (
          !frame ||
          keys.some((key) => {
            return !Number.isFinite(frame[key]);
          }) ||
          !exactFrame(frame, normalizeFrame(frame)) ||
          frame.x + frame.width > state.issue.width ||
          frame.y + frame.height > state.issue.height
        ) {
          reject(
            "FRAME_BOUNDS",
            "Every layout rectangle must fit the newspaper's content area.",
          );
        }
      };
      const proposed = new Map();
      for (const entry of frames) {
        if (!entry || typeof entry.slotId !== "string" || proposed.has(entry.slotId)) {
          reject("INVALID_LAYOUT", "Each layout slot must appear exactly once.");
        }
        const story = find(entry.slotId);
        if (!story) {
          reject("UNKNOWN_SLOT", "A proposed story slot no longer exists.");
        }
        validFrame(entry.frame);
        if (story.locked && !sameFrame(story.frame, entry.frame)) {
          reject("STORY_LOCKED", "A layout cannot change a locked story.");
        }
        proposed.set(entry.slotId, retainFramePrecision(story.frame, entry.frame));
      }
      const resulting = state.issue.stories.map((story) => {
        return {
          slotId: story.slotId,
          frame: proposed.get(story.slotId) ?? story.frame,
        };
      });
      for (let i = 0; i < resulting.length; i++) {
        validFrame(resulting[i].frame);
        for (let j = 0; j < i; j++)
          if (overlap(resulting[i].frame, resulting[j].frame)) {
            reject(
              "LAYOUT_OVERLAP",
              "The resulting layout must not overlap any story, including unchanged or locked blocks.",
            );
          }
      }
      const changed = resulting.some(({ slotId, frame }) => {
        return !sameFrame(find(slotId).frame, frame);
      });
      if (
        !changed &&
        (template === undefined || template === state.issue.layoutTemplate)
      ) {
        return snapshot();
      }
      // Validation is complete. A single issue update owns the entire undo step.
      return update(
        (issue, current) => {
          for (const story of issue.stories) {
            const frame = proposed.get(story.slotId);
            if (frame && !sameFrame(story.frame, frame)) {
              story.frame = clone(frame);
              delete story.fit;
            }
          }
          delete current.settings.layoutCleanup;
          if (template !== undefined) {
            issue.layoutTemplate = template;
          }
        },
        {
          action: "layout_applied",
          data: {
            baseRevision,
            frames: clone(frames),
            ...(template ? { template } : {}),
          },
        },
      );
    },
    moveStory(id, frame) {
      const previous = requireStory(id);
      if (previous.locked) {
        throw new Error("Unlock this story before changing its placement.");
      }
      const previousFrame = clone(previous.frame);
      const nextFrame = retainFramePrecision(previousFrame, normalizeFrame(frame));
      if (sameFrame(previousFrame, nextFrame)) {
        return snapshot();
      }
      return update(
        () => {
          const story = requireStory(id);
          story.frame = nextFrame;
          if (story.body) {
            story.status =
              !story.fixedCopy &&
              story.body.trim().split(/\s+/).length > storyWordBudget(story.frame) * 1.5
                ? "overflow"
                : "ready";
          }
        },
        {
          action: "story_moved",
          data: { slotId: id, storyId: previous.id, previousFrame, frame: nextFrame },
        },
      );
    },
    editStory(id, patch) {
      const story = requireStory(id);
      if (story.locked) {
        throw new Error("Unlock this story before changing its copy.");
      }
      const changes = Object.fromEntries(
        ["headline", "body", "section", "prompt"]
          .filter((key) => {
            return typeof patch[key] === "string";
          })
          .map((key) => {
            return [key, text(patch[key], key === "headline" ? 200 : 24000)];
          })
          .filter(([key, value]) => {
            return story[key] !== value;
          }),
      );
      if (!Object.keys(changes).length) {
        return snapshot();
      }
      return update(
        () => {
          Object.assign(story, changes);
          story.contentVersion++;
          delete story.researchNote;
          if (story.typography?.contentVersion !== story.contentVersion) {
            delete story.typography;
          }
          story.factCheck = { ...story.factCheck, status: "pending" };
          if (story.body) {
            story.status =
              !story.fixedCopy &&
              story.body.trim().split(/\s+/).length > storyWordBudget(story.frame) * 1.5
                ? "overflow"
                : "ready";
          } else if (!unfinished.has(story.status)) {
            story.status = "draft";
          }
        },
        { action: "copy_edited", data: { storyId: id } },
      );
    },
    deleteStory(id) {
      if (requireStory(id).locked) {
        throw new Error("Unlock this story before deleting it.");
      }
      return update(
        (issue) => {
          issue.stories = issue.stories.filter((story) => {
            return story.slotId !== id;
          });
        },
        { action: "story_deleted", data: { storyId: id } },
      );
    },
    lockStory(id, locked = true) {
      requireStory(id);
      return update(
        () => {
          requireStory(id).locked = Boolean(locked);
        },
        {
          action: "story_locked",
          data: { storyId: id, locked },
        },
      );
    },
    setFocus(focus) {
      return update(
        (issue) => {
          issue.focus = text(focus, 2000);
          for (const story of issue.stories) {
            story.factCheck.status = "pending";
          }
        },
        { action: "focus_changed" },
      );
    },
    setTitle(title) {
      return update(
        (issue) => {
          issue.title = text(title, 120);
        },
        { action: "title_changed" },
      );
    },
    setAudience(audience) {
      if (
        typeof audience !== "string" ||
        !audience.trim() ||
        audience.trim().length > 200
      ) {
        throw new Error("Audience must contain 1–200 characters.");
      }
      audience = audience.trim();
      const beforeAudience = state.issue.audience;
      if (audience === beforeAudience) {
        return snapshot();
      }
      return update(
        (issue) => {
          issue.audience = audience;
        },
        {
          action: "audience_changed",
          data: { beforeAudience, audience },
        },
      );
    },
    setDecisionModel(model) {
      if (!["typesafe/jev-1.13", "perplexity/pplx-decider-v1.1-27b"].includes(model)) {
        throw new Error("Choose an approved decision model.");
      }
      return update(
        (_issue, current) => {
          current.settings.decisionModel = model;
          for (const story of current.issue.stories) {
            story.factCheck.status = "pending";
          }
        },
        { action: "decision_model_changed", history: false },
      );
    },
    // Session 3 demo toggle. Turning it ON places the bundled demo story if the edition does
    // not already hold a demo story; OFF leaves execution real and removes nothing. Returns a
    // snapshot so the caller can report whether a story was placed.
    setDemoMode(on) {
      const enabled = on === true;
      if (state.settings.demoMode === enabled) {
        return { demoMode: enabled, placed: false };
      }
      update(
        (_issue, current) => {
          current.settings.demoMode = enabled;
        },
        { action: "demo_mode_changed", history: false },
      );
      return { demoMode: enabled, placed: false };
    },
    setTopology(topology) {
      if (!["single", "graph", "swarm"].includes(topology)) {
        throw new Error("Choose the single agent, the graph or the swarm.");
      }
      if (state.settings.topology === topology) {
        return snapshot();
      }
      return update(
        (_issue, current) => {
          current.settings.topology = topology;
        },
        { action: "topology_changed", history: false },
      );
    },
    setStage(stage) {
      stageProfile(stage);
      if (state.settings.stage === stage) {
        return snapshot();
      }
      return update(
        (_issue, current) => {
          current.settings.stage = stage;
        },
        {
          action: "stage_changed",
          history: false,
        },
      );
    },
    undo() {
      writable();
      if (!past.length) {
        return snapshot();
      }
      future.push(clone(state.issue));
      const revision = state.issue.revision + 1;
      state.issue = past.pop();
      state.issue.revision = revision;
      trace?.record("editor", { action: "undo", issueRevision: revision });
      notify();
      return snapshot();
    },
    redo() {
      writable();
      if (!future.length) {
        return snapshot();
      }
      past.push(clone(state.issue));
      const revision = state.issue.revision + 1;
      state.issue = future.pop();
      state.issue.revision = revision;
      trace?.record("editor", { action: "redo", issueRevision: revision });
      notify();
      return snapshot();
    },
    startJob({ slotId, prompt }) {
      const story = requireStory(slotId);
      if (story.locked) {
        throw new Error("Unlock this story before requesting new copy.");
      }
      const job = {
        id: randomUUID(),
        type: "story",
        issueId: state.issue.id,
        slotId: story.slotId,
        prompt: text(prompt || story.prompt, 4000),
        status: "queued",
        turn: 0,
        startedAt: new Date().toISOString(),
        baseContentVersion: story.contentVersion,
      };
      job.requestId = job.id;
      update(
        (_issue, current) => {
          story.requestId = job.id;
          story.status = "queued";
          current.jobs.push(job);
        },
        { action: "story_requested", data: { jobId: job.id, slotId }, history: false },
      );
      return clone(job);
    },
    startBriefing({ prompt }) {
      const id = randomUUID(),
        createdAt = new Date().toISOString();
      const job = {
        id,
        requestId: id,
        type: "briefing",
        issueId: state.issue.id,
        prompt: text(prompt, 4000),
        status: "queued",
        phase: "queued",
        turn: 0,
        maxTurns: state.settings.maxTurns,
        startedAt: createdAt,
      };
      activity(
        (current) => {
          current.jobs.push(job);
          current.briefings.push({
            id,
            jobId: id,
            issueId: job.issueId,
            prompt: job.prompt,
            status: "queued",
            phase: "queued",
            turn: 0,
            maxTurns: job.maxTurns,
            answer: "",
            partialText: "",
            cards: [],
            createdAt,
            updatedAt: createdAt,
          });
        },
        { action: "briefing_requested", jobId: id, prompt: job.prompt },
      );
      return clone(job);
    },
    proposeBriefing({ jobId = null, cards }) {
      const job =
        jobId &&
        state.jobs.find((entry) => {
          return entry.id === jobId && entry.type === "briefing";
        });
      if (jobId && (!job || !unfinished.has(job.status))) {
        throw new Error("This briefing request is no longer active.");
      }
      const known = new Set(
        state.issue.sources.map((source) => {
          return source.id;
        }),
      );
      if (
        !Array.isArray(cards) ||
        !cards.length ||
        cards.length > 12 ||
        new Set(
          cards.map((card) => {
            return card.id;
          }),
        ).size !== cards.length ||
        cards.some((card) => {
          return !known.has(card.id);
        })
      ) {
        throw new Error(
          "Recommendations need one to twelve distinct observed source IDs.",
        );
      }
      let briefing = state.briefings.find((entry) => {
        return entry.jobId === jobId && jobId;
      });
      const createdAt = new Date().toISOString();
      activity(
        (current) => {
          if (!briefing) {
            briefing = {
              id: randomUUID(),
              jobId: null,
              issueId: state.issue.id,
              prompt: "",
              status: "completed",
              phase: "completed",
              turn: 0,
              maxTurns: 0,
              answer: "",
              partialText: "",
              cards: [],
              createdAt,
            };
            current.briefings.push(briefing);
          }
          briefing.cards = clone(cards);
          briefing.updatedAt = createdAt;
        },
        {
          action: "briefing_proposed",
          jobId,
          sourceIds: cards.map((card) => {
            return card.id;
          }),
        },
      );
      return clone(briefing);
    },
    startAutoResearch({ id = randomUUID(), slotId, maxRounds, maxTurns, executionId }) {
      const story = requireStory(slotId);
      const startedAt = new Date().toISOString();
      const job = {
        id,
        requestId: id,
        type: "auto_research",
        issueId: state.issue.id,
        slotId,
        storyId: story.id,
        status: "queued",
        phase: "audit",
        turn: 0,
        maxTurns,
        startedAt,
        sourceIds: [],
      };
      const run = {
        id,
        slotId,
        storyId: story.id,
        status: "queued",
        phase: "audit",
        round: 0,
        completedRounds: 0,
        maxRounds,
        maxTurns,
        turn: 0,
        kept: 0,
        reverted: 0,
        currentEvaluation: null,
        startedAt,
        executionId,
        summary:
          "Freeze the information goals, then research, experiment and evaluate.",
      };
      activity((current) => {
        current.jobs.push(job);
        current.autoResearchRuns = [run, ...(current.autoResearchRuns ?? [])].slice(
          0,
          12,
        );
        current.autoResearchCheckpoints = Object.fromEntries(
          Object.entries(current.autoResearchCheckpoints ?? {}).filter(([key]) => {
            return current.autoResearchRuns.some((entry) => {
              return entry.id === key && entry.slotId !== slotId;
            });
          }),
        );
      });
      return clone(job);
    },
    getAutoResearchCheckpoint(id) {
      return clone(state.autoResearchCheckpoints?.[id] ?? null);
    },
    checkpointAutoResearch(id, checkpoint) {
      if (
        !state.autoResearchRuns.some((run) => {
          return run.id === id;
        })
      ) {
        return;
      }
      activity((current) => {
        current.autoResearchCheckpoints ??= {};
        if (checkpoint) {
          current.autoResearchCheckpoints[id] = clone(checkpoint);
        } else {
          delete current.autoResearchCheckpoints[id];
        }
      });
    },
    resumeAutoResearch(id, executionId) {
      const run = state.autoResearchRuns.find((entry) => {
        return entry.id === id;
      });
      const checkpoint = state.autoResearchCheckpoints?.[id];
      if (!run || !checkpoint) {
        throw new Error("The research checkpoint is unavailable.");
      }
      return activity((current) => {
        Object.assign(run, {
          status: "queued",
          phase: checkpoint.nextStep,
          executionId,
          resumable: false,
          stopReason: null,
          error: null,
          endedAt: null,
          summary:
            "Resuming the saved step with the same evidence and remaining request allowance.",
        });
        const job = {
          id,
          requestId: id,
          type: "auto_research",
          issueId: checkpoint.issueId,
          slotId: checkpoint.slotId,
          storyId: checkpoint.storyId,
          status: "queued",
          phase: checkpoint.nextStep,
          turn: checkpoint.requests,
          maxTurns: checkpoint.maxTurns,
          startedAt: run.startedAt,
          sourceIds: checkpoint.evidence.map((source) => {
            return source.id;
          }),
        };
        const existing = current.jobs.find((entry) => {
          return entry.id === id;
        });
        if (existing) {
          Object.assign(existing, job);
        } else {
          current.jobs.push(job);
        }
      });
    },
    updateAutoResearch(id, patch) {
      const run = (state.autoResearchRuns ?? []).find((entry) => {
        return entry.id === id;
      });
      if (!run) {
        return snapshot();
      }
      return activity(
        (current) => {
          Object.assign(run, clone(patch));
          const job = current.jobs.find((entry) => {
            return entry.id === id;
          });
          if (job) {
            for (const key of ["status", "phase", "turn", "sourceIds"])
              if (patch[key] !== undefined) {
                job[key] =
                  key === "status" && patch[key] === "paused"
                    ? "stopped"
                    : clone(patch[key]);
              }
          }
        },
        undefined,
        terminal.has(patch.status) || patch.status === "stopped",
      );
    },
    applyResearchRevision({
      runId,
      slotId,
      storyId,
      issueId,
      documentVersion,
      contentVersion,
      expectedRequestId,
      headline,
      body,
      sourceIds,
      assessment,
    }) {
      const story = find(slotId);
      const job = state.jobs.find((entry) => {
        return entry.id === runId && entry.type === "auto_research";
      });
      if (
        state.settings.stage !== "research" ||
        state.issue.id !== issueId ||
        state.documentVersion !== documentVersion ||
        !story ||
        story.id !== storyId ||
        story.locked ||
        story.contentVersion !== contentVersion ||
        story.requestId !== expectedRequestId ||
        !job ||
        !unfinished.has(job.status)
      ) {
        throw Object.assign(
          new Error(
            "This story changed while the experiment ran. Your current copy was preserved.",
          ),
          { code: "SUPERSEDED" },
        );
      }
      const known = new Set(
        state.issue.sources.map((source) => {
          return source.id;
        }),
      );
      if (
        !headline?.trim() ||
        headline.length > 200 ||
        !body?.trim() ||
        body.length > 24000 ||
        !Array.isArray(sourceIds) ||
        !sourceIds.length ||
        sourceIds.some((id) => {
          return !known.has(id);
        })
      ) {
        throw new Error(
          "A research revision needs bounded copy and observed source IDs.",
        );
      }
      return update(
        () => {
          Object.assign(story, { headline, body, sourceIds: [...new Set(sourceIds)] });
          story.contentVersion++;
          story.status =
            body.trim().split(/\s+/u).length > storyWordBudget(story.frame) * 1.5
              ? "overflow"
              : "ready";
          delete story.typography;
          delete story.researchNote;
          story.factCheck = { ...story.factCheck, status: "stale" };
          story.research = {
            runId,
            contentVersion: story.contentVersion,
            ...clone(assessment),
          };
        },
        {
          action: "research_copy_kept",
          actor: "agent",
          data: { runId, slotId },
          flush: true,
        },
      );
    },
    updateJob(id, patch) {
      const job = state.jobs.find((entry) => {
        return entry.id === id;
      });
      if (!job) {
        return snapshot();
      }
      const progress = {
        action: "job_progress",
        jobId: id,
        ...patch,
        status: patch.status ?? job.status,
        phase: patch.phase ?? job.phase,
        turn: patch.turn ?? job.turn,
      };
      const apply = () => {
        Object.assign(job, patch);
        const story = find(job.slotId);
        if (
          story &&
          story.requestId === id &&
          !["ready", "overflow"].includes(story.status)
        ) {
          story.status = job.status;
        }
        const briefing = state.briefings.find((entry) => {
          return entry.jobId === id;
        });
        if (briefing) {
          for (const key of [
            "status",
            "phase",
            "turn",
            "maxTurns",
            "answer",
            "partialText",
            "partialTextCharacters",
            "partialTextTruncated",
            "cards",
            "error",
          ])
            if (patch[key] !== undefined) {
              briefing[key] = clone(patch[key]);
            }
          briefing.updatedAt = new Date().toISOString();
        }
      };
      const story = find(job.slotId);
      const changesStory =
        story &&
        story.requestId === id &&
        !["ready", "overflow"].includes(story.status) &&
        story.status !== (patch.status ?? job.status);
      if (changesStory) {
        return update(apply, {
          kind: "agent",
          action: "job_progress",
          data: progress,
          history: false,
          flush: terminal.has(patch.status),
        });
      }
      return activity(apply, progress, terminal.has(patch.status));
    },
    completeStory({
      slotId,
      requestId,
      baseContentVersion,
      headline,
      body,
      sourceIds = [],
    }) {
      const story = find(slotId);
      if (!story || story.requestId !== requestId) {
        trace?.record("editor", { action: "obsolete_draft", slotId, requestId });
        return {
          applied: false,
          reason: "Slot deleted or request replaced.",
          state: snapshot(),
        };
      }
      for (const id of sourceIds)
        if (
          !state.issue.sources.some((source) => {
            return source.id === id;
          })
        ) {
          throw new Error(`The draft cites an unobserved source: ${id}`);
        }
      const draft = { headline: text(headline, 200), body: text(body), sourceIds };
      if (story.locked || story.contentVersion !== baseContentVersion) {
        update(
          () => {
            story.alternateDraft = draft;
            story.status = story.body ? "ready" : "draft_available";
          },
          { action: "alternate_draft_retained", data: { slotId }, history: false },
        );
        return { applied: false, alternate: true, state: snapshot() };
      }
      update(
        () => {
          Object.assign(story, draft);
          story.contentVersion++;
          delete story.researchNote;
          if (story.typography?.contentVersion !== story.contentVersion) {
            delete story.typography;
          }
          story.status =
            draft.body.trim().split(/\s+/).length > storyWordBudget(story.frame) * 1.5
              ? "overflow"
              : "ready";
          story.factCheck = { status: "pending", probability: null };
        },
        {
          action: "draft_inserted",
          data: { slotId, requestId, sourceIds },
          history: false,
        },
      );
      return { applied: true, state: snapshot() };
    },
    saveLinks(sourceIds) {
      const selected = sourceIds.map((id) => {
        const source = state.issue.sources.find((item) => {
          return item.id === id;
        });
        if (!source) {
          throw new Error("Save only observed source IDs.");
        }
        return {
          id: source.id,
          title: source.title,
          url: source.url || source.canonicalUrl,
        };
      });
      const proposal = { id: randomUUID(), kind: "reading_list", value: selected };
      update(
        (_issue, current) => {
          return current.approvals.push(proposal);
        },
        {
          action: "approval_requested",
          history: false,
        },
      );
      return { needsApproval: true, proposal, state: snapshot() };
    },
    remember(topic) {
      const proposal = {
        id: randomUUID(),
        kind: "preference",
        value: text(topic, 256),
      };
      update(
        (_issue, current) => {
          return current.approvals.push(proposal);
        },
        {
          action: "approval_requested",
          history: false,
        },
      );
      return { needsApproval: true, proposal, state: snapshot() };
    },
    approve(id, accepted) {
      const proposal = state.approvals.find((entry) => {
        return entry.id === id;
      });
      if (!proposal) {
        throw new Error("That approval is no longer active.");
      }
      return update(
        (_issue, current) => {
          if (accepted && proposal.kind === "preference") {
            current.preferences.topic = proposal.value;
          }
          if (accepted && proposal.kind === "reading_list") {
            const map = new Map(
              current.preferences.readingList.map((source) => {
                return [source.id, source];
              }),
            );
            for (const source of proposal.value) {
              map.set(source.id, source);
            }
            current.preferences.readingList = [...map.values()];
          }
          current.approvals = current.approvals.filter((entry) => {
            return entry.id !== id;
          });
        },
        { action: accepted ? "change_approved" : "change_declined", history: false },
      );
    },
    async flush() {
      do {
        startSave();
        await saving;
      } while (!saveError && pendingSave !== null);
      if (saveError) {
        throw saveError;
      }
    },
    async retryPersistence() {
      writable();
      if (!recovery) {
        recovery = (async () => {
          await saving;
          try {
            await persistence?.retry();
          } catch (error) {
            failed(error);
            throw error;
          }
          saveError = null;
          queueSave({ force: true, immediate: true });
          publish();
          await methods.flush();
          return snapshot();
        })().finally(() => {
          recovery = null;
        });
      }
      return recovery;
    },
  };
  trace?.subscribe?.(() => {
    return notify({ persist: false });
  });
  return methods;

  // SUPPORTING HELPERS: declarations stay in the same scope.

  function resultHistory(result, { briefing = false } = {}) {
    if (!result) {
      return result;
    }
    const recordId = briefing
      ? (result.executionId ?? null)
      : (result.requestId ?? null);
    const taskId = briefing ? (result.taskId ?? result.jobId ?? null) : null;
    const earlierVisit = restoredResults.has(
      result.requestId ?? result.jobId ?? result.id,
    );
    let available = null;
    if (recordId && trace?.describe) {
      available = Boolean(trace.describe(recordId)?.detailAvailable);
    } else if (taskId && trace?.list) {
      available =
        trace.list({ taskId, view: "protocol", scope: "all", limit: 1 }).records
          .length > 0;
    } else if (
      taskId &&
      state.jobs.some((job) => {
        return job.id === taskId;
      })
    ) {
      available = true;
    } else if (!recordId && !taskId) {
      available = false;
    }
    return {
      ...result,
      executionHistory: {
        available,
        recordId,
        taskId,
        origin: earlierVisit ? "earlier_visit" : "current_visit",
        label:
          available === false
            ? earlierVisit
              ? "Saved result from an earlier visit. Full Execution history is unavailable."
              : "Full Execution history is unavailable. The saved result is retained."
            : available
              ? "Execution history available."
              : "Execution history availability is unknown.",
      },
    };
  }

  async function cache(data) {
    if (!file) {
      return;
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.next`, data, { mode: 0o600 });
    const { rename } = await import("node:fs/promises");
    await rename(`${file}.next`, file);
  }

  function failed(error) {
    saveError = error;
    const durable = persistence?.status();
    persistenceState = {
      ...persistenceState,
      ...durable,
      phase: error.code === "STORAGE_CONFLICT" ? "conflict" : "failed",
      error: {
        ...durable?.error,
        code: error.code ?? "STORAGE_UNAVAILABLE",
        message: persistence
          ? error.message
          : "The local save failed. Your pending edits remain in this process.",
      },
    };
    publish();
    trace?.record("storage", {
      action: "save_failed",
      code: persistenceState.error.code,
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
      ...(error.brokerCode ? { brokerCode: error.brokerCode } : {}),
      error: persistenceState.error.message,
    });
  }

  function queueSave({ immediate = false, force = false } = {}) {
    if (config.readiness || (!file && !persistence)) {
      return;
    }
    const data = JSON.stringify(persistence ? hostedProjection(state) : state);
    if (!force && data === lastProjection) {
      return;
    }
    lastProjection = data;
    pendingSave = data;
    if (saveError || saveRunning) {
      return;
    }
    persistenceState = { ...persistenceState, phase: "pending", error: null };
    if (!persistence || immediate) {
      startSave();
    } else if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        startSave();
      }, config.persistenceDebounceMs ?? 500);
      saveTimer.unref?.();
    }
  }

  function startSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (saveError || saveRunning || pendingSave === null) {
      return;
    }
    persistenceState = { ...persistenceState, phase: "saving", error: null };
    saveRunning = true;
    publish();
    saving = saving
      .then(async () => {
        while (pendingSave !== null && !saveError) {
          const data = pendingSave;
          pendingSave = null;
          try {
            if (persistence) {
              await persistence.save(JSON.parse(data));
              persistenceState = {
                ...persistenceState,
                ...persistence.status(),
                phase: "saving",
              };
            }
            try {
              await cache(data);
              delete persistenceState.cacheError;
            } catch (error) {
              if (!persistence) {
                throw error;
              }
              // A cache error cannot undo a confirmed broker acknowledgement.
              persistenceState.cacheError =
                "The runtime cache could not be written; the hosted save is durable.";
            }
            persistenceState = {
              ...persistenceState,
              phase: pendingSave === null ? "saved" : "saving",
              error: null,
            };
            publish();
          } catch (error) {
            pendingSave ??= data;
            if (persistence) {
              await cache(pendingSave).catch(() => {});
            }
            failed(error);
          }
        }
      })
      .finally(() => {
        saveRunning = false;
      });
  }

  function notify({ persist = true, urgent = false } = {}) {
    if (persist) {
      mutationVersion++;
      const action = actionMutations.getStore();
      if (action?.active) {
        action.changed = true;
      }
      queueSave({ immediate: urgent });
    }
    publish();
  }

  function writable() {
    if (config.readiness) {
      throw Object.assign(
        new Error("Readiness is offline and cannot save visitor data."),
        { code: "READINESS_ONLY" },
      );
    }
  }

  function requireStory(id) {
    const story = find(id);
    if (!story) {
      throw new Error("That story slot no longer exists.");
    }
    return story;
  }

  function vacantFrame(frame) {
    if (frame) {
      return normalizeFrame(frame);
    }
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 3; col++) {
        const candidate = normalizeFrame({
          x: 12 + col * 90,
          y: 46 + row * 86,
          width: 84,
          height: 78,
        });
        if (
          !state.issue.stories.some((story) => {
            return overlap(story.frame, candidate);
          })
        ) {
          return candidate;
        }
      }
    }
    throw new Error("The page is full. Move or remove a story to make space.");
  }
}

// SUPPORTING HELPERS: declarations stay in the same scope.

// Streaming activity belongs in the live view and Execution. Persist the
// edition, approved preferences and terminal results, without repeatedly
// writing token progress, job budgets or a previous visit's funding selection.
function hostedProjection(state) {
  const { jobs, approvals, inferenceSelection, inferenceActivity, ...saved } = state;
  const receipt = (value) => {
    return value?.status === "running"
      ? {
          requestId: value.requestId,
          status: "interrupted",
          startedAt: value.startedAt,
          reason: value.reason,
          inputRevision: value.inputRevision,
          error: "The process stopped before this editorial review finished.",
        }
      : value;
  };
  return {
    ...saved,
    jobs: [],
    approvals: [],
    briefings: state.briefings.map((briefing) => {
      return unfinished.has(briefing.status)
        ? {
            id: briefing.id,
            jobId: briefing.jobId,
            issueId: briefing.issueId,
            prompt: briefing.prompt,
            createdAt: briefing.createdAt,
            status: "interrupted",
            phase: "interrupted",
            turn: 0,
            maxTurns: briefing.maxTurns,
            answer: "",
            partialText: "",
            cards: briefing.cards,
          }
        : briefing;
    }),
    ...(Object.hasOwn(state, "editorial")
      ? { editorial: receipt(state.editorial) }
      : {}),
    ...(state.editorialHistory
      ? { editorialHistory: state.editorialHistory.map(receipt) }
      : {}),
    autoResearchRuns: (state.autoResearchRuns ?? []).map((run) => {
      return unfinished.has(run.status)
        ? {
            ...run,
            status: "interrupted",
            resumable: Boolean(state.autoResearchCheckpoints?.[run.id]),
            stopReason:
              "The process stopped. Kept copy is retained; resume the saved step explicitly.",
          }
        : run;
    }),
  };
}

// Small test traces need the same bounded projection as the archive-backed trace.
function recentTrace(trace) {
  if (trace?.recent) {
    return trace.recent({ limit: 50, view: "teaching" });
  }
  return (trace?.entries ?? []).slice(-50).map((entry) => {
    return Object.fromEntries(
      [
        "id",
        "sequence",
        "kind",
        "actor",
        "parentId",
        "jobId",
        "taskId",
        "requestId",
        "status",
        "startedAt",
        "endedAt",
        "durationMs",
        "method",
        "tool",
        "action",
      ]
        .filter((key) => {
          return entry[key] !== undefined;
        })
        .map((key) => {
          return [key, entry[key]];
        }),
    );
  });
}

function executionSummary(trace) {
  if (trace?.summary) {
    return trace.summary();
  }
  const records = trace?.entries ?? [];
  return {
    totalRecords: records.length,
    teachingRecords: records.length,
    latestSequence: records.at(-1)?.sequence ?? records.length,
    requestCount: records.filter((entry) => {
      return entry.kind === "model.request" || entry.kind === "decision.request";
    }).length,
    reportedCostUsd: null,
    capture: { status: "complete", droppedRecords: 0, errors: [] },
  };
}

export function normalizeFrame(frame = {}) {
  const width = Math.min(273, Math.max(45, Number(frame.width) || 84));
  const height = Math.min(350, Math.max(36, Number(frame.height) || 78));
  return {
    x: Math.min(285 - width, Math.max(12, Number(frame.x) || 12)),
    y: Math.min(404 - height, Math.max(44, Number(frame.y) || 44)),
    width,
    height,
  };
}

export function storyWordBudget(frame) {
  return Math.max(
    30,
    Math.min(
      260,
      Math.floor((((frame.width - 8) / 1.7) * ((frame.height - 23) / 4.8)) / 6),
    ),
  );
}
