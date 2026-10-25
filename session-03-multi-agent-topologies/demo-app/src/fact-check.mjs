// LEARNING: Run one fact-check as a SELECTABLE multi-agent arrangement; start at createFactCheck(), then request() and execute().
// The arrangement (single agent, developer graph, or emergent swarm) decides HOW the
// story's claims are checked. All three drive tool-using agents through the SAME bundled
// archive with the SAME search/read tools, and all three return the SAME result shape:
// one verdict per claim (with the document ID and verbatim quote that settled it) and a
// corrected story. There is NO independent evaluator and NO keep/revert gate: a corrected
// story is applied as a NORMAL, UNDOABLE copy edit the user can revert like any other.
// Next: topologies.mjs holds the three arrangements; archive.mjs holds the bundled documents.

import { randomUUID } from "node:crypto";
import { ResearchError, errorInfo, turnLimit } from "./agent/policy.mjs";
import { runSingleAgent, runGraph, runSwarm, TOPOLOGIES } from "./topologies.mjs";
import { parseTurn } from "./topology-prompts.mjs";
import { ARCHIVE_CLAIMS, searchArchive, readArchive, seededStory } from "./fact-check/archive.mjs";
import { reportedCost } from "./agent/budget.mjs";
import { applyRevisionEdits } from "./revision-edits.mjs";
import { createDemoReplay } from "./fact-check/demo-replay.mjs";
import { storyWordBudget } from "./domain/store.mjs";

// A fact-check of an 80-claim story runs many model calls: the single agent walks the whole
// story over 30-ish turns (broker-run-v3.mjs evidence, scaled with story size), and the graph
// starts one checker per claim, each taking a few turns. The request ceiling is sized so the
// widest arrangement (one checker per claim at the full GRAPH_CLAIM_MAX_TURNS, plus headroom)
// fits without starving a legitimate run: 80 claims x 8 turns = 640 worst-case graph calls, and
// a 120-claim story would be 960, so the ceiling clears both. Each call is still bounded per
// agent by its configured maxTurns.
const MAX_REQUESTS = 1000;
// The class broker holds each request to its own per-operation deadline and does not cancel
// server-side on a client disconnect, so a client deadline shorter than the broker's wall
// does not free the charge early — it only abandons a call the broker keeps running, leaving
// an unsettled reservation. The validated broker runs (broker-run-v3.mjs) used a 120 s wall
// and every turn settled within it, so each call here gets the same 120 s: long enough for a
// slow-but-valid turn (a large tool-history read turn on the full story) to finish rather
// than be half-abandoned.
const CALL_DEADLINE_MS = 120_000;
// Session 3 recorded replay pacing. The recordings carry each call's real broker duration
// (single summed ~149 s, graph summed ~4494 s over 478 calls run 6-wide, swarm summed ~34 s).
// Played at full speed a graph demo would run ~12 minutes, so each recorded duration is scaled
// down by REPLAY_SPEEDUP and clamped to REPLAY_MAX_CALL_MS so one 37 s outlier cannot stall
// the demo. The relative order and spacing are kept, so graph still visibly runs many calls
// at once while single and swarm finish faster: graph lands near 70 to 90 s wall (its scaled
// per-call sum divided by the 6-wide pool), single near 15 s, swarm near 4 s. A minimum keeps
// each call visible rather than instantaneous.
const REPLAY_SPEEDUP = 0.1;
const REPLAY_MAX_CALL_MS = 2_000;
const REPLAY_MIN_CALL_MS = 120;
function replayPaceMs(paced, recordedMs) {
  if (!paced) {
    return 0;
  }
  if (!Number.isFinite(recordedMs) || recordedMs <= 0) {
    return REPLAY_MIN_CALL_MS;
  }
  return Math.max(REPLAY_MIN_CALL_MS, Math.min(REPLAY_MAX_CALL_MS, Math.round(recordedMs * REPLAY_SPEEDUP)));
}
function replayDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
// A per-claim or per-agent call that hits an output/deadline/empty-response wall stops only
// ITS claim (graph) or hop (swarm), not the whole run. A run-level fault — an exhausted
// request allowance, a context overflow, a human supersede, a cancellation, a budget error —
// still fails the run as a whole.
const PER_CLAIM_ISOLATABLE = new Set(["OUTPUT_LIMIT", "CALL_DEADLINE", "JSON_RESPONSE"]);
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
    sourceIds: [...(story.sourceIds ?? [])],
  };
};

const strategies = {
  single: runSingleAgent,
  graph: runGraph,
  swarm: runSwarm,
};

// Derive the claim set from the story by CODE, not by a model audit, so the claim set is
// deterministic and the same for every arrangement. The seeded newspaper story restates the
// bundled archive's claims one sentence per claim, so a sentence split recovers them; each
// recovered sentence is matched back to the archive claim it restates (by exact text) to
// carry that claim's area (kind), which the swarm routes on. A sentence that matches no
// archive claim is still checked as a free-standing claim with no area.
function claimsFromStory(story) {
  const body = String(story?.body ?? "");
  const sentences = body.match(/\S[\s\S]*?(?:[.!?](?=\s|$)|$)/gu) ?? [];
  const byText = new Map(ARCHIVE_CLAIMS.map((claim) => [claim.text.trim(), claim]));
  const claims = [];
  let index = 0;
  for (const raw of sentences) {
    const text = raw.trim();
    if (!text) {
      continue;
    }
    index++;
    const matched = byText.get(text);
    claims.push({
      id: matched?.id ?? `s${index}`,
      text,
      kind: matched?.kind ?? null,
    });
  }
  return claims;
}

// The one sentence of the current body a claim appears in, so a correction replaces exactly
// that sentence and leaves the rest of the story byte-for-byte. The claim text IS a sentence
// of the seeded story, so a direct substring search finds it; a derived claim whose text has
// drifted from the body falls back to the best-overlap sentence.
function sentenceFor(story, claimText) {
  const body = String(story?.body ?? "");
  const needle = String(claimText ?? "").trim();
  if (needle && body.includes(needle)) {
    return needle;
  }
  const sentences = body.match(/\S[\s\S]*?(?:[.!?](?=\s|$)|$)/gu) ?? [];
  if (!sentences.length) {
    return null;
  }
  const terms = new Set(
    needle
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((word) => word.length > 2) ?? [],
  );
  if (!terms.size) {
    return null;
  }
  let best = null;
  let bestScore = 0;
  for (const sentence of sentences) {
    const words = sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    let score = 0;
    for (const word of words) {
      if (terms.has(word)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = sentence.trim();
    }
  }
  return bestScore > 0 ? best : null;
}

// ============================================================================
// MAIN BEHAVIOR - admission, arrangement selection, verdicts and an undoable edit
// ============================================================================

/**
 * The harness owns the budget, request limits and the one commit the run makes: applying
 * the corrected story as a normal, undoable copy edit. The selected topology owns only how
 * its checking agents are arranged. Every arrangement returns the same verdicts-and-corrected-
 * story shape, so the arrangement is a fair variable rather than a different standard.
 */
export function createFactCheck({ store, trace, gateway, config = {} }) {
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

  function request({ slotId, contentVersion, topology = "single", concurrentVerifiers = true }) {
    if (closed) {
      throw new ResearchError("CLOSED", "The fact-check service is closed.");
    }
    if (!TOPOLOGIES.includes(topology)) {
      throw new ResearchError(
        "TOPOLOGY",
        `Choose one of the arrangements: ${TOPOLOGIES.join(", ")}.`,
      );
    }
    const state = store.snapshot(),
      story = state.issue.stories.find((entry) => {
        return entry.slotId === slotId;
      });
    if (state.settings.stage !== "research") {
      throw new ResearchError("STAGE", "Open the fact-check view to run a fact-check.");
    }
    if (!story?.body?.trim() || story.locked) {
      throw new ResearchError("STORY", "Choose an unlocked story with copy to fact-check.");
    }
    if (story.contentVersion !== contentVersion) {
      throw new ResearchError(
        "SUPERSEDED",
        "Save or reload the current story before starting a fact-check.",
      );
    }
    const existing = [...runs.values()].find((run) => {
      return ACTIVE.has(run.status) && run.slotId === slotId;
    });
    if (existing) {
      return { runId: existing.id, executionId: existing.span.id, alreadyRunning: true };
    }
    if (
      state.jobs.some((job) => {
        return job.slotId === slotId && unfinishedWriter.has(job.status);
      })
    ) {
      throw new ResearchError(
        "STORY_BUSY",
        "Wait for the current writer before starting a fact-check.",
      );
    }
    if (
      [...runs.values()].filter((run) => {
        return ACTIVE.has(run.status);
      }).length >= 2
    ) {
      throw new ResearchError(
        "QUEUE_FULL",
        "Two stories are already being fact-checked. Stop one or wait for it to finish.",
      );
    }
    // A multi-agent fact-check runs MANY captured calls across its arrangement (the single
    // agent walks the whole story over 10-22 turns; the graph starts one checker per claim,
    // each a few turns), so the run's request ceiling is MAX_REQUESTS by default. It is NOT
    // the gateway maxTurns, which caps at 10 and bounds ONE conversation's per-call
    // turn budget, not a whole fact-check: reading config.maxTurns here starved every live run
    // at 10 requests, since config.mjs defaults maxTurns to 10. A test or recorder that needs
    // a different bound passes config.maxFactCheckRequests explicitly (e.g. 1 to force the
    // budget-refusal path); nothing else narrows the ceiling.
    const explicitCeiling = Number.isSafeInteger(config.maxFactCheckRequests)
      ? config.maxFactCheckRequests
      : MAX_REQUESTS;
    const maxRequests = Math.max(1, Math.min(MAX_REQUESTS, explicitCeiling));
    // Demo toggle: a recorded run always starts from the bundled story's original copy. A run
    // that applied corrections changes the sentences, and the recording is keyed to the original
    // claims, so restore the copy (as a normal, undoable edit) and clear the previous result.
    if (state.settings.demoMode === true && story.fixedCopy && (story.plantedClaims?.length ?? 0) > 0) {
      const original = seededStory();
      if (story.body !== original.body || story.headline !== original.headline || story.plantedResult) {
        store.editStory(slotId, { headline: original.headline, body: original.body });
        store.update(
          (issue) => {
            const target = issue.stories.find((item) => item.slotId === slotId);
            if (target) {
              target.plantedResult = null;
            }
          },
          { action: "planted_result", history: false, data: { slotId } },
        );
        const restored = store.snapshot().issue.stories.find((entry) => entry.slotId === slotId);
        return request({ slotId, contentVersion: restored.contentVersion, topology, concurrentVerifiers });
      }
    }
    const id = randomUUID();
    // Session 3 demo toggle. A recorded run replaces only the model boundary; the harness and
    // topology code are unchanged. Decided once here from the current settings and story so
    // the run span, the model() routing and the Execution label all agree.
    const replay =
      state.settings.demoMode === true && story.fixedCopy && (story.plantedClaims?.length ?? 0) > 0
        ? createDemoReplay(topology)
        : null;
    const executionGeneration = trace.generation;
    const span = trace.start("fact_check.run", {
      actor: "agent",
      taskId: id,
      jobId: id,
      generation: executionGeneration,
      requestId: id,
      slotId,
      topology,
      label: replay
        ? `Fact-check (${topology}) · ${replay.label}`
        : `Fact-check (${topology}) · ${story.headline || "Untitled story"}`,
      recorded: Boolean(replay),
      recordedLabel: replay?.label ?? null,
      maxRequests,
      original: copy(story),
    });
    const run = {
      id,
      span,
      slotId,
      topology,
      // Graph only: run its per-claim checkers in bounded concurrent batches rather than one
      // after another. Ignored by single and swarm. Default off so the deck's narrated walk-
      // through stays sequential; the harness turns it on to record the parallel timing.
      // Graph claim checkers run concurrently by default (the app never passes this flag; tests may pass false).
      concurrentVerifiers: concurrentVerifiers !== false,
      storyId: story.id,
      issueId: state.issue.id,
      documentVersion: state.documentVersion,
      contentVersion,
      requestId: story.requestId,
      frame: { ...story.frame },
      original: copy(story),
      constraints: constraintsFor(story, state),
      model: state.settings.model,
      // Session 3 demo toggle. When demoMode is on and the story is the bundled demo story
      // (fixed copy with planted claims), every fact_check model call is answered from the
      // recorded GPT-6 Luna run for this topology instead of the broker: no request, no
      // reservation, zero cost. The run still drives the SAME harness and topology code; only
      // the model boundary is replaced. Real execution (demoMode off, or any other story)
      // leaves replay null and calls the live gateway.
      replay:
        state.settings.demoMode === true && story.fixedCopy && (story.plantedClaims?.length ?? 0) > 0
          ? createDemoReplay(topology)
          : null,
      maxRequests,
      status: "queued",
      phase: "check",
      startedAt: Date.now(),
      requests: 0,
      agents: 0,
      hops: 0,
      executionGeneration,
      controller: new AbortController(),
      // Per-agent accounting for the compact Execution summary. Each entry is one captured
      // model call's work within this run.
      agentLog: [],
      // The verdicts the arrangement produced, recorded for the run summary and the UI.
      verdicts: [],
      // Session 3 claim board: one compact status per claim in story order, updated in real
      // time as the arrangement checks claims. state is waiting | checking | supported |
      // contradicted | needs_evidence; planted marks a demo-story planted error. Carried on
      // the run and pushed to the snapshot (as autoResearchRuns[].claims) so the Execution
      // view can show progress at a glance without scrolling the raw record list. Populated
      // from the derived claim set in execute(); null until then.
      claims: null,
      claimState: new Map(),
      claimsDirty: false,
      claimsFlushAt: 0,
    };
    store.startAutoResearch({
      id,
      slotId,
      maxRounds: 1,
      maxTurns: maxRequests,
      executionId: span.id,
    });
    store.updateAutoResearch(id, {
      topology,
      maxRounds: 1,
      summary: `Fact-check (${topology}): check every claim through tool-using agents, then correct the story.`,
      recorded: Boolean(run.replay),
      recordedCostUsd: run.replay?.costUsd ?? null,
      costUsd: null,
      endedAt: null,
    });
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
    return { runId: id, executionId: span.id };
  }

  // LEARNING: The arrangement checks the claims and returns verdicts plus a corrected story; code applies the correction as an undoable edit.
  async function execute(run) {
    let stopReason = "Every claim has a verdict. Open Execution to see each one.";
    try {
      const selection = await gateway.ready();
      owned(run);
      run.model = selection.model;
      store.updateAutoResearch(run.id, { model: run.model });

      // The claim set is derived by CODE from the story (sentence split), so it is identical
      // across arrangements and deterministic. The chosen arrangement decides how its checking
      // agents are organized over those claims.
      const claims = claimsFromStory(run.original);
      if (!claims.length) {
        stopReason = "The story has no claims to check. The current copy was preserved.";
        finish(run, "completed", stopReason);
        return;
      }
      run.claimCount = claims.length;
      initClaimBoard(run, claims);

      const api = topologyApi(run, claims);
      const produced = await strategies[run.topology](api);
      owned(run);
      run.verdicts = produced?.verdicts ?? [];
      // Settle the board from the authoritative verdict set. Graph and swarm already turned
      // each claim as its verdict landed; single's verdicts all arrive together on its final
      // turn, so this is where single's claims move from checking to their verdict. A claim
      // with no verdict (unreached or skipped) stays in whatever state it last held: checking
      // for a unit that stopped mid-check, waiting for one never reached.
      for (const verdict of run.verdicts) {
        setClaimState(run, verdict.claimId, verdict.verdict);
      }
      pushClaimBoard(run, true);

      // Record every verdict as an Execution observation, so the deck can show one verdict per
      // claim with the document ID and verbatim quote that settled it.
      for (const verdict of run.verdicts) {
        record(run, "verdict", {
          status: "complete",
          claimId: verdict.claimId,
          verdict: verdict.verdict,
          docId: verdict.docId,
          quote: verdict.quote,
          correction: verdict.correction,
        });
      }

      // Apply the corrected story as a NORMAL, UNDOABLE copy edit — the same editStory path a
      // human edit uses. There is no evaluator and no keep/revert gate: the corrections the
      // arrangement produced are written to the story and the user can undo them like any edit.
      const correctedStory = produced?.correctedStory ?? null;
      if (correctedStory && correctedStory.body !== run.original.body) {
        run.applying = true;
        try {
          store.editStory(run.slotId, {
            headline: correctedStory.headline,
            body: correctedStory.body,
          });
          run.corrected = true;
        } finally {
          run.applying = false;
        }
        owned(run);
        record(run, "corrected", {
          status: "complete",
          topology: run.topology,
          before: run.original,
          after: copy(currentStory(run)),
          applied: correctedStory.applied ?? [],
          rejected: correctedStory.rejected ?? [],
          effect: "The corrected story was applied as a normal edit; the user can undo it.",
        });
        await store.flush();
        owned(run);
        stopReason = "The agents corrected the story. You can undo the edit.";
      } else {
        stopReason = "The agents found nothing to correct. The story is unchanged.";
      }
      recordPlantedResult(run, correctedStory);
      finish(run, "completed", stopReason);
    } catch (error) {
      const status =
        error.code === "SUPERSEDED"
          ? "superseded"
          : run.controller.signal.aborted
            ? "stopped"
            : error.code === "CONTEXT_LIMIT"
              ? "failed"
              : error.code === "TURN_LIMIT"
                ? "paused"
                : "stopped";
      const failure = errorInfo(error, config);
      const reason =
        error.code === "TURN_LIMIT"
          ? "The request allowance is exhausted. The current copy and verdicts so far are preserved."
          : `${failure.message} Current copy is preserved.`;
      finish(run, status, reason, { error: failure });
    } finally {
      run.unsubscribe?.();
      delete run.original;
    }
  }

  // ==========================================================================
  // SUPPORTING HELPERS - the harness primitives every arrangement shares
  // ==========================================================================

  /**
   * The primitive surface handed to a topology. It cannot bypass the budget, the request
   * ceiling, ownership (CAS) or the trace: every model call is a captured agent request, and
   * every search/read is a bounded, recorded archive observation.
   */
  function topologyApi(run, claims) {
    return {
      run,
      headline: run.original.headline,
      claims: () => {
        return claims.map((claim) => ({ ...claim }));
      },
      current: () => {
        return copy(owned(run));
      },
      // One captured model call for a named agent in its own context, parsed as a turn reply.
      agent: (options) => {
        return phase(run, options.name ?? options.agent, options.input ?? {}, (parentId) => {
          return structuredAgent(run, { ...options, parentId, claimId: options.input?.claimId ?? null });
        });
      },
      // Run ONE per-claim (graph) or per-hop (swarm) call in isolation: an output/deadline/
      // empty wall leaves that unit unsettled and lets the others proceed; run-level faults
      // re-throw.
      perClaim: (claimId, label, work) => {
        // A graph verifier starts checking exactly one claim; mark it checking and push as the
        // per-claim unit begins, so the board shows the claim in hand before its verdict lands.
        // Swarm per-hop units are keyed by specialist, not claim, so claimId is not in the
        // board and setClaimState is a no-op for them (swarm marks its area via markChecking).
        // The push is coalesced, so concurrent graph workers do not each add a store flush.
        setClaimState(run, claimId, "checking");
        pushClaimBoard(run);
        return runPerClaim(run, claimId, label, work);
      },
      // The bundled archive, searched and read by every arrangement. search returns up to five
      // {id,title}; read returns {id,title,text} or null for an unknown ID.
      search: (query) => {
        return searchArchive(query);
      },
      read: (docId) => {
        return readArchive(docId);
      },
      // The one sentence of the current body a claim appears in, for a correction that
      // replaces exactly that sentence.
      sentenceFor: (claimId) => {
        const claim = claims.find((entry) => entry.id === claimId);
        return claim ? sentenceFor(owned(run), claim.text) : null;
      },
      // Apply a list of {find, replace} corrections to the current copy and return the
      // corrected {headline, body} plus the applied/rejected ledger. Null when nothing applied.
      applyCorrections: (current, edits) => {
        const result = applyRevisionEdits({
          headline: current.headline,
          body: current.body,
          edits,
        });
        if (!result.applied.length) {
          return null;
        }
        return {
          headline: result.headline,
          body: result.body,
          applied: result.applied,
          rejected: result.rejected,
        };
      },
      note: (kind, data) => {
        // The arrangements already emit a per-claim verdict note the moment a claim settles
        // (graph_verdict, swarm_verdict). Fold that into the board so a settled claim turns to
        // its verdict state in real time, through the same signal the raw view records.
        if ((kind === "graph_verdict" || kind === "swarm_verdict") && data?.claimId && data?.verdict) {
          setClaimState(run, data.claimId, data.verdict);
          pushClaimBoard(run);
        }
        return record(run, kind, data);
      },
      // Session 3 claim board hooks the arrangements call directly. markChecking moves a group
      // of claims into the checking state (single marks all; a swarm specialist marks its
      // area); pushBoard requests a coalesced snapshot push. Both are cheap and add no store
      // flush beyond the coalesced one.
      markChecking: (claimIds) => {
        markClaimsChecking(run, claimIds);
        pushClaimBoard(run);
      },
      pushBoard: () => {
        pushClaimBoard(run);
      },
      remainingRequests: () => {
        return Math.max(0, run.maxRequests - run.requests);
      },
      hop: () => {
        run.hops++;
      },
      hops: () => {
        return run.hops;
      },
      concurrentVerifiers: run.concurrentVerifiers !== false,
      constraints: run.constraints,
      owned: () => {
        return owned(run);
      },
    };
  }

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
      // The fact-check applies its own correction, which advances contentVersion. Accept the
      // run's own applied edit by tracking the version it wrote; any OTHER change is a supersede.
      (story.contentVersion !== run.contentVersion && !run.applying && !run.corrected) ||
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

  // Session 3 demo display: for a story with planted errors, record which ones this run
  // caught (verdict "contradicted") and which it missed, with each sentence's current text
  // so the editor can still find a caught sentence after its correction was applied. Pure
  // bookkeeping after the run; the arrangements never see the planted list.
  function recordPlantedResult(run, correctedStory) {
    const story = store.snapshot().issue.stories.find((item) => item.slotId === run.slotId);
    const planted = story?.plantedClaims ?? [];
    if (!planted.length) {
      return;
    }
    const verdictById = new Map(run.verdicts.map((entry) => [entry.claimId, entry.verdict]));
    const replaced = new Map(
      (correctedStory?.applied ?? []).map((edit) => [String(edit.find).trim(), String(edit.replace).trim()]),
    );
    const result = planted.map((claim) => {
      const caught = verdictById.get(claim.id) === "contradicted";
      const text = (caught && replaced.get(claim.text.trim())) || claim.text;
      return { id: claim.id, status: caught ? "caught" : "missed", text };
    });
    store.update(
      (issue) => {
        const target = issue.stories.find((item) => item.slotId === run.slotId);
        if (target) {
          target.plantedResult = { topology: run.topology, claims: result };
        }
      },
      { action: "planted_result", history: false, data: { slotId: run.slotId } },
    );
    record(run, "planted_result", {
      status: "complete",
      caught: result.filter((entry) => entry.status === "caught").length,
      missed: result.filter((entry) => entry.status === "missed").length,
    });
  }

  // Run one claim's (or hop's) model work in isolation. A per-claim-isolatable code records a
  // claim-skip in Execution and returns null so the caller leaves that unit unsettled and
  // moves on; any other fault re-throws and stops the run.
  async function runPerClaim(run, claimId, label, work) {
    try {
      return await work();
    } catch (error) {
      if (!PER_CLAIM_ISOLATABLE.has(error?.code) || run.controller.signal.aborted) {
        throw error;
      }
      const failure = errorInfo(error, config);
      record(run, "claim_skip", {
        status: "incomplete",
        claimId,
        label,
        code: error.code,
        reason: `no answer for ${claimId}: ${label} produced no usable reply`,
        effect: `This unit's ${label} produced no answer, so it was left unsettled. The others continued.`,
        error: failure,
      });
      return null;
    }
  }

  // LEARNING: One captured model call, charged against the shared request ceiling, grouped under its agent.
  async function structuredAgent(run, { agent, name, messages, purpose, parentId, parse, maxOutputTokens, claimId = null }) {
    owned(run);
    if (run.requests >= run.maxRequests) {
      throw new ResearchError("TURN_LIMIT", "The run reached its model-request limit.");
    }
    run.requests++;
    run.agents++;
    store.updateAutoResearch(run.id, { turn: run.requests, agents: run.agents, costUsd: runCost(run) });
    const started = Date.now();
    let result;
    let parsed;
    try {
      result = await model(run, messages, purpose, parentId, { agent, maxOutputTokens, claimId });
      owned(run);
      parsed = parse ? parse(result.json ?? result.text) : result;
    } catch (error) {
      // GPT-6 Luna sometimes answers a turn by emitting SEVERAL distinct JSON objects in
      // one reply (its search turn, its read turn and its verdict turn all at once). The
      // gateway's strict json_object parse rejects that as conflicting objects and throws
      // JSON_RESPONSE, carrying the raw text. The turn loop only needs the FIRST object
      // (the move the agent wants NOW; the real tool results come back next turn), so when
      // the strict parse fails but raw text is available, re-parse it leniently with the
      // turn parser, which extracts the first well-formed object. This is exactly how the
      // validated broker runs recovered the same model's batched replies. The call still
      // counts as one request and is logged; a genuinely unusable reply re-throws so the
      // turn loop's retry/skip handling applies.
      if (error?.code === "JSON_RESPONSE" && typeof error.text === "string" && parse) {
        try {
          parsed = parse(error.text);
          result = { operationId: error.operationId, usage: error.usage, text: error.text };
          record(run, "json_salvage", {
            status: "complete",
            agent,
            effect: "The model batched several objects into one reply; the first turn object was recovered.",
          });
        } catch {
          throw error;
        }
      } else {
        throw error;
      }
    }
    owned(run);
    run.agentLog.push({
      agent,
      name,
      operationId: result.operationId,
      elapsedMs: Date.now() - started,
      inputTokens: result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? result.usage?.completion_tokens ?? null,
      contextBytes: Buffer.byteLength(JSON.stringify(messages)),
      costUsd: reportedCost(result.usage),
    });
    return parsed;
  }

  async function model(run, messages, purpose, parentId, { agent, maxOutputTokens, claimId = null }) {
    owned(run);
    // Session 3 demo toggle: a recorded run answers from the bundled recording instead of the
    // broker. The reply (text, parsed JSON, usage) comes back in the same shape the gateway
    // returns, so parsing, salvage, verdicts, corrections, execution records and plantedResult
    // are all produced by the real code path; a batched reply still throws JSON_RESPONSE for
    // the harness's first-object recovery. No network call, no reservation, no cost.
    if (run.replay) {
      store.updateAutoResearch(run.id, { turn: run.requests });
      await store.flush();
      owned(run);
      const paced = config.demoReplayPacing !== false;
      const paceMs = replayPaceMs(paced, run.replay.durationFor({ purpose, claimId }));
      if (paceMs > 0) {
        await replayDelay(paceMs, run.controller.signal);
      }
      owned(run);
      const result = run.replay.completeText({ purpose, claimId });
      result.agent = agent;
      return result;
    }

    owned(run);
    store.updateAutoResearch(run.id, { turn: run.requests });
    await store.flush();
    owned(run);
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(
        new ResearchError(
          "CALL_DEADLINE",
          `A single ${agent} call did not settle within ${Math.round(CALL_DEADLINE_MS / 1000)} s; it was stopped before the broker's per-request limit.`,
        ),
      );
    }, CALL_DEADLINE_MS);
    const signal = AbortSignal.any([run.controller.signal, deadline.signal]);
    try {
      const result = await gateway.completeText({
        messages,
        model: run.model,
        purpose,
        jsonOnly: true,
        requestKind: "fact_check",
        jobId: run.id,
        requestId: run.id,
        parentId,
        maxOutputTokens,
        signal,
      });
      owned(run);
      result.agent = agent;
      return result;
    } catch (error) {
      if (deadline.signal.aborted && !run.controller.signal.aborted) {
        throw deadline.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function cancel(runId, reason = "You stopped the fact-check. Verdicts so far are kept.") {
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
      return trace.start(`fact_check.${name}`, {
        taskId: run.id,
        jobId: run.id,
        requestId: run.id,
        runId: run.id,
        slotId: run.slotId,
        topology: run.topology,
        label: phaseLabel(name),
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
        status: run.controller.signal.aborted ? "cancelled" : "failed",
        error: errorInfo(error, config),
      });
      throw error;
    }
  }

  function progress(run, phase, patch = {}) {
    run.phase = phase;
    store.updateAutoResearch(run.id, {
      status: "running",
      phase,
      topology: run.topology,
      turn: run.requests,
      ...patch,
    });
  }

  // ==========================================================================
  // CLAIM BOARD - a compact, real-time per-claim status the Execution view reads
  // ==========================================================================

  // Build the board from the derived claim set, in story order, every claim waiting. For the
  // demo story, mark which claims are planted errors so the view can show caught vs missed at
  // a glance; the planted set is display metadata the arrangements never see. Pushed once here
  // so the board appears immediately, then mutated in place as claims are checked.
  function initClaimBoard(run, claims) {
    const planted = new Set(
      (store.snapshot().issue.stories.find((item) => item.slotId === run.slotId)?.plantedClaims ?? [])
        .map((claim) => claim.id),
    );
    run.claimState = new Map();
    run.claims = claims.map((claim) => {
      const entry = { id: claim.id, state: "waiting", planted: planted.has(claim.id) };
      run.claimState.set(claim.id, entry);
      return entry;
    });
    run.claimsDirty = true;
    pushClaimBoard(run, true);
  }

  // Move one claim to a new board state. A verdict string maps to its board state; a bare
  // "checking" marks the claim in progress. Terminal states never regress to checking, so a
  // late checking signal for an already-settled claim is ignored. Cheap: only mutates the
  // in-place entry and marks the board dirty; the snapshot push is coalesced by pushClaimBoard.
  const VERDICT_STATE = {
    supported: "supported",
    contradicted: "contradicted",
    "not enough evidence": "needs_evidence",
  };
  const TERMINAL_CLAIM_STATE = new Set(["supported", "contradicted", "needs_evidence"]);
  function setClaimState(run, claimId, next) {
    const entry = run.claimState?.get(claimId);
    if (!entry) {
      return;
    }
    const state = VERDICT_STATE[next] ?? next;
    if (state === "checking" && TERMINAL_CLAIM_STATE.has(entry.state)) {
      return;
    }
    if (entry.state === state) {
      return;
    }
    entry.state = state;
    run.claimsDirty = true;
  }

  // Mark a group of claims checking at once (single marks all claims; a swarm specialist marks
  // its assigned area). One dirty flag covers the batch.
  function markClaimsChecking(run, claimIds) {
    for (const claimId of claimIds) {
      setClaimState(run, claimId, "checking");
    }
  }

  // Push the board to the snapshot when its shape changed. A fixture graph run settles 160
  // claims across 6 concurrent workers; pushing an identical board on every call would add a
  // store flush per model call for no visible change. Instead a cheap state-count signature
  // gates the push: the board reaches the snapshot the moment a claim enters checking or
  // settles to a verdict, but a repeat push with the same counts is skipped. force bypasses
  // the gate for the terminal points (init, final verdicts, finish). No timer is created; each
  // push rides the existing updateAutoResearch channel.
  function boardSignature(run) {
    const tally = { waiting: 0, checking: 0, supported: 0, contradicted: 0, needs_evidence: 0 };
    for (const entry of run.claims) {
      if (tally[entry.state] !== undefined) {
        tally[entry.state]++;
      }
    }
    return `${tally.waiting}.${tally.checking}.${tally.supported}.${tally.contradicted}.${tally.needs_evidence}`;
  }
  function pushClaimBoard(run, force = false) {
    if (!run.claims || !run.claimsDirty) {
      return;
    }
    const signature = boardSignature(run);
    if (!force && signature === run.claimsSignature) {
      return;
    }
    run.claimsDirty = false;
    run.claimsSignature = signature;
    store.updateAutoResearch(run.id, {
      claims: run.claims.map((entry) => ({ id: entry.id, state: entry.state, planted: entry.planted })),
    });
  }

  // At the end of a run, no claim should still read as checking. A claim with a verdict is
  // already terminal; any other claim left checking was taken but not settled, so it returns to
  // waiting. Forces a final push so the settled board reaches the snapshot.
  function reconcileClaimBoard(run) {
    if (!run.claims) {
      return;
    }
    for (const entry of run.claims) {
      if (entry.state === "checking") {
        entry.state = "waiting";
        run.claimsDirty = true;
      }
    }
    pushClaimBoard(run, true);
  }

  function record(run, kind, data) {
    return inRun(run, run.span.id, () => {
      return trace.record(`fact_check.${kind}`, {
        taskId: run.id,
        jobId: run.id,
        requestId: run.id,
        runId: run.id,
        slotId: run.slotId,
        topology: run.topology,
        ...data,
      });
    });
  }

  function finish(run, status, reason, details = {}) {
    if (!ACTIVE.has(run.status)) {
      return;
    }
    run.status = status;
    // Settle the board at the end: a claim still showing checking was never given a verdict
    // (a swarm specialist took it but handed off without settling it, or a unit stopped
    // mid-check), so it returns to waiting rather than appearing stuck mid-check forever. The
    // honest end-state is that an unsettled claim was not reached to a verdict.
    reconcileClaimBoard(run);
    const summary = runSummary(run, status);
    const summaryLine = `Fact-check (${run.topology}): ${summary.outcome} after ${summary.calls} agent call${summary.calls === 1 ? "" : "s"} across ${summary.agentCount} agent${summary.agentCount === 1 ? "" : "s"}.`;
    record(run, "stop", {
      status,
      reason,
      summary,
      summaryLine,
      requestCount: run.requests,
      agentCount: run.agents,
      hops: run.hops,
      verdicts: run.verdicts,
      ...details,
    });
    store.checkpointAutoResearch?.(run.id, null);
    store.updateAutoResearch(run.id, {
      status,
      phase: "finished",
      topology: run.topology,
      stopReason: reason,
      summary,
      runSummary: summary,
      verdicts: run.verdicts,
      corrected: Boolean(run.corrected),
      costUsd: runCost(run),
      recordedCostUsd: run.replay?.costUsd ?? null,
      endedAt: new Date().toISOString(),
      ...details,
    });
    run.span.finish({
      status,
      reason,
      summary,
      runSummary: summary,
      requestCount: run.requests,
      model: run.model,
    });
  }

  // The compact per-run summary shown in the Execution view: who ran, how many calls and
  // tokens, the largest single context, elapsed, how many claims got which verdict, and
  // whether the story was corrected.
  // Cost of this run alone: the sum of the charges the broker reported for its own calls.
  // Null until a call reports a charge (a recorded run reports none).
  function runCost(run) {
    const charges = run.agentLog.map((entry) => entry.costUsd).filter((value) => typeof value === "number");
    return charges.length ? charges.reduce((total, value) => total + value, 0) : null;
  }

  function runSummary(run, status) {
    const started = Date.parse(run.span.data?.timestamp ?? run.span.startedAt ?? "") || null;
    const agents = [...new Set(run.agentLog.map((entry) => entry.agent))];
    const tokensIn = run.agentLog.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0);
    const tokensOut = run.agentLog.reduce((total, entry) => total + (entry.outputTokens ?? 0), 0);
    const largestContextBytes = run.agentLog.reduce((max, entry) => Math.max(max, entry.contextBytes ?? 0), 0);
    const tally = { supported: 0, contradicted: 0, "not enough evidence": 0 };
    for (const verdict of run.verdicts) {
      if (verdict.verdict in tally) {
        tally[verdict.verdict]++;
      }
    }
    return {
      topology: run.topology,
      agents,
      agentCount: run.agents,
      calls: run.agentLog.length,
      tokensIn,
      tokensOut,
      largestContextBytes,
      hops: run.hops,
      claimCount: run.claimCount ?? run.verdicts.length,
      verdictCount: run.verdicts.length,
      verdictTally: tally,
      corrected: Boolean(run.corrected),
      elapsedMs: started ? Date.now() - started : null,
      costUsd: runCost(run),
      recordedCostUsd: run.replay?.costUsd ?? null,
      outcome: run.corrected ? "corrected" : status === "completed" ? "no change" : status,
      perAgent: run.agentLog,
      verdicts: run.verdicts,
    };
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
      await cancelAll("The application is closing. Verdicts so far are preserved.");
    },
  };
}

// The story's writing constraints, carried for parity with the editor. Not load-bearing for
// the verdict flow, but recorded so the arrangement's calls can honor the frame and audience.
function constraintsFor(story, state) {
  return {
    frameWordLimit:
      state.settings?.measuredWordBudget?.[story.slotId] ??
      (story.frame ? storyWordBudget(story.frame) : null),
    audience: state.issue?.audience ?? null,
    locked: Boolean(story.locked),
    frame: { width: story.frame.width, height: story.frame.height },
  };
}

const PHASE_LABELS = Object.freeze({
  single: "Single agent",
  graph: "Graph",
  swarm: "Swarm",
});
function phaseLabel(name) {
  return PHASE_LABELS[name] ?? name;
}
