// LEARNING: The three fact-check arrangements. Each runs a tool-using agent through a
// TURN LOOP against the SAME bundled archive, the SAME claims and the SAME search/read
// tools; they differ only in how the checking agents are ORGANIZED:
//   - single: ONE agent owns every claim and checks them in its own loop (slide 6).
//   - graph:  code splits the story into claims and runs ONE checking agent PER claim,
//             concurrently (bounded), then a code router applies the corrections (slides 9-10).
//   - swarm:  specialists by claim area hand work to each other by naming the next agent,
//             bounded by a hop limit; it may cover the story unevenly (slide 14).
// Each arrangement returns per-claim verdicts and a corrected story. There is NO
// independent evaluator and NO keep/revert gate: fact-check.mjs applies the corrected
// story as a normal, undoable edit.
// Next: topology-prompts.mjs holds the turn prompts and parser; archive.mjs holds the tools.

import {
  singleTurnPrompt,
  graphClaimPrompt,
  swarmTurnPrompt,
  parseTurn,
  SWARM_SPECIALISTS,
} from "./topology-prompts.mjs";

export const TOPOLOGIES = Object.freeze(["single", "graph", "swarm"]);

// The single agent and each graph checker get their own turn budget and output cap, set
// to match the workshop broker runs that validated this dataset (broker-run-v3.mjs): the
// all-claims single agent ran up to 30 turns with a 32000-token output ceiling and settled
// in 10-22 turns; each narrow per-claim checker ran up to 8 turns with an 8000-token
// ceiling. A single agent walking the whole 40-claim story needs that many turns to search,
// read and verdict every claim; a per-claim checker settles one claim in a few. Both stay
// well under the shared request ceiling the harness enforces per call.
const SINGLE_MAX_TURNS = 30;
const GRAPH_CLAIM_MAX_TURNS = 8;
// Per-role output-token ceilings, matched to the broker runs. The all-claims single agent
// emits one verdict per claim plus the full corrected story, so it keeps the model's full
// 32000-token output budget; a per-claim checker and a swarm specialist emit a small object
// (a few tool calls or one verdict), so 8000 tokens is ample and settles faster. These clamp
// the gateway's configured ceiling DOWN only.
// The broker caps one streamed reply at 4 MiB, and each streamed token costs a few hundred
// bytes of SSE framing. On the 160-claim story a runaway turn overran the cap at both 32,000
// and 20,000 tokens, so the cap is 12,000: about 3.5 MB worst case, still room for 160 verdicts.
const SINGLE_OUTPUT_TOKENS = 12_000;
const NARROW_OUTPUT_TOKENS = 8_000;
// The swarm's hop limit, sized so the specialists can actually reach every claim area:
// a triage hop plus one hop per specialist, with headroom for a second pass. The deck is
// explicit that the swarm may still not cover the story evenly; the limit is generous
// enough that any gap is the arrangement's behavior, not a starved budget.
const SWARM_MAX_HOPS = 12;
// Graph fan-out concurrency. Each claim checker runs in a continuous pool: when one claim
// finishes, the next starts, so no worker waits for the slowest claim in a batch. Every
// in-flight request holds a broker reservation (about $0.23 for GPT-6 Luna). Twelve at once
// was measured live and barely shortened the run, because each call's broker wait doubled, so
// six stays the setting. If the allowance cannot cover another reservation, the pool narrows by
// one worker instead of failing the run.
const GRAPH_CONCURRENCY = 6;
// A turn whose reply the gateway could not parse as one JSON object (JSON_RESPONSE) or
// whose call spent its whole output budget on reasoning (OUTPUT_LIMIT) is RETRYABLE: the
// agent is nudged to answer with the object only and re-asked, the way the validated
// broker runs recovered from a small model that wrapped its JSON in prose. A stalled
// provider that opened the SSE body then went silent (INFERENCE_TIMEOUT, raised by the
// gateway's stream watchdog, or CALL_DEADLINE from the per-call wall) is also RETRYABLE:
// the gateway already stopped the dead call and the next turn re-asks on a FRESH operation
// id, never replaying the accepted-but-abandoned request's partial output. After a few
// failed retries the agent gives up its remaining turns and contributes what it has.
const RETRYABLE_TURN_CODES = new Set([
  "JSON_RESPONSE",
  "OUTPUT_LIMIT",
  "INFERENCE_TIMEOUT",
  "CALL_DEADLINE",
]);
const MAX_TURN_RETRIES = 3;
// A provider-side failure on one call (the broker's UPSTREAM_* codes, such as "The
// provider reported a failed completion") is a fault of that call, not of the run. It is
// retried on a fresh operation id like a stalled stream; an allowance, session or budget
// refusal is marked permanent and still stops the run.
// A failure the provider reports MID-STREAM arrives through the SDK stream path as
// INFERENCE_FAILED carrying the broker's message, so it is recognized by that message too.
const PROVIDER_FAILURE = /provider reported a failed completion/i;
export function retryableTurnError(error) {
  const code = error?.code;
  if (error?.permanent === true) return false;
  return (
    RETRYABLE_TURN_CODES.has(code) ||
    (typeof code === "string" && code.startsWith("UPSTREAM_")) ||
    (code === "INFERENCE_FAILED" && PROVIDER_FAILURE.test(String(error?.message ?? "")))
  );
}

// ============================================================================
// (a) SINGLE AGENT - one context owns every claim
// ============================================================================

export async function runSingleAgent(api) {
  const claims = api.claims();
  // One agent owns every claim and verdicts them together on its final turn, so the board
  // shows every claim checking for the whole run and settles them when the verdicts land.
  api.markChecking(claims.map((claim) => claim.id));
  const log = [];
  const result = await runTurnLoop(api, {
    agent: "single_checker",
    name: "single",
    maxTurns: SINGLE_MAX_TURNS,
    maxOutputTokens: SINGLE_OUTPUT_TOKENS,
    log,
    buildMessages: ({ turn, forceFinal, retryNote }) => {
      return singleTurnPrompt({
        headline: api.headline,
        claims,
        log,
        turn,
        maxTurns: SINGLE_MAX_TURNS,
        forceFinal,
        retryNote,
      });
    },
  });
  const verdicts = dedupeVerdicts(result.verdicts, claims);
  return { verdicts, correctedStory: correctedStoryFrom(api, verdicts) };
}

// ============================================================================
// (b) GRAPH - one checking agent per claim, concurrent, then a code router
// ============================================================================

export async function runGraph(api) {
  const claims = api.claims();
  // Node 1: CODE splits the story into its claims (already done by the harness, which
  // derived the claim set from the story by sentence split). Node 2 fans out one checking
  // agent per claim; each runs in a fresh context that sees only its one claim. The fan-out
  // runs in bounded batches so a 40-claim story cannot overshoot the request ceiling, and
  // the batches run concurrently so the node's wall time is a batch, not the sum of claims.
  const limit = api.concurrentVerifiers ? GRAPH_CONCURRENCY : 1;
  const queue = [...claims];
  const perClaim = [];
  let workers = Math.min(limit, claims.length);
  let fatal = null;
  async function worker() {
    while (queue.length && !fatal) {
      if (!api.remainingRequests()) {
        return;
      }
      const claim = queue.shift();
      let verdict;
      try {
        verdict = await runClaimChecker(api, claim);
      } catch (error) {
        // Not enough free allowance for one more concurrent reservation: put the claim back
        // and retire this worker; the others keep going. With one worker left, the limit is
        // real and stops the run. Any other run-level fault stops the run.
        // The broker refuses the same shortfall as ALLOWANCE_EXHAUSTED when the class
        // allowance holds less than the app's own ceiling; a genuinely exhausted allowance
        // narrows to one worker and then stops the run as before.
        if (["COST_LIMIT", "ALLOWANCE_EXHAUSTED"].includes(error?.code) && workers > 1) {
          queue.unshift(claim);
          workers--;
          api.note("graph_narrowed", { status: "complete", node: "verifier", concurrency: workers });
          return;
        }
        fatal ??= error;
        return;
      }
      if (verdict) {
        perClaim.push(verdict);
        api.note("graph_verdict", {
          status: "complete",
          node: "verifier",
          claimId: claim.id,
          verdict: verdict.verdict,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (fatal) {
    throw fatal;
  }
  // Node 3: a CODE router by verdict. No model decides the branch; the verdict does. Only
  // contradicted claims carry a correction, so the router sends exactly those to be applied
  // and records the branch so Execution shows it.
  const verdicts = dedupeVerdicts(perClaim, claims);
  const contradicted = verdicts.filter((entry) => entry.verdict === "contradicted");
  api.note("graph_route", {
    status: "complete",
    node: "router",
    supported: verdicts.filter((entry) => entry.verdict === "supported").map((entry) => entry.claimId),
    contradicted: contradicted.map((entry) => entry.claimId),
    needsEvidence: verdicts.filter((entry) => entry.verdict === "not enough evidence").map((entry) => entry.claimId),
    routedToReviser: contradicted.map((entry) => entry.claimId),
  });
  return { verdicts, correctedStory: correctedStoryFrom(api, verdicts) };
}

// One graph checker: a fresh-context agent that owns ONE claim. Runs its own turn loop of
// search/read calls and returns a single verdict. Isolated per claim by the harness, so a
// claim that hits an output or deadline wall is skipped without stopping the others.
function runClaimChecker(api, claim) {
  return api.perClaim(claim.id, "graph verifier", async () => {
    const log = [];
    const result = await runTurnLoop(api, {
      agent: "verifier",
      name: "graph",
      maxTurns: GRAPH_CLAIM_MAX_TURNS,
      maxOutputTokens: NARROW_OUTPUT_TOKENS,
      log,
      claimId: claim.id,
      buildMessages: ({ turn, forceFinal, retryNote }) => {
        return graphClaimPrompt({ claim, log, turn, maxTurns: GRAPH_CLAIM_MAX_TURNS, forceFinal, retryNote });
      },
    });
    const verdict = result.verdicts.find((entry) => entry.claimId === claim.id) ?? result.verdicts[0] ?? null;
    if (!verdict && result.gaveUp) {
      // The checker could not produce a usable reply within its retry budget. Record the
      // claim as skipped so Execution shows it was left unsettled, and leave its sentence
      // unchanged; the other claims' checkers are unaffected.
      api.note("claim_skip", {
        status: "incomplete",
        claimId: claim.id,
        label: "graph verifier",
        code: result.gaveUp,
        reason: `no answer for ${claim.id}: the checker could not return one usable JSON object`,
        effect: `This claim's checker produced no answer, so its sentence was left unchanged. The other claims continued.`,
      });
    }
    return verdict;
  });
}

// ============================================================================
// (c) SWARM - specialists by claim area, handing work to each other
// ============================================================================

export async function runSwarm(api) {
  const claims = api.claims();
  const roster = [...new Set(Object.values(SWARM_SPECIALISTS))];
  // Each claim's area is its dataset kind; the triage agent and the specialists use this to
  // route a claim to the agent whose area matches. Built once from the frozen claim set.
  const claimIndex = claims.map((claim) => {
    return { claimId: claim.id, area: areaFor(claim), text: String(claim.text ?? "").slice(0, 120) };
  });
  // The shared verdict log every specialist writes to and reads from. A claim with a verdict
  // here is settled; a specialist hands off the rest.
  const settled = new Map();
  let next = "triage";
  let hop = 0;
  while (hop < SWARM_MAX_HOPS && next && next !== "done") {
    if (!api.remainingRequests()) {
      break;
    }
    hop++;
    api.hop();
    const specialist = next;
    // The claims in this specialist's area that are not yet settled are its assignment this
    // hop. The triage agent gets none assigned (it routes); a specialist gets its area.
    const area = AREA_OF_SPECIALIST[specialist];
    const assigned = area
      ? claims.filter((claim) => areaFor(claim) === area && !settled.has(claim.id))
      : [];
    // The claims this specialist takes this hop move to checking on the board; a claim it
    // settles turns to its verdict when swarm_verdict lands. Unreached claims stay waiting,
    // which is the honest picture of the swarm's uneven coverage.
    api.markChecking(assigned.map((claim) => claim.id));
    const log = [];
    const turn = await api.perClaim(specialist, `swarm ${specialist}`, async () => {
      return runTurnLoop(api, {
        agent: specialist,
        name: "swarm",
        maxTurns: SWARM_MAX_HOPS,
        log,
        singleCall: true,
        buildMessages: ({ retryNote }) => {
          return swarmTurnPrompt({
            specialist,
            roster,
            claims: assigned,
            assigned,
            claimIndex,
            log,
            turn: hop - 1,
            hopsLeft: SWARM_MAX_HOPS - hop + 1,
            retryNote,
          });
        },
      });
    });
    if (!turn) {
      // A hop that produced no answer makes no change; hand back to the same specialist so
      // the swarm keeps moving, still bounded by the hop and request counters.
      next = specialist;
      continue;
    }
    for (const verdict of dedupeVerdicts(turn.verdicts, assigned.length ? assigned : claims)) {
      if (!settled.has(verdict.claimId)) {
        settled.set(verdict.claimId, verdict);
        api.note("swarm_verdict", {
          status: "complete",
          by: specialist,
          claimId: verdict.claimId,
          verdict: verdict.verdict,
        });
      }
    }
    // A handoff names the next agent. Record it in order so Execution shows the path the
    // swarm actually took. An unknown name ends the run rather than looping forever.
    if (turn.handoff && roster.includes(turn.handoff) && turn.handoff !== specialist) {
      api.note("handoff", { status: "complete", from: specialist, to: turn.handoff });
      next = turn.handoff;
      continue;
    }
    if (turn.done || settled.size >= claims.length) {
      next = "done";
      continue;
    }
    // No explicit handoff and claims remain: advance to the next roster agent so the swarm
    // does not stall on one specialist. This is the emergent-path arrangement, so a weak
    // handoff decision simply shows up as uneven coverage.
    next = nextInRoster(roster, specialist);
  }
  const verdicts = dedupeVerdicts([...settled.values()], claims);
  if (hop >= SWARM_MAX_HOPS && verdicts.length < claims.length) {
    api.note("swarm_hop_limit", {
      status: "incomplete",
      effect: `The swarm reached its ${SWARM_MAX_HOPS}-hop limit with ${verdicts.length} of ${claims.length} claims settled.`,
    });
  }
  return { verdicts, correctedStory: correctedStoryFrom(api, verdicts) };
}

// A claim's area is its dataset kind, mapped to the specialist responsible for it.
function areaFor(claim) {
  return claim.kind ?? null;
}
const AREA_OF_SPECIALIST = Object.freeze({
  visits_checker: "visits",
  branch_history_checker: "opened",
  staff_checker: "manager",
  budget_checker: "budget",
});
function nextInRoster(roster, current) {
  const index = roster.indexOf(current);
  return roster[(index + 1) % roster.length];
}

// ============================================================================
// SHARED TURN LOOP - the tool-using loop every arrangement drives
// ============================================================================

// Drive one agent through a turn loop: it asks for search/read calls, code runs them
// against the archive and records each as an observation, the results are fed back next
// turn, and the loop ends when the agent sets done (or the turn budget runs out). Returns
// the agent's final verdicts and, for the swarm, its one-turn control reply.
//
// singleCall: the swarm advances one hop per harness turn, so its loop runs the agent ONCE
// (letting any requested tool calls run and feeding them nowhere — the next hop re-reads
// the shared log), and returns immediately with that turn's reply. The single and graph
// agents instead loop to completion within their own budget.
async function runTurnLoop(api, { agent, name, maxTurns, maxOutputTokens, log, buildMessages, claimId, singleCall = false }) {
  let retryNote = false;
  let errors = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    if (!api.remainingRequests()) {
      break;
    }
    const forceFinal = turn === maxTurns - 1;
    const messages = buildMessages({ turn, forceFinal, retryNote });
    let reply;
    try {
      reply = await api.agent({
        agent,
        name,
        input: { phase: "turn", turn: turn + 1, claimId },
        messages,
        purpose: `Fact-check (${name}): ${agent} turn ${turn + 1}`,
        maxOutputTokens,
        parse: parseTurn,
      });
    } catch (error) {
      // A reply the gateway could not parse as one JSON object (JSON_RESPONSE), or a call
      // that spent its whole output budget on reasoning (OUTPUT_LIMIT), is a RETRYABLE turn
      // here, not a dead run: nudge the agent to answer with the object only and re-ask,
      // spending the retry against the same turn budget. This is exactly how the validated
      // broker runs recovered from a small model that wrapped its JSON in prose. Any other
      // fault (a supersede, an exhausted request allowance, a cancellation) propagates so a
      // run-level problem still stops the run; the swarm/graph callers isolate a genuinely
      // stuck per-claim or per-hop unit through perClaim.
      if (!retryableTurnError(error)) {
        throw error;
      }
      retryNote = true;
      errors++;
      if (errors >= MAX_TURN_RETRIES) {
        // The agent could not produce one usable JSON object within its retry budget. Give
        // up its remaining turns and signal that it ended stuck, so a graph checker records
        // a claim-skip and the swarm moves on, rather than reporting a confident no-verdict.
        return { verdicts: [], done: false, gaveUp: error.code };
      }
      continue;
    }
    if (!reply) {
      // A per-claim-isolatable skip returned null; stop this agent's loop and let the caller
      // record the claim as unsettled.
      break;
    }
    retryNote = false;
    // Run the requested tool calls and record each as an observation for this agent, then
    // append the results to the agent's own log so its next turn reasons over what it read.
    const results = [];
    for (const call of reply.calls) {
      results.push(runToolCall(api, agent, name, call));
    }
    if (reply.calls.length) {
      log.push({ calls: reply.calls, results });
    }
    if (singleCall) {
      // The swarm hop runs the agent once; return its reply (verdicts and handoff) so the
      // outer swarm loop decides the next hand.
      return reply;
    }
    if (reply.done || (forceFinal && reply.verdicts?.length)) {
      // On the forced final turn, take whatever verdicts arrived as the agent's answer even
      // if it forgot to set done; claims without a verdict count as unchecked.
      return { ...reply, done: true };
    }
    if (!reply.calls.length && !reply.done) {
      // The agent neither acted nor finished; nudge it once, then let the budget end the loop.
      retryNote = true;
      errors++;
      if (errors >= 3) {
        break;
      }
    }
  }
  return { verdicts: lastVerdicts(log), done: false };
}

// Run one tool call against the bundled archive and return a one-line result string the
// agent reads on its next turn. search returns up to five "docId | title" lines; read
// returns the document's full text. Each call is recorded as an Execution observation
// grouped under the agent that made it.
function runToolCall(api, agent, name, call) {
  if (call.tool === "search") {
    const hits = api.search(call.arg);
    api.note("tool_call", {
      status: "complete",
      agent,
      name,
      tool: "search",
      arg: call.arg,
      resultCount: hits.length,
      results: hits.map((hit) => hit.id),
    });
    const line = hits.length ? hits.map((hit) => `${hit.id} | ${hit.title}`).join("; ") : "no results";
    return `search(${JSON.stringify(call.arg)}) -> ${line}`;
  }
  const doc = api.read(call.arg);
  api.note("tool_call", {
    status: doc ? "complete" : "incomplete",
    agent,
    name,
    tool: "read",
    arg: call.arg,
    found: Boolean(doc),
  });
  if (!doc) {
    return `read(${call.arg}) -> unknown document ID`;
  }
  return `read(${doc.id}) -> ${doc.text}`;
}

// The last turn's verdicts in a log, for an agent that ran out of budget without setting
// done. The log carries results, not verdicts, so this returns [] — a budget-exhausted
// agent simply contributes no verdicts and its claims stay unsettled.
function lastVerdicts() {
  return [];
}

// ============================================================================
// VERDICTS AND CORRECTED STORY
// ============================================================================

// Keep one verdict per claim, in claim order, dropping rows that name a claim not in this
// arrangement's set. The last verdict a claim received wins, so a swarm claim re-settled by
// a later specialist takes its final value.
function dedupeVerdicts(verdicts, claims) {
  const known = new Set(claims.map((claim) => claim.id));
  const byClaim = new Map();
  for (const verdict of verdicts ?? []) {
    if (verdict && known.has(verdict.claimId)) {
      byClaim.set(verdict.claimId, verdict);
    }
  }
  return claims.map((claim) => byClaim.get(claim.id)).filter(Boolean);
}

// Build the corrected story from the verdicts: for every contradicted claim that carries a
// correction, replace that claim's sentence in the current body. Returns the corrected
// {headline, body} plus the applied/rejected edit ledger, or null when no correction
// applies (every claim supported or unsettled), in which case the story is left untouched.
function correctedStoryFrom(api, verdicts) {
  const corrections = verdicts.filter((entry) => {
    return entry.verdict === "contradicted" && entry.correction.trim();
  });
  if (!corrections.length) {
    return null;
  }
  const current = api.current();
  const edits = corrections
    .map((entry) => {
      const sentence = api.sentenceFor(entry.claimId);
      if (!sentence) {
        return null;
      }
      return {
        field: "body",
        find: sentence,
        replace: entry.correction.trim(),
        reason: `Claim ${entry.claimId}: ${entry.docId ? `corrected from ${entry.docId}` : "corrected"}.`,
        claimId: entry.claimId,
      };
    })
    .filter(Boolean);
  if (!edits.length) {
    return null;
  }
  return api.applyCorrections(current, edits);
}
