// LEARNING: Run evidence-based revision experiments; start at createAutoResearch(), then request() and execute().
// Next: auto-research-evaluation.mjs defines the prompts and deterministic Keep/Revert boundary.

import { randomUUID } from "node:crypto";
import {
  auditPrompt,
  parseAudit,
  revisionPrompt,
  parseCandidate,
  evaluationPrompt,
  parseEvaluation,
  decideCandidate,
  formatRepairPrompt,
} from "./auto-research-evaluation.mjs";
import { errorInfo, ResearchError, turnLimit } from "./agent/policy.mjs";

const MAX_ROUNDS = 3;
const MAX_READS = 18;
const MAX_TOOLS = 36;
const invalidFormat = (error) => {
  return (
    ["JSON_RESPONSE", "OUTPUT_LIMIT"].includes(error?.code) ||
    /^AUTO_RESEARCH_INVALID_(AUDIT|CANDIDATE|EVALUATION)$/u.test(error?.code ?? "")
  );
};
const checkpointFields = [
  "id",
  "slotId",
  "storyId",
  "issueId",
  "documentVersion",
  "contentVersion",
  "requestId",
  "frame",
  "original",
  "model",
  "maxTurns",
  "round",
  "completedRounds",
  "requests",
  "tools",
  "reads",
  "kept",
  "reverted",
  "invalidEvaluations",
  "audit",
  "queries",
  "candidate",
  "priorEvaluation",
  "nextStep",
  "step",
];
const ACTIVE = new Set(["queued", "running"]);
const unfinishedWriter = new Set([
  "queued",
  "pending",
  "researching",
  "reading",
  "writing",
  "running",
]);
const copy = (story) => {
  return {
    headline: story.headline,
    body: story.body,
    sourceIds: [...story.sourceIds],
  };
};
const isReadable = (source) => {
  return (
    typeof source?.text === "string" &&
    source.text.trim().length >= 40 &&
    source.read !== false &&
    source.metadataOnly !== true &&
    source.completeness?.publisherArticleRead !== false &&
    !["failed", "error", "unavailable"].includes(source.status) &&
    !["metadata", "search-snippet", "feed-summary", "profile", "comment"].includes(
      String(source.evidenceLevel ?? "").toLowerCase(),
    )
  );
};
const sourceView = (source) => {
  return {
    id: source.id,
    title: source.title,
    url: source.canonicalUrl || source.url,
    // Eighteen excerpts fit together in the evaluator's fixed 96k text window.
    // A later targeted discovery must not be crowded out by the first round.
    text: source.text.slice(0, 5000),
    evidenceLevel: source.evidenceLevel,
    retrievedAt: source.retrievedAt,
    publishedAt: source.publishedAt,
    contentDigest: source.contentDigest,
    completeness: {
      ...source.completeness,
      truncated: source.completeness?.truncated === true || source.text.length > 5000,
    },
    simulated:
      source.simulated === true ||
      source.synthetic === true ||
      source.origin === "fixture",
  };
};

// ============================================================================
// MAIN BEHAVIOR - admission, experiment and Keep/Revert
// ============================================================================

/**
 * The harness owns the fixed rubric, limits and commit decision.
 * The model proposes claims, research queries and experiments. MCP owns reads.
 * A candidate stays private to the experiment until an independent evaluation
 * passes the deterministic keep gate; no rejected draft enters the newspaper.
 */
export function createAutoResearch({ store, trace, mcp, gateway, config = {} }) {
  const runs = new Map();
  let closed = false;
  const currentStory = (run) => {
    return store.snapshot().issue.stories.find((story) => {
      return story.slotId === run.slotId;
    });
  };
  const inRun = (run, parentId, action) => {
    return trace.withContext(
      {
        actor: "agent",
        taskId: run.id,
        jobId: run.id,
        requestId: run.id,
        slotId: run.slotId,
        parentId: parentId ?? run.span.id,
        generation: run.executionGeneration,
      },
      action,
    );
  };
  function request({ slotId, contentVersion }) {
    if (closed) {
      throw new ResearchError("CLOSED", "The research service is closed.");
    }
    const state = store.snapshot(),
      story = state.issue.stories.find((entry) => {
        return entry.slotId === slotId;
      });
    if (state.settings.stage !== "research") {
      throw new ResearchError("STAGE", "Choose Stage 4 to start auto research.");
    }
    if (!story?.body?.trim() || story.locked) {
      throw new ResearchError(
        "STORY",
        "Choose an unlocked story with copy to research.",
      );
    }
    if (story.contentVersion !== contentVersion) {
      throw new ResearchError(
        "SUPERSEDED",
        "Save or reload the current story before starting research.",
      );
    }
    const existing = [...runs.values()].find((run) => {
      return ACTIVE.has(run.status) && run.slotId === slotId;
    });
    if (existing) {
      return {
        runId: existing.id,
        executionId: existing.span.id,
        alreadyRunning: true,
      };
    }
    if (
      state.jobs.some((job) => {
        return job.slotId === slotId && unfinishedWriter.has(job.status);
      })
    ) {
      throw new ResearchError(
        "STORY_BUSY",
        "Wait for the current writer before starting auto research.",
      );
    }
    if (
      [...runs.values()].filter((run) => {
        return ACTIVE.has(run.status);
      }).length >= 2
    ) {
      throw new ResearchError(
        "QUEUE_FULL",
        "Two stories are already being researched. Stop one or wait for it to finish.",
      );
    }
    const previous = state.autoResearchRuns.find((entry) => {
      return entry.slotId === slotId && entry.storyId === story.id && entry.resumable;
    });
    const saved = previous && store.getAutoResearchCheckpoint(previous.id);
    const maxTurns =
      saved?.maxTurns ??
      Math.min(
        10,
        turnLimit(state.settings.maxTurns),
        turnLimit(config.maxTurns ?? 10),
      );
    const id = saved?.id ?? randomUUID();
    const executionGeneration = trace.generation;
    const span = trace.start("auto_research.run", {
      actor: "agent",
      taskId: id,
      jobId: id,
      generation: executionGeneration,
      requestId: id,
      slotId,
      label: `Auto research · ${story.headline || "Untitled story"}`,
      maxRounds: MAX_ROUNDS,
      maxRequests: maxTurns,
      maxSourceReads: MAX_READS,
      ...(saved
        ? {
            resumedFrom: previous.executionId,
            resumeStep: saved.nextStep,
            priorRequests: saved.requests,
          }
        : {}),
      model: state.settings.model,
      original: saved?.original ?? copy(story),
    });
    const run = {
      id,
      span,
      slotId,
      storyId: story.id,
      issueId: state.issue.id,
      documentVersion: state.documentVersion,
      contentVersion,
      requestId: story.requestId,
      frame: { ...story.frame },
      original: copy(story),
      model: state.settings.model,
      maxTurns,
      status: "queued",
      phase: "audit",
      round: 0,
      requests: 0,
      tools: 0,
      reads: 0,
      kept: 0,
      reverted: 0,
      invalidEvaluations: 0,
      completedRounds: 0,
      nextStep: "audit",
      priorEvaluation: null,
      ...(saved ?? {}),
      // Never restore promises, subscriptions, spans or abort controllers.
      // The logical run and budget survive Resume; its newly dispatched work
      // belongs to the currently visible archive, never a saved generation.
      span,
      executionGeneration,
      resuming: Boolean(saved),
      controller: new AbortController(),
      evidence: new Map(
        (saved?.evidence ?? []).map((source) => {
          return [source.id, source];
        }),
      ),
      readUrls: new Set(saved?.readUrls ?? []),
    };
    if (saved) {
      store.resumeAutoResearch(id, span.id);
    } else {
      store.startAutoResearch({
        id,
        slotId,
        maxRounds: MAX_ROUNDS,
        maxTurns,
        executionId: span.id,
      });
    }
    checkpoint(run);
    runs.set(id, run);
    run.unsubscribe = store.subscribe(() => {
      if (!ACTIVE.has(run.status) || run.applying || run.controller.signal.aborted) {
        return;
      }
      try {
        owned(run);
      } catch (error) {
        run.controller.abort(error);
      }
    });
    run.promise = Promise.resolve().then(() => {
      run.status = "running";
      return execute(run);
    });
    void run.promise.then(
      () => {
        return runs.delete(id);
      },
      () => {
        return runs.delete(id);
      },
    );
    return {
      runId: id,
      executionId: span.id,
      ...(saved ? { resumed: true, step: saved.nextStep } : {}),
    };
  }

  // LEARNING: Each trial shares a frozen audit and evidence window with its comparison; only Keep reaches the editor.
  async function execute(run) {
    let stopReason =
      "The bounded experiment run is complete. Remaining uncertainties are visible in Execution.";
    try {
      // Hosted bootstrap, rather than a previous visit's saved settings, owns
      // the model and payer. Keep the entire experiment on that selected model.
      const selection = await gateway.ready();
      owned(run);
      run.model = selection.model;
      store.updateAutoResearch(run.id, { model: run.model });
      if (!run.audit) {
        run.audit = await phase(
          run,
          "audit",
          {
            original: run.original,
            objective:
              "Improve factual support while preserving the original story's information goals.",
            evaluationPolicy:
              "Freeze goals; compare both drafts with identical evidence; require strict improvement.",
          },
          (parentId) => {
            return structuredStep(run, {
              name: "audit",
              messages: auditPrompt(run.original),
              purpose: "Auto research: freeze claims and information goals",
              parentId,
              parse: parseAudit,
            });
          },
        );
        run.queries = run.audit.claims.map((claim) => {
          return claim.query;
        });
        run.nextStep = "research";
        checkpoint(run);
      }
      const audit = parseAudit(run.audit);
      if (!run.round) {
        run.round = 1;
      }
      while (run.round <= MAX_ROUNDS) {
        if (run.nextStep === "research") {
          if (run.requests + 2 > run.maxTurns) {
            run.round = run.completedRounds;
            stopReason =
              "The model-request limit leaves no complete experiment/evaluation pair. Kept copy is preserved.";
            break;
          }
          const initialSources =
            run.round === 1
              ? store
                  .snapshot()
                  .issue.sources.filter((source) => {
                    return run.original.sourceIds.includes(source.id);
                  })
                  .slice(0, 2)
              : [];
          await phase(run, "research", { queries: run.queries.slice(0, 3) }, () => {
            return research(run, run.queries, initialSources);
          });
          if (!run.evidence.size) {
            stopReason =
              "No readable source evidence was found. The original copy was preserved; factual claims remain unresolved.";
            break;
          }
          run.nextStep = "experiment";
          checkpoint(run);
        }
        const evidence = [...run.evidence.values()],
          current = copy(owned(run));
        if (run.nextStep === "experiment") {
          run.candidate = await phase(
            run,
            "experiment",
            { before: current },
            (parentId) => {
              return structuredStep(run, {
                name: "experiment",
                messages: revisionPrompt({
                  original: run.original,
                  current,
                  audit,
                  evidence,
                  round: run.round,
                  priorEvaluation: run.priorEvaluation,
                }),
                purpose: "Auto research: propose an informative, defensible revision",
                parentId,
                parse: (json) => {
                  return parseCandidate(json, evidence);
                },
              });
            },
          );
          run.nextStep = "evaluate";
          checkpoint(run);
        }
        const candidate = parseCandidate(run.candidate, evidence);
        const assessed = await evaluate(run, { current, candidate, audit, evidence });
        const { evaluation, decision } = assessed;
        owned(run);
        const details = {
          reason: decision.reason,
          metrics: decision.metrics,
          baselineEvaluation: evaluation.baseline,
          candidateEvaluation: evaluation.candidate,
        };
        if (decision.decision === "keep") {
          // A synchronous CAS protects manual edits and a later request while
          // preserving the original frame. Save acknowledgement is still required.
          run.applying = true;
          try {
            store.applyResearchRevision({
              runId: run.id,
              slotId: run.slotId,
              storyId: run.storyId,
              issueId: run.issueId,
              documentVersion: run.documentVersion,
              contentVersion: run.contentVersion,
              expectedRequestId: run.requestId,
              ...candidate,
              assessment: {
                checkedAt: new Date().toISOString(),
                round: run.round,
                metrics: decision.metrics?.candidate,
                scope: "Evidence checks for this experiment; not a guarantee of truth.",
              },
            });
            run.contentVersion = currentStory(run).contentVersion;
          } finally {
            run.applying = false;
          }
          run.kept++;
          record(run, "keep", {
            status: "complete",
            ...details,
            before: current,
            after: copy(currentStory(run)),
          });
          await store.flush();
          owned(run);
        } else {
          run.reverted++;
          record(run, "revert", {
            status: "complete",
            ...details,
            before: current,
            candidate,
            effect:
              "The experiment was discarded. The current newspaper copy was never replaced.",
          });
        }
        run.completedRounds++;
        progress(run, decision.decision, {
          completedRounds: run.completedRounds,
          kept: run.kept,
          reverted: run.reverted,
          lastDecision: { decision: decision.decision, reason: decision.reason },
          currentEvaluation:
            decision.metrics?.[decision.decision === "keep" ? "candidate" : "baseline"],
          summary: decision.reason,
        });
        run.priorEvaluation = evaluation;
        const keptEvaluation =
          decision.decision === "keep" ? evaluation.candidate : evaluation.baseline;
        run.queries = evaluation.nextQueries?.length
          ? evaluation.nextQueries
          : audit.claims
              .filter((claim) => {
                return keptEvaluation.claims.some((item) => {
                  return item.id === claim.id && item.verdict !== "supported";
                });
              })
              .map((claim) => {
                return claim.query;
              });
        if (!run.queries.length) {
          stopReason =
            "This pass found no remaining research query for the frozen claims. Review its sources and caveats before publication.";
          break;
        }
        if (run.reads >= MAX_READS || run.tools + 3 >= MAX_TOOLS) {
          stopReason =
            "The source-reading limit was reached. Kept copy and unresolved claims are preserved.";
          break;
        }
        run.candidate = null;
        run.nextStep = "research";
        run.round++;
        checkpoint(run);
      }
      run.round = Math.min(run.round, MAX_ROUNDS);
      finish(run, "completed", stopReason);
    } catch (error) {
      const status =
        error.code === "SUPERSEDED"
          ? "superseded"
          : run.controller.signal.aborted
            ? "stopped"
            : error.code === "CONTEXT_LIMIT"
              ? "failed"
              : error.recoverableStep || error.code === "TURN_LIMIT"
                ? "paused"
                : "stopped";
      const failure = errorInfo(error, config);
      const reason =
        error.code === "TURN_LIMIT"
          ? "The request allowance is exhausted. The current copy, evidence and unfinished step are preserved."
          : status === "paused"
            ? `The ${run.nextStep} response is still unusable after format recovery. Current copy and the ` +
              `saved step are preserved.${
                run.requests < run.maxTurns
                  ? " Resume this step when ready."
                  : " The run's request allowance is exhausted."
              }`
            : `${failure.message} Current copy is preserved.`;
      finish(run, status, reason, { error: failure });
    } finally {
      run.unsubscribe?.();
      // The archive retains every attempt. The saved checkpoint is separate
      // from compact live state and is resumed only by an explicit user action.
      run.evidence.clear();
      delete run.original;
      delete run.audit;
    }
  }

  async function research(run, queries, initialSources) {
    const searches = await Promise.all(
      queries.slice(0, 3).map((query) => {
        return sourceTool(run, "search_web", {
          query: String(query).slice(0, 300),
          limit: 3,
        });
      }),
    );
    const targets = [
      ...initialSources,
      ...searches.flatMap((batch) => {
        return batch.records ?? [];
      }),
    ];
    const urls = [
      ...new Set(
        targets
          .map((source) => {
            return source.url || source.canonicalUrl;
          })
          .filter(Boolean),
      ),
    ]
      .filter((url) => {
        return !run.readUrls.has(url);
      })
      .slice(0, Math.min(6, MAX_READS - run.reads));
    const batches = await Promise.all(
      urls.map(async (url) => {
        run.readUrls.add(url);
        run.reads++;
        return sourceTool(run, "fetch_read", { url, maxChars: 8000, maxLinks: 8 });
      }),
    );
    // If a page is only metadata, follow observed links rather than treating its
    // title/snippet as substantiation. The same global read limit still applies.
    const links = batches
      .flatMap((batch) => {
        return (batch.records ?? [])
          .filter((source) => {
            return !isReadable(source);
          })
          .flatMap((source) => {
            return source.links ?? [];
          });
      })
      .map((link) => {
        return typeof link === "string" ? link : (link.url ?? link.href);
      })
      .filter((url) => {
        return url && !run.readUrls.has(url);
      });
    for (const url of [...new Set(links)].slice(
      0,
      Math.min(2, MAX_READS - run.reads),
    )) {
      run.readUrls.add(url);
      run.reads++;
      batches.push(
        await sourceTool(run, "fetch_read", { url, maxChars: 8000, maxLinks: 4 }),
      );
    }
    for (const source of batches.flatMap((batch) => {
      return batch.records ?? [];
    }))
      if (
        isReadable(source) &&
        (run.evidence.has(source.id) || run.evidence.size < MAX_READS)
      ) {
        run.evidence.set(source.id, sourceView(source));
      }
    return {
      queries,
      sourceIds: [...run.evidence.keys()],
      reads: run.reads,
      losses: [...searches, ...batches].flatMap((batch) => {
        return batch.losses ?? [];
      }),
      limitation:
        "Readable excerpts are observations. Search snippets and model confidence are not verification.",
    };
  }

  // The evaluator supplies reports; deterministic code decides whether the revision earns Keep.
  async function evaluate(run, { current, candidate, audit, evidence }) {
    let decision;
    const evaluation = await phase(
      run,
      "evaluate",
      {
        rubric: audit,
        before: current,
        candidate,
        evidenceSourceIds: evidence.map((source) => {
          return source.id;
        }),
      },
      (parentId) => {
        return structuredStep(run, {
          name: "evaluate",
          messages: evaluationPrompt({
            original: run.original,
            current,
            candidate,
            audit,
            evidence,
          }),
          purpose: "Auto research: independently evaluate current copy and experiment",
          parentId,
          parse(json) {
            const parsed = parseEvaluation(json, {
              audit,
              evidence,
              currentStory: current,
              candidateStory: candidate,
            });
            decision = decideCandidate({
              baseline: parsed.baseline,
              candidate: parsed.candidate,
              currentStory: current,
              candidateStory: candidate,
              audit,
            });
            if (decision.decision === "invalid") {
              throw Object.assign(
                new ResearchError("AUTO_RESEARCH_INVALID_EVALUATION", decision.reason),
                { issues: decision.issues },
              );
            }
            return parsed;
          },
        });
      },
    );
    return { evaluation, decision };
  }

  // ============================================================================
  // SUPPORTING HELPERS - declarations share this run scope
  // ============================================================================

  // A reply can arrive after a human edit, so ownership is checked again after awaited work.
  function owned(run) {
    run.controller.signal.throwIfAborted();
    const state = store.snapshot(),
      story = currentStory(run);
    if (
      state.settings.stage !== "research" ||
      state.issue.id !== run.issueId ||
      state.documentVersion !== run.documentVersion ||
      !story ||
      story.id !== run.storyId ||
      story.locked ||
      story.contentVersion !== run.contentVersion ||
      story.requestId !== run.requestId ||
      story.frame.width !== run.frame.width ||
      story.frame.height !== run.frame.height
    ) {
      throw new ResearchError(
        "SUPERSEDED",
        "The story, stage or size changed. The current copy was preserved.",
      );
    }
    return story;
  }

  // LEARNING: Format recovery retries the same step inside its remaining allowance, without repeating research.
  async function structuredStep(run, { name, messages, purpose, parentId, parse }) {
    const key = `${run.round}:${name}`;
    const step =
      run.step?.key === key
        ? run.step
        : (run.step = { key, name, attempts: 0, automaticRepairUsed: false });
    while (true) {
      owned(run);
      const repairing = Boolean(step.failure);
      const submitted = repairing
        ? formatRepairPrompt(messages, step.failure)
        : messages;
      const recoverySpan = repairing
        ? inRun(run, parentId, () => {
            return trace.start("auto_research.repair", {
              runId: run.id,
              slotId: run.slotId,
              round: run.round,
              step: name,
              label: `Repair ${name} response format`,
              attempt: step.attempts + 1,
              logicalStepId: `${run.id}:${key}`,
              sourceOperationId: step.failure.operationId,
              previousOperationId: step.failure.operationId,
              automatic: !run.resuming,
            });
          })
        : null;
      let response;
      step.attempts++;
      try {
        response = await model(
          run,
          submitted,
          repairing ? `Auto research: repair ${name} response format` : purpose,
          recoverySpan?.id ?? parentId,
        );
        const result = parse(response.json);
        recoverySpan?.finish({ status: "complete", operationId: response.operationId });
        if (repairing) {
          record(run, "format_recovered", {
            status: "complete",
            step: name,
            attempt: step.attempts,
            operationId: response.operationId,
            effect:
              "The repaired response passed the unchanged schema and evidence checks.",
          });
        }
        run.step = null;
        run.resuming = false;
        progress(run, name, { recovery: null });
        return result;
      } catch (error) {
        recoverySpan?.finish({
          status: invalidFormat(error) ? "incomplete" : "failed",
          error: errorInfo(error, config),
          operationId: response?.operationId ?? error.operationId,
        });
        owned(run);
        if (!invalidFormat(error)) {
          throw error;
        }
        // Both gateway parse errors and successful JSON with invalid schema or
        // evidence take this single path. There is no second evaluator retry loop.
        const observed = response ?? error.observation ?? error;
        step.failure = {
          code: error.code,
          message: error.message.slice(0, 2400),
          issues: (error.issues ?? []).slice(0, 8),
          ...(typeof observed.text === "string" ? { response: observed.text } : {}),
          operationId: observed.operationId,
          stopReason: observed.stopReason,
          rawStopReason: observed.rawStopReason,
          outputLimitReached: observed.outputLimitReached,
          maxOutputTokens: observed.maxOutputTokens,
          parseReason: observed.parseReason,
        };
        if (name === "evaluate") {
          run.invalidEvaluations++;
        }
        const retry = !step.automaticRepairUsed && run.requests < run.maxTurns;
        record(run, name === "evaluate" ? "evaluation_invalid" : "format_invalid", {
          status: "incomplete",
          step: name,
          attempt: step.attempts,
          retry,
          operationId: observed.operationId,
          stopReason: observed.stopReason,
          error: errorInfo(error, config),
          issues: error.issues ?? [],
          ...(name === "evaluate"
            ? { metrics: { baseline: null, candidate: null } }
            : {}),
          effect:
            "No Keep or Revert. The current copy and last valid evaluation remain unchanged.",
        });
        progress(run, name, {
          invalidEvaluations: run.invalidEvaluations,
          recovery: {
            step: name,
            status: retry ? "repairing" : "paused",
            attempt: step.attempts,
          },
          summary: retry
            ? "Repairing the response format once, using the same inputs and request allowance."
            : "Response format is unresolved. The current step and last valid evaluation are saved.",
        });
        if (retry) {
          step.automaticRepairUsed = true;
          checkpoint(run);
          continue;
        }
        checkpoint(run);
        error.recoverableStep = name;
        throw error;
      }
    }
  }

  async function model(run, messages, purpose, parentId) {
    owned(run);
    if (run.requests >= run.maxTurns) {
      throw new ResearchError("TURN_LIMIT", "The run reached its model-request limit.");
    }
    run.requests++;
    store.updateAutoResearch(run.id, { turn: run.requests });
    // Persist the admitted attempt before dispatch. Resume cannot reset the run's
    // budget after a restart or replay an uncertain attempt as though it was free.
    checkpoint(run);
    await store.flush();
    owned(run);
    const result = await gateway.completeText({
      messages,
      model: run.model,
      purpose,
      jsonOnly: true,
      requestKind: "auto_research",
      jobId: run.id,
      requestId: run.id,
      parentId,
      signal: run.controller.signal,
    });
    owned(run);
    return result;
  }

  async function sourceTool(run, name, args) {
    owned(run);
    if (++run.tools > MAX_TOOLS) {
      throw new ResearchError(
        "SOURCE_LIMIT",
        "The run reached its bounded source-tool limit.",
      );
    }
    try {
      const result = await mcp.callTool(name, args, {
        actor: "agent",
        jobId: run.id,
        requestId: run.id,
        taskId: run.id,
        slotId: run.slotId,
        signal: run.controller.signal,
      });
      owned(run);
      if (result.isError) {
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          result.content?.[0]?.text ?? "The source tool could not complete this read.",
        );
      }
      const batch =
        result.structuredContent ??
        JSON.parse(
          result.content.find((item) => {
            return item.type === "text";
          }).text,
        );
      if (
        !batch ||
        !Array.isArray(batch.records) ||
        (batch.losses && !Array.isArray(batch.losses))
      ) {
        throw new ResearchError(
          "SOURCE_RESPONSE",
          "The source tool returned an unusable record batch.",
        );
      }
      return batch;
    } catch (error) {
      // A failed source must not erase successful sibling reads. Cancellation,
      // ownership and global limits still stop work instead of becoming gaps.
      owned(run);
      if (["SUPERSEDED", "SOURCE_LIMIT", "CONTEXT_LIMIT"].includes(error.code)) {
        throw error;
      }
      const failure = errorInfo(error, config);
      record(run, "source_gap", { status: "incomplete", tool: name, error: failure });
      return { records: [], losses: [failure] };
    }
  }

  function cancel(
    runId,
    reason = "You stopped the research loop. Kept copy is preserved.",
  ) {
    const run = runs.get(runId);
    if (!run || !ACTIVE.has(run.status)) {
      return false;
    }
    run.controller.abort(new ResearchError("CANCELLED", reason));
    return true;
  }

  async function cancelAll(reason) {
    for (const run of runs.values()) {
      cancel(run.id, reason);
    }
    await Promise.all(
      [...runs.values()].map((run) => {
        return run.promise;
      }),
    );
  }

  async function phase(run, name, input, work) {
    owned(run);
    progress(run, name);
    const span = inRun(run, run.span.id, () => {
      return trace.start(`auto_research.${name}`, {
        taskId: run.id,
        jobId: run.id,
        requestId: run.id,
        runId: run.id,
        slotId: run.slotId,
        round: run.round,
        label: {
          audit: "Freeze the claims and information goals",
          research: "Research disputed claims",
          experiment: "Experiment with a revision",
          evaluate: "Evaluate both versions against the same evidence",
        }[name],
        ...input,
      });
    });
    try {
      const result = await inRun(run, span.id, () => {
        return work(span.id);
      });
      owned(run);
      span.finish({ status: "complete", result });
      return result;
    } catch (error) {
      span.finish({
        status: run.controller.signal.aborted
          ? "cancelled"
          : invalidFormat(error)
            ? "incomplete"
            : "failed",
        error: errorInfo(error, config),
      });
      throw error;
    }
  }

  function checkpoint(run) {
    store.checkpointAutoResearch(run.id, {
      version: 1,
      ...Object.fromEntries(
        checkpointFields
          .filter((key) => {
            return run[key] !== undefined;
          })
          .map((key) => {
            return [key, run[key]];
          }),
      ),
      evidence: [...run.evidence.values()],
      readUrls: [...run.readUrls],
    });
  }

  function progress(run, phase, patch = {}) {
    run.phase = phase;
    store.updateAutoResearch(run.id, {
      status: "running",
      phase,
      round: run.round,
      turn: run.requests,
      ...patch,
    });
  }

  function record(run, kind, data) {
    return inRun(run, run.span.id, () => {
      return trace.record(`auto_research.${kind}`, {
        taskId: run.id,
        jobId: run.id,
        requestId: run.id,
        runId: run.id,
        slotId: run.slotId,
        round: run.round,
        ...data,
      });
    });
  }

  function finish(run, status, reason, details = {}) {
    if (!ACTIVE.has(run.status)) {
      return;
    }
    run.status = status;
    const summary =
      `${run.kept} kept, ${run.reverted} reverted across ${run.completedRounds} completed ` +
      `round${run.completedRounds === 1 ? "" : "s"}.` +
      (run.round > run.completedRounds ? ` Round ${run.round} is incomplete.` : "");
    const resumable = status === "paused" && run.requests < run.maxTurns;
    record(run, "stop", {
      status,
      reason,
      outcome: summary,
      requestCount: run.requests,
      completedRounds: run.completedRounds,
      interruptedStep: status === "paused" ? run.nextStep : undefined,
      toolCalls: run.tools,
      sourceReads: run.reads,
      ...details,
    });
    if (status === "paused") {
      checkpoint(run);
    } else {
      store.checkpointAutoResearch(run.id, null);
    }
    store.updateAutoResearch(run.id, {
      status,
      phase: status === "paused" ? run.nextStep : "finished",
      summary,
      stopReason: reason,
      completedRounds: run.completedRounds,
      resumable,
      remainingRequests: Math.max(0, run.maxTurns - run.requests),
      kept: run.kept,
      reverted: run.reverted,
      invalidEvaluations: run.invalidEvaluations,
      endedAt: new Date().toISOString(),
      ...details,
    });
    run.span.finish({
      status,
      summary,
      reason,
      requestCount: run.requests,
      model: run.model,
    });
  }

  return {
    request,
    cancel,
    cancelAll,
    async waitForIdle() {
      await Promise.all(
        [...runs.values()].map((run) => {
          return run.promise;
        }),
      );
    },
    async close() {
      closed = true;
      await cancelAll("The application is closing. Kept copy is preserved.");
    },
  };
}
