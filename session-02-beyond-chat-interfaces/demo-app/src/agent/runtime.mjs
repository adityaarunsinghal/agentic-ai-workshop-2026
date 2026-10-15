// LEARNING: Follow a commissioned story or briefing through Pi, MCP, and copy fitting.
// Start: createResearchAgent(), then requestStory()/requestBriefing() and run().
// Next: gateway.mjs for model I/O; story.mjs and briefing.mjs for task data.

import { Agent } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import PQueue from "p-queue";
import { storyWordBudget } from "../domain/store.mjs";
import { simulatedSource } from "./fixture.mjs";
import { taskAllowsTool } from "../mcp/access.mjs";
import {
  briefingInstructions,
  buildBriefingContext,
  normalizeBriefing,
  recommendationCards,
} from "./briefing.mjs";
import { copyFitError, copyFitInstruction, MAX_FIT_REWRITES } from "./copy-fit.mjs";
import {
  currentRenderedEpisode,
  matchesRenderedCopy,
  MAX_RENDERED_FIT_PASSES,
  renderedFitMessage,
  renderedFitTarget,
} from "./rendered-fit.mjs";
import {
  abortable,
  correlation,
  errorInfo,
  inspectable,
  integer,
  requireText,
  requireTrace,
  ResearchError,
  turnLimit,
} from "./policy.mjs";
import {
  buildStoryContext,
  buildResizeContext,
  findSlot,
  fitDraft,
  isModelTool,
  mcpOutput,
  modelToolResult,
  normalizeDraft,
  normalizeResizeDraft,
  observeSources,
  proseExplanation,
  resizeInstructions,
  sourceContext,
  storyBudget,
  storyInstructions,
  validateDraft,
} from "./story.mjs";

const TERMINAL = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "superseded",
]);
const userMessage = (content) => {
  return { role: "user", content, timestamp: Date.now() };
};

// MAIN BEHAVIOR: create the shared runtime, then follow a request inside it.

/** Pi owns the loop. Briefings and slot-bound stories share the queue and gateway. */
export function createResearchAgent({ store, mcp, trace, gateway, config = {} } = {}) {
  requireTrace(trace);
  for (const method of ["snapshot", "startJob", "updateJob", "completeStory", "update"])
    if (typeof store?.[method] !== "function") {
      throw new ResearchError("INTERFACE", `store.${method} is required.`);
    }
  for (const method of ["listTools", "callTool"])
    if (typeof mcp?.[method] !== "function") {
      throw new ResearchError("INTERFACE", `mcp.${method} is required.`);
    }
  if (typeof gateway?.createConversation !== "function") {
    throw new ResearchError("INTERFACE", "gateway.createConversation is required.");
  }
  const concurrency =
    config.concurrency === undefined
      ? Infinity
      : integer(config.concurrency, "concurrency", 1, 32);
  const maxQueue = integer(config.maxQueue ?? 8, "maxQueue", 0, 32);
  const maxSources = integer(config.maxSources ?? 24, "maxSources", 1, 80);
  const maxResultBytes = integer(
    config.maxToolResultBytes ?? 131_072,
    "maxToolResultBytes",
    1024,
    1_048_576,
  );
  const configuredTurns = turnLimit(config.maxTurns ?? gateway.maxTurns);
  const measure =
    config.measureStoryBudget ??
    ((frame) => {
      return {
        maxWords: storyWordBudget(frame),
        estimated: true,
      };
    });
  const measureFor = (job) => {
    return Number.isSafeInteger(job.resize?.measuredMaxWords)
      ? (frame) => {
          return {
            ...storyBudget(frame, measure),
            maxWords: Math.min(
              storyBudget(frame, measure).maxWords,
              job.resize.measuredMaxWords,
            ),
            estimated: true,
            basis: "rendered_space",
          };
        }
      : measure;
  };
  const queue = new PQueue({ concurrency, autoStart: false });
  const jobs = new Map();
  const pendingResizes = new Map();
  let closed = false;
  const inContext = (data, fn) => {
    return trace.withContext ? trace.withContext(data, fn) : fn();
  };

  // MAIN BEHAVIOR: follow admission, execution, and the resulting copy.

  function requestStory({ slotId, prompt, resize } = {}) {
    if (closed) {
      throw new ResearchError("CLOSED", "The research runtime is closed.");
    }
    slotId = requireText(slotId, "slotId", 256);
    prompt = requireText(prompt, "Story prompt");
    const before = store.snapshot();
    const slot = findSlot(before, slotId);
    if (!slot) {
      throw new ResearchError(
        "SLOT_MISSING",
        "Reserve a fixed story slot before requesting research.",
      );
    }
    if (slot.locked) {
      throw new ResearchError(
        "SLOT_LOCKED",
        "Unlock this story before requesting new copy.",
      );
    }
    // An explicit retry of the same commission resumes its grounded candidate.
    // A different prompt remains a new research request.
    if (!resize && slot.prompt === prompt) {
      resize = retainedFit(before, slot);
    }
    const rendered = currentRenderedEpisode(slot);
    let retriedRenderedEpisode;
    if (
      (!resize || resize.resumedFrom) &&
      rendered?.status === "needs_fit" &&
      slot.prompt === prompt
    ) {
      if (!Number.isSafeInteger(rendered.maxWords) || rendered.maxWords < 1) {
        throw new ResearchError(
          "STORY_FIT",
          rendered.message ?? renderedFitMessage("space"),
        );
      }
      const episode = {
        ...rendered,
        id: randomUUID(),
        attempts: 1,
        status: "fitting",
        fingerprint: null,
        message: null,
      };
      retriedRenderedEpisode = episode;
      resize = {
        ...(resize ?? {
          headline: slot.headline,
          body: slot.body,
          sourceIds: [...slot.sourceIds],
        }),
        frame: structuredClone(slot.frame),
        measuredMaxWords: rendered.maxWords,
        renderedEpisodeId: episode.id,
      };
    }
    const layout = before.layoutOperation;
    if (
      resize?.renderedEpisodeId &&
      layout?.approvedTemplate === before.issue.layoutTemplate &&
      layout?.approvedTemplate &&
      !["superseded", "declined"].includes(layout.status)
    ) {
      resize = { ...resize, layoutOperationId: layout.id };
    }
    const model = selectedTaskModel(before);
    const maxTurns = Math.min(
      configuredTurns,
      turnLimit(before.settings?.maxTurns ?? configuredTurns),
      resize ? 1 + MAX_FIT_REWRITES : Infinity,
    );
    gateway.modelFor?.(model);
    storyBudget(slot.frame, measure);
    const previous = activeForSlot(slotId);
    if (queue.size + queue.pending >= concurrency + maxQueue) {
      throw new ResearchError(
        "QUEUE_FULL",
        "The story queue is full. Wait for a request to finish.",
      );
    }
    if (!resize) {
      clearResize(slotId);
    }
    const started = store.startJob({ slotId, prompt });
    if (!started?.id || typeof started.then === "function") {
      throw new ResearchError(
        "INTERFACE",
        "store.startJob must synchronously return a job with an id.",
      );
    }
    const reserved = findSlot(store.snapshot(), slotId);
    const requestId = started.requestId ?? reserved?.requestId;
    if (!requestId || requestId !== started.id || reserved?.id !== slot.id) {
      throw new ResearchError(
        "INTERFACE",
        "store.startJob must bind the slot requestId to the returned job id.",
      );
    }
    if (!resize && reserved.prompt !== prompt) {
      store.update(
        (issue) => {
          const current = issue.stories.find((story) => {
            return story.slotId === slotId;
          });
          if (current?.requestId === requestId) {
            current.prompt = prompt;
          }
        },
        {
          kind: "agent",
          action: "story_prompt_recorded",
          history: false,
          data: { slotId, requestId, prompt },
        },
      );
    }
    if (previous) {
      invalidate(previous, "superseded", "A newer prompt replaced this story request.");
    }
    const parentId = trace.context?.().parentId ?? trace.current?.id ?? null;
    const span = trace.start("story", {
      actor: "agent",
      parentId,
      jobId: started.id,
      requestId,
      slotId,
      issueId: before.issue.id,
      issueRevision: before.issue.revision,
      prompt,
      frame: slot.frame,
      baseContentVersion: started.baseContentVersion ?? slot.contentVersion,
      ...(resize
        ? {
            purpose: resize.renderedEpisodeId
              ? "Fit copy to rendered space"
              : resize.resumedFrom
                ? "Retry copy fitting"
                : "Fit copy after resize",
            operation: "resize",
            ...(resize.resumedFrom ? { resumedFrom: resize.resumedFrom } : {}),
          }
        : {}),
    });
    const job = {
      ...started,
      type: "story",
      requestId,
      issueId: before.issue.id,
      storyId: slot.id,
      baseContentVersion: started.baseContentVersion ?? slot.contentVersion,
      parentId: span.id,
      prompt,
      status: "queued",
      span,
      model,
      maxTurns,
      controller: new AbortController(),
      evidence: new Map(),
      rewrites: 0,
      written: null,
      lastDraft: null,
      pendingMessage: null,
      resize,
      fitting: Boolean(resize),
      researchContinuations: 0,
    };
    if (retriedRenderedEpisode) {
      saveRenderedEpisode(reserved, { ...retriedRenderedEpisode, jobId: job.id });
    }
    return enqueue(job);
  }

  function requestBriefing({ prompt } = {}) {
    if (closed) {
      throw new ResearchError("CLOSED", "The research runtime is closed.");
    }
    prompt = requireText(prompt, "Briefing prompt");
    if (typeof store.startBriefing !== "function") {
      throw new ResearchError(
        "INTERFACE",
        "store.startBriefing is required for a briefing.",
      );
    }
    const before = store.snapshot();
    const model = selectedTaskModel(before);
    const maxTurns = Math.min(
      configuredTurns,
      turnLimit(before.settings?.maxTurns ?? configuredTurns),
    );
    gateway.modelFor?.(model);
    if (queue.size + queue.pending >= concurrency + maxQueue) {
      throw new ResearchError(
        "QUEUE_FULL",
        "The research queue is full. Wait for a request to finish.",
      );
    }
    const started = store.startBriefing({ prompt });
    if (!started?.id || typeof started.then === "function") {
      throw new ResearchError(
        "INTERFACE",
        "store.startBriefing must synchronously return a job with an id.",
      );
    }
    const span = trace.start("briefing", {
      actor: "agent",
      parentId: trace.context?.().parentId ?? null,
      jobId: started.id,
      requestId: started.id,
      issueId: before.issue.id,
      prompt,
    });
    const job = {
      ...started,
      type: "briefing",
      requestId: started.id,
      issueId: before.issue.id,
      parentId: span.id,
      prompt,
      status: "queued",
      span,
      model,
      maxTurns,
      controller: new AbortController(),
      evidence: new Map(),
    };
    return enqueue(job);
  }

  function enqueue(job) {
    jobs.set(job.id, job);
    const descriptor = {
      id: job.id,
      requestId: job.requestId,
      type: job.type,
      issueId: job.issueId,
      parentId: job.parentId,
      prompt: job.prompt,
      ...(job.slotId
        ? { slotId: job.slotId, baseContentVersion: job.baseContentVersion }
        : {}),
      ...(job.resize ? { operation: "resize" } : {}),
      startedAt: job.startedAt,
      status: "queued",
      phase: "queued",
      turn: 0,
      maxTurns: job.maxTurns,
      model: job.model,
      profileId: gateway.profileId,
      actor: "agent",
    };
    store.updateJob(job.id, descriptor);
    trace.record(
      `${job.type}.queued`,
      correlation(job, {
        prompt: job.prompt,
        pending: queue.pending,
        queued: queue.size + 1,
      }),
    );
    void queue
      .add(
        () => {
          return run(job);
        },
        { id: job.id, signal: job.controller.signal },
      )
      .catch((error) => {
        if (!TERMINAL.has(job.status)) {
          finish(job, "failed", { error: errorInfo(error, config) });
        }
      });
    queueMicrotask(() => {
      return queue.start();
    });
    return descriptor;
  }

  async function run(job) {
    let unsubscribe;
    try {
      const initial = owned(job);
      if (job.resize) {
        if (initial.slot.contentVersion !== job.baseContentVersion) {
          throw new ResearchError(
            "SUPERSEDED",
            "The copy changed before its resize request started.",
          );
        }
        job.resize.frame = structuredClone(initial.slot.frame);
        const pending = pendingResizes.get(job.slotId);
        if (
          pending?.contentVersion === job.baseContentVersion &&
          pending.frame.width === initial.slot.frame.width &&
          pending.frame.height === initial.slot.frame.height
        ) {
          clearResize(job.slotId);
        }
      }
      job.status = "running";
      progress(job, {
        status: job.resize ? "writing" : "running",
        phase: job.resize ? "resizing" : "discovering",
        turn: 0,
      });
      trace.record(
        `${job.type}.admitted`,
        correlation(job, { pending: queue.pending, queued: queue.size }),
      );
      if (gateway.mode === "fixture" && job.type === "story" && !job.resize) {
        const source = simulatedSource(job);
        store.update(
          (issue) => {
            if (
              !issue.sources.some((entry) => {
                return entry.id === source.id;
              })
            ) {
              issue.sources.push(source);
            }
          },
          {
            kind: "agent",
            action: "simulated_evidence_added",
            history: false,
            data: { ...correlation(job), source },
          },
        );
        job.fixtureSourceId = source.id;
      }
      const { snapshot } = owned(job);
      const pool = job.resize
        ? snapshot.issue.sources.filter((source) => {
            return job.resize.sourceIds.includes(source.id);
          })
        : snapshot.issue.sources
            .filter((source) => {
              return source.id === job.fixtureSourceId;
            })
            .slice(0, maxSources);
      for (const source of pool) {
        job.evidence.set(source.id, structuredClone(source));
      }
      progress(job, { sourceIds: [...job.evidence.keys()] });
      let declarations = [];
      if (!job.resize) {
        const discovery = trace.start("mcp.list", correlation(job, { actor: "agent" }));
        try {
          const meta = { ...correlation(job), actor: "agent" };
          const listed = await abortable(
            inContext(meta, () => {
              return mcp.listTools(meta);
            }),
            job.controller.signal,
          );
          discovery.finish({ status: "complete", result: listed });
          declarations = selectTaskTools(listed, job.type);
        } catch (error) {
          discovery.finish({ status: "failed", error: errorInfo(error, config) });
          throw error;
        }
      }
      owned(job);
      const names = new Set();
      for (const declaration of declarations) {
        if (
          !declaration.name ||
          !declaration.inputSchema ||
          names.has(declaration.name)
        ) {
          throw new ResearchError(
            "MCP_DISCOVERY",
            "MCP tool declarations need unique names and input schemas.",
          );
        }
        names.add(declaration.name);
      }
      trace.record("mcp.exposure", correlation(job, { toolNames: [...names] }));
      if (gateway.ready) {
        const selection = await abortable(gateway.ready(), job.controller.signal);
        owned(job);
        if (
          ["development", "hosted"].includes(gateway.mode) &&
          selection.model !== job.model
        ) {
          throw new ResearchError(
            "MODEL_CHANGED",
            "The workshop selection changed after this request was queued.",
          );
        }
      }
      job.conversation = gateway.createConversation({
        model: job.model,
        maxTurns: job.maxTurns,
        jobId: job.id,
        requestId: job.requestId,
        parentId: job.parentId,
        signal: job.controller.signal,
        purpose: job.resize?.renderedEpisodeId
          ? "Fit copy to measured rendered space"
          : job.resize
            ? "Fit copy after resize"
            : job.type === "briefing"
              ? "Research briefing"
              : "Story research",
      });
      job.maxTurns = job.conversation.maxTurns;
      job.agent = prepareAgent(job, declarations);
      unsubscribe = job.agent.subscribe((event) => {
        return subscribe(job, event);
      });
      const buildContext = job.resize
        ? buildResizeContext
        : job.type === "briefing"
          ? buildBriefingContext
          : buildStoryContext;
      const context = buildContext({
        job,
        snapshot,
        pool,
        measure: measureFor(job),
        simulated: gateway.mode === "fixture",
      });
      const heading = job.resize
        ? "Resize request"
        : job.type === "briefing"
          ? "Briefing request"
          : "Story request";
      await abortable(
        job.agent.prompt(userMessage(`${heading}:\n${JSON.stringify(context)}`)),
        job.controller.signal,
      );
      const current = owned(job);
      if (
        job.type === "story" &&
        (job.written?.result.applied || job.outcome?.applied)
      ) {
        // Geometry can change while the MCP write or save acknowledgement returns.
        // A draft fitted to the old frame must not be announced as fitting the new one.
        job.lastFit = fitDraft(
          job.written?.draft ?? job.lastDraft,
          current.slot.frame,
          measureFor(job),
        );
        if (job.lastFit.status === "overflow") {
          throw copyFitError(job.lastFit);
        }
      }
      if (job.type === "briefing") {
        if (!job.briefing) {
          throw (
            job.error ??
            new ResearchError("BRIEFING", "Research did not produce a briefing answer.")
          );
        }
        finish(job, "completed", { phase: "completed", ...job.briefing });
      } else if (job.written) {
        finish(job, "completed", {
          phase: job.written.result.alternate ? "alternate" : "completed",
          outcome: job.written.result,
          generatedDraft: job.written.draft,
        });
      } else if (job.outcome?.superseded) {
        finish(job, "superseded", {
          phase: "superseded",
          reason: "A newer resize changed the requested space.",
          retainedDraft: job.lastDraft,
        });
      } else if (job.outcome?.applied || job.outcome?.alternate) {
        finish(job, "completed", {
          phase: job.outcome.alternate
            ? "alternate"
            : job.resize?.renderedEpisodeId
              ? "awaiting_render"
              : "completed",
          outcome: job.outcome,
          generatedDraft: job.lastDraft,
        });
      } else {
        throw (
          job.error ??
          new ResearchError("EVIDENCE", "Research did not produce a supported story.")
        );
      }
      settleRenderedJob(job);
      if (
        (job.written?.result.applied || job.outcome?.applied) &&
        !pendingResizes.has(job.slotId)
      ) {
        reviewCompletedCopy(
          job,
          job.resize ? "Review resized copy and typography" : "Completed draft review",
        );
      }
    } catch (error) {
      if (TERMINAL.has(job.status)) {
        return;
      }
      if (error.code === "SUPERSEDED") {
        finish(job, "superseded", { phase: "superseded", reason: error.message });
      } else {
        const failure = errorInfo(error, config);
        const needsFit =
          error.code === "STORY_FIT" ||
          job.lastFit?.status === "overflow" ||
          Boolean(job.resize?.renderedEpisodeId);
        const fallback = {
          headline: needsFit ? "Copy needs fitting" : "Research incomplete",
          body: needsFit
            ? failure.message
            : `A supported story could not be completed. ${failure.message} ` +
              (job.evidence.size
                ? "The collected evidence remains available for review."
                : "No supporting sources were observed."),
          sourceIds: [...job.evidence.keys()],
          generated: false,
        };
        finish(job, "incomplete", {
          phase: needsFit ? "needs_fit" : "incomplete",
          error: failure,
          fallback,
          ...(needsFit
            ? {
                fit: job.lastFit,
                fitAttempts: job.rewrites,
                recovery: {
                  action: "fit_copy",
                  message: "Enlarge the block, shorten its copy, or retry fitting.",
                },
              }
            : {}),
          ...(job.explanation
            ? { explanation: job.explanation, answer: job.explanation }
            : {}),
          ...(job.type === "briefing"
            ? {
                answer:
                  `This briefing could not be completed. ${failure.message} ` +
                  "Any observed recommendations remain available for review.",
              }
            : {}),
          ...(job.lastDraft ? { retainedDraft: job.lastDraft } : {}),
        });
        const current = findSlot(store.snapshot(), job.slotId);
        if (current?.requestId === job.requestId) {
          store.update(
            (issue) => {
              const slot = issue.stories.find((story) => {
                return story.slotId === job.slotId;
              });
              const ownAppliedCopy =
                slot?.contentVersion === job.baseContentVersion + 1 &&
                slot.body === job.lastDraft?.body &&
                (job.written?.result.applied || job.outcome?.applied);
              if (
                slot?.requestId !== job.requestId ||
                (slot.contentVersion !== job.baseContentVersion && !ownAppliedCopy)
              ) {
                return;
              }
              slot.researchNote = job.explanation || failure.message;
              if (needsFit) {
                slot.status = "needs_fit";
              }
            },
            {
              action: "research_explanation_retained",
              history: false,
              data: correlation(job),
            },
          );
        }
      }
    } finally {
      if (job.status !== "completed") {
        settleRenderedJob(job);
      }
      unsubscribe?.();
      job.agent?.clearAllQueues();
      job.agent = null;
      const pending = pendingResizes.get(job.slotId);
      if (pending) {
        const current = findSlot(store.snapshot(), job.slotId);
        if (
          (job.written?.result.applied || job.outcome?.applied) &&
          pending.contentVersion === job.baseContentVersion &&
          current?.contentVersion === job.baseContentVersion + 1
        ) {
          pending.contentVersion = current.contentVersion;
        }
        clearTimeout(pending.timer);
        pending.timer = setTimeout(
          () => {
            return dispatchResize(pending);
          },
          Math.max(0, pending.notBefore - Date.now()),
        );
        pending.timer.unref?.();
      }
    }
  }

  /** The native Pi composition remains comparable to Session 1's prepareAgent. */
  function prepareAgent(job, declarations) {
    const tools = declarations.map((tool) => {
      return {
        name: tool.name,
        label: tool.title ?? tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
        execute: (id, args, signal) => {
          return executeTool(job, tool, id, args, signal);
        },
      };
    });
    const names = new Set(
      tools.map((tool) => {
        return tool.name;
      }),
    );
    return new Agent({
      initialState: {
        model: job.conversation.model,
        systemPrompt: job.resize
          ? resizeInstructions.replace(
              "using one response and no tools",
              "using no tools; a failed fit can receive a bounded correction",
            )
          : job.type === "briefing"
            ? briefingInstructions
            : storyInstructions,
        tools,
      },
      streamFn: job.conversation.streamFn,
      toolExecution: "sequential",
      prepareRequest: (request) => {
        return prepareTaskRequest(job, request, tools);
      },
      beforeToolCall: (call) => {
        return authorizeTaskTool(job, call, names);
      },
      finishTurn: (turn) => {
        return finishTurn(job, turn);
      },
      prepareNextTurnWithContext: () => {
        return prepareNextTaskTurn(job);
      },
    });
  }

  /** Pi's prepareRequest hook keeps the final answer inside this task's allowance. */
  function prepareTaskRequest(job, { context }, tools) {
    owned(job);
    const nextTurn = job.conversation.turns + 1;
    if (nextTurn > job.maxTurns) {
      throw new ResearchError(
        "TURN_LIMIT",
        `This run allows at most ${job.maxTurns} conversational turns.`,
      );
    }
    progress(job, {
      status: job.fitting ? "writing" : "running",
      phase: job.fitting ? "fitting" : "generating",
      turn: nextTurn,
    });
    if (
      job.fitting &&
      (nextTurn === job.maxTurns || job.rewrites === MAX_FIT_REWRITES)
    ) {
      job.conversation.finishNext("copy_fit");
    }
    const reason = job.conversation.finalTurnReason;
    if (!reason && !job.fitting) {
      return;
    }
    if (reason) {
      job.conversation.finishNext(reason);
    }
    const instruction =
      {
        copy_fit: "This is the final copy-fit pass for the current slot.",
        remaining_allowance:
          "Use the reserved final response within the remaining inference allowance.",
        max_turns: `This is the last of at most ${job.maxTurns} conversational turns.`,
      }[reason] ??
      "Fit this copy to its current slot using only the evidence already available.";
    const final = {
      role: "system",
      timestamp: Date.now(),
      content:
        `${instruction} Tools are disabled. ` +
        (job.type === "briefing"
          ? "Give a concise briefing using observed links, or honestly explain the missing evidence."
          : "Return the grounded draft as {headline,body,sourceIds} JSON, or honestly explain the missing evidence."),
      toolsRemoved: tools.map((tool) => {
        return { name: tool.name };
      }),
    };
    trace.record(
      reason ? "agent.final_turn" : "agent.copy_fit",
      correlation(job, {
        turn: nextTurn,
        maxTurns: job.maxTurns,
        toolsDisabled: true,
        reason: reason ?? "copy_fit",
        label:
          {
            copy_fit: "Final copy fit: tools disabled",
            remaining_allowance:
              "Final response within remaining allowance: tools disabled",
            max_turns: "Maximum turns reached: tools disabled",
          }[reason] ?? "Copy fit: tools disabled",
      }),
    );
    return {
      context: { ...context, tools: [], messages: [...context.messages, final] },
    };
  }

  /** Like Session 1's beforeToolCall, this grants authority independently of prose. */
  async function authorizeTaskTool(job, { toolCall }, names) {
    try {
      owned(job);
      if (
        job.fitting ||
        job.conversation.finalSent ||
        job.conversation.turns >= job.maxTurns
      ) {
        throw new ResearchError(
          "TURN_LIMIT",
          "No tools may run during copy fitting or on the final turn.",
        );
      }
      if (!names.has(toolCall.name) || !taskAllowsTool(toolCall.name, job.type)) {
        throw new ResearchError(
          "TOOL_AUTHORITY",
          "This task may use only its discovered, authorized MCP tools.",
        );
      }
    } catch (error) {
      trace.record(
        "tool.blocked",
        correlation(job, { tool: toolCall.name, error: errorInfo(error, config) }),
      );
      return { block: true, terminate: true, reason: errorInfo(error, config).message };
    }
  }

  async function executeTool(job, tool, callId, args, signal) {
    const { snapshot, slot } = owned(job);
    if (
      job.fitting ||
      job.conversation.finalSent ||
      job.conversation.turns >= job.maxTurns
    ) {
      throw new ResearchError(
        "TURN_LIMIT",
        "Tools are disabled during copy fitting and the final conversational turn.",
      );
    }
    let draft;
    if (tool.name === "propose_briefing") {
      if (
        args.frame ||
        args.recommendations?.some((item) => {
          return item.frame;
        })
      ) {
        throw new ResearchError(
          "SLOT_AUTHORITY",
          "A briefing cannot reserve newspaper geometry.",
        );
      }
      recommendationCards(
        args.recommendations ??
          args.sourceIds?.map((sourceId) => {
            return { sourceId };
          }),
        job.evidence,
        snapshot,
      );
    }
    if (tool.name === "write_story") {
      bindWrite(job, args);
      draft = validateDraft(args, job.evidence, snapshot);
      job.lastDraft = draft;
      const fit = fitDraft(draft, slot.frame, measure);
      trace.record(
        "story.fit",
        correlation(job, { fit, frame: slot.frame, origin: "write_story" }),
      );
      if (fit.status === "overflow") {
        const error = copyFitError(fit);
        if (!scheduleFitRewrite(job, fit, slot.frame)) {
          job.error = error;
        }
        throw error;
      }
      if (slot.locked) {
        throw new ResearchError(
          "SLOT_LOCKED",
          "The editor locked this slot while research was running.",
        );
      }
    }
    const span = trace.start(
      "mcp.call",
      correlation(job, {
        actor: "agent",
        turn: job.conversation.turns,
        tool: tool.name,
        toolCallId: callId,
        args,
      }),
    );
    const phase = [
      "write_story",
      "propose_briefing",
      "save_reading_list",
      "remember_preferences",
    ].includes(tool.name)
      ? "writing"
      : /^(?:read_|fetch_|get_|inspect_)/u.test(tool.name)
        ? "reading"
        : tool.name === "list_stories" || tool.name.startsWith("search_")
          ? "searching"
          : "working";
    progress(job, {
      status:
        phase === "writing"
          ? "writing"
          : phase === "reading"
            ? "reading"
            : phase === "searching"
              ? "researching"
              : "running",
      phase,
      tool: tool.name,
    });
    const call = (async () => {
      try {
        // The MCP service owns validation, permissions, source storage and side effects.
        const meta = {
          ...correlation(job),
          actor: "agent",
          parentId: span.id,
          turn: job.conversation.turns,
          signal,
        };
        const result = await inContext(meta, () => {
          return mcp.callTool(tool.name, args, meta);
        });
        span.finish({
          status: result.isError ? "failed" : "complete",
          result: {
            content: result.content,
            data: mcpOutput(result),
            isError: result.isError === true,
          },
        });
        return result;
      } catch (error) {
        span.finish({ status: "failed", error: errorInfo(error, config) });
        throw error;
      }
    })();
    const result = await abortable(call, signal);
    owned(job); // Do not feed a late result into a cancelled or replaced conversation.
    observeSources(result, args, store.snapshot(), job.evidence);
    progress(job, { sourceIds: [...job.evidence.keys()] });
    const mapped = modelToolResult(result);
    if (Buffer.byteLength(JSON.stringify(mapped.content)) > maxResultBytes) {
      throw new ResearchError(
        "TOOL_RESULT_LIMIT",
        "This complete MCP result is too large. Request fewer records; nothing was shortened.",
      );
    }
    if (draft && !result.isError) {
      const output = mcpOutput(result);
      if (output.applied === true || output.alternate === true) {
        job.written = { draft, result: output };
        trace.record(
          "story.written",
          correlation(job, { sourceIds: draft.sourceIds, result: output }),
        );
      } else {
        trace.record("story.write_unapplied", correlation(job, { result: output }));
      }
    }
    return mapped;
  }

  async function finishTurn(job, { message }) {
    job.lastMessage = message;
    progress(job, {
      turn: job.conversation.turns,
      requestCount: job.conversation.requests,
      operationIds: job.conversation.operationIds,
      usage: job.conversation.usage,
    });
    if (["error", "aborted"].includes(message.stopReason)) {
      job.error = Object.assign(
        new ResearchError(
          message.errorCode ??
            (message.stopReason === "aborted" ? "ABORTED" : "INFERENCE_FAILED"),
          message.errorMessage ?? "Inference failed.",
        ),
        message.errorDetails,
      );
      return { action: "end" };
    }
    if (job.written) {
      return { action: "end" };
    }
    if (job.error) {
      return { action: "end" };
    }
    if (
      message.content.some((part) => {
        return part.type === "toolCall";
      })
    ) {
      return job.conversation.turns >= job.maxTurns ? { action: "end" } : undefined;
    }
    if (job.type === "briefing") {
      try {
        const { snapshot } = owned(job);
        const cards =
          snapshot.briefings?.find((entry) => {
            return entry.jobId === job.id;
          })?.cards ?? [];
        job.briefing = normalizeBriefing(message, job.evidence, snapshot, cards);
      } catch (error) {
        job.error = error;
      }
      return { action: "end" };
    }
    try {
      const { snapshot } = owned(job);
      const draft = job.resize
        ? normalizeResizeDraft(message, job.resize)
        : normalizeDraft(message, job.evidence, snapshot);
      job.lastDraft = draft;
      job.outcome = await commitDraft(job, draft);
    } catch (error) {
      if (
        error.code === "STORY_FIT" &&
        scheduleFitRewrite(job, job.lastFit, owned(job).slot.frame)
      ) {
        return { action: "continue" };
      }
      if (
        !job.resize &&
        !job.fitting &&
        ["DRAFT", "EVIDENCE"].includes(error.code) &&
        !job.conversation.finalSent &&
        job.conversation.turns < job.maxTurns &&
        job.researchContinuations < 2
      ) {
        job.researchContinuations++;
        job.pendingMessage = userMessage(
          `The draft has not been applied: ${error.message} ` +
            `There are ${job.maxTurns - job.conversation.turns} turns left in this same request. ` +
            "Continue toward a supported article. Repair the JSON if you already have the evidence. " +
            "For missing evidence, use general web search, broaden or vary the query, and read plausible primary pages and their observed links. " +
            "Empty HN or news results do not establish that a person, course, event, or claim cannot be verified. " +
            "Distinguish people with similar names, workshop instruction from faculty appointments, and current facts from old announcements. " +
            "Return {headline,body,sourceIds} with observed supporting source IDs, or explain the specific evidence still missing after useful research.",
        );
        trace.record(
          "story.research_continued",
          correlation(job, {
            turn: job.conversation.turns,
            remainingTurns: job.maxTurns - job.conversation.turns,
            reason: error.message,
            label: "Continue research or repair the draft",
          }),
        );
        return { action: "continue" };
      }
      if (!job.resize && ["DRAFT", "EVIDENCE"].includes(error.code)) {
        job.explanation = proseExplanation(message);
        if (job.explanation) {
          error = new ResearchError("EVIDENCE_UNRESOLVED", job.explanation);
        }
      }
      job.error = error;
    }
    return { action: "end" };
  }

  async function commitDraft(job, draft) {
    const { snapshot, slot } = owned(job);
    if (!job.resize) {
      validateDraft(draft, job.evidence, snapshot);
    }
    if (
      job.resize &&
      (slot.frame.width !== job.resize.frame.width ||
        slot.frame.height !== job.resize.frame.height)
    ) {
      trace.record(
        "story.resize_superseded",
        correlation(job, {
          reason: "A newer resize changed the requested space.",
          generatedDraft: draft,
        }),
      );
      return { applied: false, superseded: true };
    }
    const fit = fitDraft(draft, slot.frame, measureFor(job));
    job.lastFit = fit;
    trace.record(
      "story.fit",
      correlation(job, { fit, frame: slot.frame, origin: "final_response" }),
    );
    if (fit.status === "overflow") {
      throw copyFitError(fit);
    }
    if (slot.locked) {
      store.update(
        (issue) => {
          const current = issue.stories.find((story) => {
            return story.slotId === job.slotId;
          });
          if (current?.id === job.storyId && current.requestId === job.requestId) {
            current.alternateDraft = {
              ...draft,
              fit,
              requestId: job.requestId,
              reason: "Slot locked during research.",
            };
            current.status = current.body ? "ready" : "draft_available";
          }
        },
        {
          kind: "agent",
          action: "locked_draft_retained",
          history: false,
          data: correlation(job),
        },
      );
      return { applied: false, alternate: true, locked: true, fit };
    }
    if (
      slot.contentVersion === job.baseContentVersion &&
      slot.headline === draft.headline &&
      slot.body === draft.body &&
      JSON.stringify(slot.sourceIds) === JSON.stringify(draft.sourceIds)
    ) {
      store.update(
        (issue) => {
          const current = issue.stories.find((story) => {
            return story.slotId === job.slotId;
          });
          if (
            current?.id !== job.storyId ||
            current.requestId !== job.requestId ||
            current.contentVersion !== job.baseContentVersion
          ) {
            return;
          }
          current.fit = fit;
          current.status = "ready";
          delete current.researchNote;
        },
        {
          kind: "agent",
          action: "draft_unchanged",
          history: false,
          data: correlation(job, { fit }),
        },
      );
      return { applied: true, unchanged: true, fit };
    }
    const result = await store.completeStory({
      slotId: job.slotId,
      requestId: job.requestId,
      baseContentVersion: job.baseContentVersion,
      ...draft,
    });
    const { slot: completed } = owned(job);
    const currentFit = fitDraft(draft, completed.frame, measureFor(job));
    if (result?.applied || result?.alternate) {
      store.update(
        (issue) => {
          const current = issue.stories.find((story) => {
            return story.slotId === job.slotId;
          });
          if (current?.id !== job.storyId || current.requestId !== job.requestId) {
            return;
          }
          if (
            result.applied &&
            current.body === draft.body &&
            current.contentVersion === job.baseContentVersion + 1
          ) {
            current.fit = currentFit;
            delete current.researchNote;
            if (currentFit.status === "overflow") {
              current.status = "overflow";
            }
          } else if (result.alternate && current.alternateDraft?.body === draft.body) {
            current.alternateDraft.fit = currentFit;
          }
        },
        {
          kind: "agent",
          action: "draft_fit_recorded",
          history: false,
          data: correlation(job, { fit: currentFit }),
        },
      );
    }
    trace.record(
      "story.draft",
      correlation(job, {
        headline: draft.headline,
        body: draft.body,
        sourceIds: draft.sourceIds,
        applied: result?.applied ?? null,
        alternate: result?.alternate ?? false,
        fit: currentFit,
      }),
    );
    return {
      applied: result?.applied ?? false,
      alternate: result?.alternate ?? false,
      fit: currentFit,
    };
  }

  function prepareNextTaskTurn(job) {
    if (!job.pendingMessage) {
      return;
    }
    const message = job.pendingMessage;
    job.pendingMessage = null;
    return { messages: [message] };
  }

  function resizeStory({ slotId } = {}) {
    if (closed) {
      throw new ResearchError("CLOSED", "The research runtime is closed.");
    }
    const snapshot = store.snapshot(),
      slot = findSlot(snapshot, slotId);
    if (
      !slot ||
      slot.locked ||
      snapshot.settings.stage === "tools" ||
      (!slot.body && !retainedFit(snapshot, slot) && !activeForSlot(slotId))
    ) {
      return { scheduled: false };
    }
    clearResize(slotId);
    const entry = {
      id: randomUUID(),
      slotId,
      contentVersion: slot.contentVersion,
      context: { ...trace.context?.() },
      frame: structuredClone(slot.frame),
      notBefore: Date.now() + 450,
    };
    pendingResizes.set(slotId, entry);
    entry.timer = setTimeout(() => {
      return dispatchResize(entry);
    }, 450);
    entry.timer.unref?.();
    trace.record("story.resize_scheduled", {
      requestId: entry.id,
      slotId,
      frame: entry.frame,
      contentVersion: entry.contentVersion,
      label: "Fit copy after resize",
      delayMs: 450,
    });
    return { scheduled: true, requestId: entry.id };
  }

  function reportRenderedFit(report) {
    const snapshot = store.snapshot(),
      slot = findSlot(snapshot, report.slotId);
    if (
      closed ||
      report.issueId !== snapshot.issue.id ||
      !slot ||
      slot.locked ||
      !slot.body?.trim() ||
      snapshot.settings.stage === "tools" ||
      !matchesRenderedCopy(slot, report)
    ) {
      return { accepted: false, reason: "stale_or_unavailable" };
    }
    if (
      activeForSlot(slot.slotId) ||
      snapshot.jobs.some((job) => {
        return (
          job.slotId === slot.slotId &&
          [
            "queued",
            "pending",
            "running",
            "researching",
            "reading",
            "writing",
          ].includes(job.status)
        );
      }) ||
      snapshot.editorial?.status === "running"
    ) {
      return { accepted: false, reason: "working" };
    }
    const target = renderedFitTarget(slot, report);
    const previous = currentRenderedEpisode(slot);
    if (previous?.fingerprint === target.fingerprint && previous.status !== "fitting") {
      return { accepted: false, reason: "duplicate", status: previous.status };
    }
    if (previous?.status === "needs_fit" && report.overflow) {
      return { accepted: false, reason: "episode_exhausted", status: "needs_fit" };
    }
    const episode =
      previous && previous.status !== "fit"
        ? { ...previous }
        : {
            id: randomUUID(),
            attempts: 0,
          };
    Object.assign(episode, {
      fingerprint: target.fingerprint,
      requiredHeight: report.requiredHeight,
      maxWords: target.maxWords,
      message: null,
    });
    if (!report.overflow) {
      episode.status = "fit";
      saveRenderedEpisode(slot, episode, { status: "ready" });
      if (episode.jobId) {
        store.updateJob(episode.jobId, {
          status: "completed",
          phase: "completed",
          error: null,
          renderedFit: { status: "fit", episodeId: episode.id },
        });
      }
      return { accepted: true, status: "fit" };
    }
    if (
      !target.roomForLine ||
      target.maxWords < 1 ||
      episode.attempts >= MAX_RENDERED_FIT_PASSES ||
      episode.status === "fitting"
    ) {
      episode.status = "needs_fit";
      episode.message = renderedFitMessage(
        !target.roomForLine || target.maxWords < 1 ? "space" : "attempts",
      );
      if (episode.jobId) {
        store.updateJob(episode.jobId, {
          status: "incomplete",
          phase: "needs_fit",
          renderedFit: { status: "needs_fit", episodeId: episode.id },
        });
      }
      saveRenderedEpisode(slot, episode, {
        status: "needs_fit",
        note: episode.message,
      });
      return { accepted: true, status: "needs_fit" };
    }
    episode.attempts++;
    episode.status = "fitting";
    saveRenderedEpisode(slot, episode);
    try {
      const job = requestStory({
        slotId: slot.slotId,
        prompt: slot.prompt || "Fit the existing story to its rendered space.",
        resize: {
          headline: slot.headline,
          body: slot.body,
          sourceIds: [...slot.sourceIds],
          frame: structuredClone(slot.frame),
          measuredMaxWords: target.maxWords,
          renderedEpisodeId: episode.id,
        },
      });
      saveRenderedEpisode(findSlot(store.snapshot(), slot.slotId), {
        ...episode,
        jobId: job.id,
      });
      return {
        accepted: true,
        status: "fitting",
        jobId: job.id,
        maxWords: target.maxWords,
      };
    } catch (error) {
      episode.status = "needs_fit";
      episode.message = `${errorInfo(error, config).message} ${renderedFitMessage("attempts")}`;
      saveRenderedEpisode(slot, episode, {
        status: "needs_fit",
        note: episode.message,
      });
      return { accepted: true, status: "needs_fit" };
    }
  }

  // SUPPORTING HELPERS: ownership, fitting, progress, and cancellation.

  const activeForSlot = (slotId) => {
    return [...jobs.values()].find((job) => {
      return job.slotId === slotId && !TERMINAL.has(job.status);
    });
  };
  function owned(job) {
    const snapshot = store.snapshot();
    const slot = findSlot(snapshot, job.slotId);
    const storedJob = snapshot.jobs?.find((entry) => {
      return entry.id === job.id;
    });
    if (job.controller.signal.aborted) {
      job.controller.signal.throwIfAborted();
    }
    if (job.type === "briefing") {
      if (
        snapshot.issue.id !== job.issueId ||
        !storedJob ||
        ["cancelled", "superseded"].includes(storedJob.status)
      ) {
        throw new ResearchError(
          "SUPERSEDED",
          "This briefing request is no longer active.",
        );
      }
      return { snapshot };
    }
    if (
      snapshot.issue.id !== job.issueId ||
      !slot ||
      slot.id !== job.storyId ||
      slot.requestId !== job.requestId ||
      ["cancelled", "superseded"].includes(storedJob?.status)
    ) {
      throw new ResearchError(
        "SUPERSEDED",
        "The slot was deleted, cancelled, or assigned a newer request.",
      );
    }
    return { snapshot, slot };
  }

  function selectedTaskModel(snapshot) {
    if (["development", "hosted"].includes(gateway.mode)) {
      if (!gateway.model) {
        throw new ResearchError(
          "SELECTION_PENDING",
          "Read the workshop model selection before requesting research.",
        );
      }
      return gateway.model;
    }
    return snapshot.settings?.model ?? config.model ?? gateway.model;
  }

  function bindWrite(job, args) {
    const bindings = {
      issueId: job.issueId,
      slotId: job.slotId,
      requestId: job.requestId,
      baseContentVersion: job.baseContentVersion,
    };
    for (const [key, value] of Object.entries(bindings))
      if (args[key] !== undefined && args[key] !== value) {
        throw new ResearchError(
          "SLOT_AUTHORITY",
          `write_story must use this request's ${key}.`,
        );
      }
    return bindings;
  }

  function retainedFit(snapshot, slot) {
    const previous = snapshot.jobs?.find((entry) => {
      return entry.id === slot?.requestId;
    });
    if (
      previous?.status !== "incomplete" ||
      previous.phase !== "needs_fit" ||
      previous.issueId !== snapshot.issue.id ||
      previous.baseContentVersion !== slot.contentVersion ||
      !previous.retainedDraft?.body
    ) {
      return null;
    }
    const draft = previous.retainedDraft;
    if (
      !draft.sourceIds?.every((id) => {
        return snapshot.issue.sources.some((source) => {
          return source.id === id;
        });
      })
    ) {
      return null;
    }
    return {
      ...structuredClone(draft),
      resumedFrom: previous.id,
      frame: structuredClone(slot.frame),
    };
  }

  function scheduleFitRewrite(job, fit, frame) {
    job.lastFit = fit;
    if (
      job.conversation.finalSent ||
      job.conversation.turns >= job.maxTurns ||
      job.rewrites >= MAX_FIT_REWRITES
    ) {
      return false;
    }
    owned(job);
    job.fitting = true;
    job.rewrites++;
    job.pendingMessage = userMessage(copyFitInstruction(fit));
    progress(job, {
      status: "writing",
      phase: "fitting",
      fit,
      fitAttempt: job.rewrites,
    });
    trace.record(
      "story.fit_rewrite",
      correlation(job, {
        turn: job.conversation.turns,
        nextTurn: job.conversation.turns + 1,
        fitAttempt: job.rewrites,
        maxFitRewrites: MAX_FIT_REWRITES,
        fit,
        frame,
        label: "Correct copy length without more research",
      }),
    );
    return true;
  }

  function dispatchResize(entry) {
    if (closed || pendingResizes.get(entry.slotId) !== entry) {
      return;
    }
    if (activeForSlot(entry.slotId)) {
      return;
    } // The current writer wakes this entry when it finishes.
    pendingResizes.delete(entry.slotId);
    const snapshot = store.snapshot(),
      slot = findSlot(snapshot, entry.slotId);
    const retained = retainedFit(snapshot, slot);
    if (
      !slot ||
      slot.locked ||
      (!slot.body && !retained) ||
      snapshot.settings.stage === "tools" ||
      slot.contentVersion !== entry.contentVersion
    ) {
      trace.record("story.resize_skipped", {
        slotId: entry.slotId,
        requestId: entry.id,
        reason: "The slot is empty, locked, changed, or outside the editor stage.",
      });
      return;
    }
    const target = storyBudget(slot.frame, measure).maxWords;
    const words = slot.body.trim().split(/\s+/u).filter(Boolean).length;
    if (!retained && words <= target && words >= Math.floor(target * 0.8)) {
      trace.record("story.resize_skipped", {
        slotId: entry.slotId,
        requestId: entry.id,
        reason: "The copy already fits the requested word range.",
        words,
        target,
      });
      reviewCompletedCopy(
        { slotId: entry.slotId, issueId: snapshot.issue.id, requestId: entry.id },
        "Review resized story",
      );
      return;
    }
    try {
      inContext(entry.context, () => {
        return requestStory({
          slotId: entry.slotId,
          prompt: slot.prompt || "Fit the existing copy to its resized block.",
          resize: retained ?? {
            requestedBy: entry.id,
            headline: slot.headline,
            body: slot.body,
            sourceIds: [...slot.sourceIds],
            frame: structuredClone(slot.frame),
          },
        });
      });
    } catch (error) {
      trace.record("story.resize_failed", {
        slotId: entry.slotId,
        requestId: entry.id,
        status: "failed",
        error: errorInfo(error, config),
      });
      if (
        findSlot(store.snapshot(), entry.slotId)?.contentVersion ===
        entry.contentVersion
      ) {
        store.update(
          (issue) => {
            const current = issue.stories.find((story) => {
              return story.slotId === entry.slotId;
            });
            if (current) {
              current.researchNote = errorInfo(error, config).message;
            }
          },
          { action: "resize_not_started", history: false },
        );
      }
    }
  }

  function clearResize(slotId) {
    clearTimeout(pendingResizes.get(slotId)?.timer);
    pendingResizes.delete(slotId);
  }

  function reviewCompletedCopy(job, reason = "Completed draft review") {
    if (!config.onDraftComplete || closed) {
      return;
    }
    const span = trace.start("story.editorial", correlation(job, { purpose: reason }));
    void Promise.resolve()
      .then(() => {
        return config.onDraftComplete({
          slotId: job.slotId,
          jobId: job.id,
          requestId: job.requestId,
          parentId: span.id,
          reason,
          ...(job.resize?.renderedEpisodeId
            ? {
                origin: "rendered_fit",
                layoutOperationId: job.resize.layoutOperationId,
              }
            : {}),
        });
      })
      .then(
        () => {
          return span.finish({ status: "complete" });
        },
        (error) => {
          return span.finish({ status: "failed", error: errorInfo(error, config) });
        },
      );
  }

  function settleRenderedJob(job) {
    if (!job.resize?.renderedEpisodeId) {
      return;
    }
    const slot = findSlot(store.snapshot(), job.slotId);
    const episode = slot?.renderedFit;
    if (
      episode?.id !== job.resize.renderedEpisodeId ||
      slot.requestId !== job.requestId ||
      slot.frame.width !== job.resize.frame.width ||
      slot.frame.height !== job.resize.frame.height
    ) {
      return;
    }
    if (job.outcome?.applied) {
      saveRenderedEpisode(
        slot,
        { ...episode, status: "awaiting_measurement", fingerprint: null },
        { status: "checking_fit" },
      );
    } else if (slot.contentVersion === job.baseContentVersion) {
      const message =
        slot.researchNote ||
        "Rendered fitting stopped. Current copy is preserved; retry fitting or enlarge the block.";
      saveRenderedEpisode(
        slot,
        { ...episode, status: "needs_fit", message },
        { status: "needs_fit", note: message },
      );
    }
  }

  function saveRenderedEpisode(slot, episode, { status, note } = {}) {
    store.update(
      (issue) => {
        const current = issue.stories.find((story) => {
          return story.slotId === slot.slotId;
        });
        if (current?.id !== slot.id || current.contentVersion !== slot.contentVersion) {
          return;
        }
        current.renderedFit = {
          ...episode,
          contentVersion: slot.contentVersion,
          frame: structuredClone(slot.frame),
        };
        if (status) {
          current.status = status;
        }
        if (note) {
          current.researchNote = note;
        } else if (
          slot.renderedFit?.message &&
          current.researchNote === slot.renderedFit.message
        ) {
          delete current.researchNote;
        }
      },
      {
        kind: "story.rendered_fit",
        action: "rendered_fit_updated",
        history: false,
        data: {
          slotId: slot.slotId,
          contentVersion: slot.contentVersion,
          episodeId: episode.id,
          status: episode.status,
          attempts: episode.attempts,
          maxWords: episode.maxWords,
          requiredHeight: episode.requiredHeight,
        },
      },
    );
  }

  function progress(job, patch) {
    if (TERMINAL.has(job.status)) {
      return;
    }
    job.activity = {
      status: patch.status ?? job.activity?.status ?? "queued",
      phase: patch.phase ?? job.activity?.phase ?? "queued",
      tool: patch.tool ?? (patch.phase ? null : (job.activity?.tool ?? null)),
    };
    store.updateJob(job.id, {
      ...correlation(job),
      actor: "agent",
      ...job.activity,
      turn: job.conversation?.turns ?? 0,
      ...patch,
    });
  }

  function streamProgress(job, message) {
    const text = message.content
      .filter((part) => {
        return part.type === "text";
      })
      .map((part) => {
        return part.text;
      })
      .join("\n");
    // Complete deltas and the final message stay in Execution. State carries
    // only the current response's explicitly bounded preview.
    progress(job, {
      status: job.fitting ? "writing" : "running",
      phase: job.fitting ? "fitting" : "generating",
      partialText: text.slice(-480),
      partialTextCharacters: text.length,
      partialTextTruncated: text.length > 480,
    });
  }

  function subscribe(job, event) {
    const turn = job.conversation.turns;
    const data = correlation(job, { turn, actor: "agent", event: event.type });
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      trace.record("agent.message_update", {
        ...data,
        update: {
          type: update.type,
          delta: update.delta,
          contentIndex: update.contentIndex,
        },
      });
      if (
        update.type === "text_delta" &&
        Date.now() - (job.lastProgressAt ?? 0) >= 50
      ) {
        job.lastProgressAt = Date.now();
        streamProgress(job, event.message);
      }
    } else {
      const { messages: _messages, ...details } = event;
      if (details.result?.details?.mcp) {
        details.result = {
          content: details.result.content,
          isError: details.isError,
          data: mcpOutput(details.result.details.mcp),
        };
      }
      if (details.message?.role === "toolResult") {
        const { details: _details, ...message } = details.message;
        details.message = message;
      }
      trace.record(`agent.${event.type}`, { ...data, ...inspectable(details) });
      if (event.type === "turn_start") {
        progress(job, {
          status: job.fitting ? "writing" : "running",
          phase: job.fitting ? "fitting" : "generating",
          turn: turn + 1,
          partialText: "",
          partialTextCharacters: 0,
          partialTextTruncated: false,
        });
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        streamProgress(job, event.message);
      }
    }
  }

  function finish(job, status, details = {}) {
    if (TERMINAL.has(job.status)) {
      return;
    }
    job.status = status;
    job.conversation?.close?.();
    const data = {
      ...correlation(job),
      actor: "agent",
      status,
      phase: status,
      tool: null,
      turn: job.conversation?.turns ?? 0,
      requestCount: job.conversation?.requests ?? 0,
      operationIds: job.conversation?.operationIds ?? [],
      usage: job.conversation?.usage ?? [],
      budget: gateway.budget ?? null,
      sourceIds: [...job.evidence.keys()],
      evidence: [...job.evidence.values()].map((source) => {
        return sourceContext(source);
      }),
      finishedAt: new Date().toISOString(),
      ...details,
    };
    store.updateJob(job.id, data);
    if (status === "completed" && details.outcome?.alternate) {
      const slot = findSlot(store.snapshot(), job.slotId);
      if (
        slot?.id === job.storyId &&
        slot.requestId === job.requestId &&
        !slot.body &&
        slot.alternateDraft
      ) {
        store.update(
          (issue) => {
            const current = issue.stories.find((story) => {
              return story.slotId === job.slotId;
            });
            if (
              current?.requestId === job.requestId &&
              !current.body &&
              current.alternateDraft
            ) {
              current.status = "draft_available";
            }
          },
          {
            kind: "agent",
            action: "alternate_available",
            history: false,
            data: correlation(job),
          },
        );
      }
    }
    trace.record(`${job.type}.finished`, correlation(job, data));
    job.span.finish(data);
  }

  function invalidate(job, status, reason) {
    if (TERMINAL.has(job.status)) {
      return false;
    }
    if (status === "cancelled" && job.type === "story") {
      // Clearing only this request's lease also rejects an MCP write that returns late.
      const snapshot = store.snapshot();
      const slot = findSlot(snapshot, job.slotId);
      if (
        snapshot.issue.id === job.issueId &&
        slot?.id === job.storyId &&
        slot.requestId === job.requestId
      ) {
        store.update(
          (issue) => {
            const current = issue.stories.find((story) => {
              return story.slotId === job.slotId;
            });
            if (current?.id !== job.storyId || current.requestId !== job.requestId) {
              return;
            }
            current.requestId = null;
            if (current.contentVersion === job.baseContentVersion) {
              current.status = "cancelled";
            }
          },
          {
            kind: "agent",
            actor: "app",
            action: "story_cancelled",
            history: false,
            data: correlation(job),
          },
        );
      }
    }
    finish(job, status, { phase: status, reason });
    job.controller.abort(
      new ResearchError(status === "cancelled" ? "CANCELLED" : "SUPERSEDED", reason),
    );
    job.agent?.abort();
    return true;
  }

  return {
    requestStory,
    requestBriefing,
    resizeStory,
    reportRenderedFit,
    cancelStory: (jobId) => {
      const job = jobs.get(jobId);
      if (job?.slotId) {
        clearResize(job.slotId);
      }
      return job?.type === "story"
        ? invalidate(job, "cancelled", "The editor cancelled this story request.")
        : false;
    },
    cancelBriefing: (jobId) => {
      const job = jobs.get(jobId);
      return job?.type === "briefing"
        ? invalidate(job, "cancelled", "The visitor cancelled this briefing request.")
        : false;
    },
    async cancelAll() {
      for (const slotId of pendingResizes.keys()) {
        clearResize(slotId);
      }
      for (const job of jobs.values()) {
        invalidate(job, "cancelled", "A new newspaper replaced this request.");
      }
      queue.start();
      await queue.onIdle();
    },
    async waitForIdle() {
      do {
        await queue.onIdle();
        if (pendingResizes.size) {
          await new Promise((done) => {
            return setTimeout(done, 25);
          });
        }
      } while (queue.pending || queue.size || pendingResizes.size);
    },
    async close() {
      closed = true;
      for (const slotId of pendingResizes.keys()) {
        clearResize(slotId);
      }
      for (const job of jobs.values()) {
        invalidate(job, "cancelled", "The research runtime is closing.");
      }
      queue.start();
      await queue.onIdle();
    },
  };
}

// SUPPORTING HELPERS: discovery never grants tool authority by itself.

/** Discovery and application policy jointly determine this task's declarations. */
export function selectTaskTools(listed, type) {
  const tools = Array.isArray(listed) ? listed : listed?.tools;
  if (!Array.isArray(tools)) {
    throw new ResearchError(
      "MCP_DISCOVERY",
      "MCP discovery must return tools or a tools/list result.",
    );
  }
  return tools.filter((tool) => {
    return isModelTool(tool) && taskAllowsTool(tool.name, type);
  });
}
