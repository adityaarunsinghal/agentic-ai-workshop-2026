// LEARNING: Scripted, deterministic responses for the Session 3 fact-check turn loop.
// The gateway never selects this in a live mode. In fixture mode (the free preview) it
// drives all three arrangements through the SAME turn loop a live model would: the first
// turn asks to search and read the archive, and the next turn, now that the fixture "has
// read" the gold document, returns the verdicts. The verdicts are drawn from the dataset's
// answer key, so a fixture run reproduces exactly what the arrangements demonstrate: true
// claims come back supported, the twenty wrong claims come back contradicted with the
// corrected value, and the corrected story is applied as a normal edit.
//
// The turn prompts are PROSE (not a JSON object), so the fixture recognizes a fact-check
// turn by a marker in the system message and reads the claim IDs and tool history out of
// the user message by pattern, rather than parsing the whole message as JSON.

import { answerKey, ARCHIVE_CLAIMS } from "../fact-check/archive.mjs";

// Marker phrase that only the fact-check turn prompts carry (see topology-prompts.mjs
// TOOLS). Used to recognize a fact-check turn without parsing the prose user message.
const FACT_CHECK_MARKER = "county library system's document archive";

const KEY = new Map(answerKey().map((entry) => [entry.claimId, entry]));
const CLAIM_BY_TEXT = new Map(ARCHIVE_CLAIMS.map((claim) => [claim.text.trim(), claim]));

// Test seam: force a claim's per-claim call to spend its whole output budget on reasoning
// and return nothing (finish_reason "length"), which the gateway maps to OUTPUT_LIMIT. This
// drives the per-claim/per-hop isolation path deterministically. Live modes never set this.
const forcedOutputLimitClaims = new Set();
export function forceOutputLimitForClaims(claimIds) {
  forcedOutputLimitClaims.clear();
  for (const id of claimIds ?? []) {
    forcedOutputLimitClaims.add(id);
  }
}

// Recognize a fact-check turn and return the scripted reply, or null if this is not one.
// messages is the full completion payload's message list.
export function fixtureFactCheck(messages) {
  const system = textOf(messages.find((message) => message.role === "system")?.content);
  if (!system.includes(FACT_CHECK_MARKER)) {
    return null;
  }
  const user = textOf([...messages].reverse().find((message) => message.role === "user")?.content);
  const claimIds = claimIdsIn(user);
  const isSwarm = system.includes("swarm of fact-checkers");
  const isFinalTurn = user.includes("This is your final turn");
  const hasReadSomething = user.includes("read(") && user.includes("branch");

  // A forced claim (a single-claim graph checker) returns the output-limit marker on its
  // first turn, before any verdict. Keyed on the one claim the turn carries.
  if (claimIds.length === 1 && forcedOutputLimitClaims.has(claimIds[0])) {
    return { __forceOutputLimit: true, claimId: claimIds[0] };
  }

  // Turn one (nothing read yet): ask to search for and read the gold document of each claim
  // this turn owns. The dataset's gold document for a claim is the one that settles it, so
  // "reading" it next turn gives the fixture the grounds to return the right verdict. On the
  // swarm's first (triage) hop with no claims assigned, hand off to the first specialist.
  if (!hasReadSomething && !isFinalTurn) {
    if (isSwarm && !claimIds.length) {
      return { calls: [], done: false, verdicts: [], handoff: firstSpecialist() };
    }
    const calls = [];
    for (const id of claimIds.slice(0, 10)) {
      const entry = KEY.get(id);
      if (entry?.gold) {
        calls.push({ tool: "read", arg: entry.gold });
      }
    }
    if (!calls.length) {
      // No archive-backed claims this turn (a derived free-standing claim): settle as not
      // enough evidence so the loop still terminates.
      return finalReply(claimIds, isSwarm);
    }
    return { calls, done: false, verdicts: [] };
  }

  // A later turn (the fixture has "read" the gold documents, or this is the final turn):
  // return the verdicts for the claims this turn owns.
  return finalReply(claimIds, isSwarm);
}

// Build the final verdict reply for the given claims from the answer key. A supported claim
// cites its gold document with a verbatim quote drawn from it; a wrong claim comes back
// contradicted with the corrected sentence. The swarm also hands off after settling, so its
// path records in order; it hands off to "done" implicitly by setting done when every claim
// it owns is settled.
function finalReply(claimIds, isSwarm) {
  const verdicts = claimIds.map((id) => {
    const entry = KEY.get(id);
    if (!entry) {
      return { claimId: id, verdict: "not enough evidence", docId: "", quote: "", correction: "" };
    }
    if (entry.truth === "supported") {
      return {
        claimId: id,
        verdict: "supported",
        docId: entry.gold,
        quote: quoteFor(entry),
        correction: "",
      };
    }
    return {
      claimId: id,
      verdict: "contradicted",
      docId: entry.gold,
      quote: quoteFor(entry),
      correction: correctionFor(entry),
    };
  });
  const reply = { calls: [], done: true, verdicts };
  if (isSwarm) {
    // A specialist that has settled its claims sets done; the swarm loop ends when every
    // claim has a verdict. No further handoff is needed from a specialist that finished.
    reply.handoff = "done";
  }
  return reply;
}

// A short verbatim fragment of the claim's gold document, so a supported verdict carries a
// real quote the harness can verify against the archive. The dataset's gold documents state
// the fact in one sentence; the fixture quotes the claim's own corrected value, which the
// gold document contains verbatim.
function quoteFor(entry) {
  if (entry.truth === "supported") {
    // The claim text matches the gold document's statement, so quote a stable fragment of it.
    return entry.text.replace(/\.$/, "");
  }
  return entry.fix ? String(entry.fix) : entry.text.replace(/\.$/, "");
}

// The corrected sentence for a wrong claim: the claim's own sentence with its wrong value
// replaced by the dataset's fix. The dataset ships the fix as the corrected token, so the
// correction is the claim text with that token substituted.
function correctionFor(entry) {
  const claim = CLAIM_BY_TEXT.get(entry.text.trim());
  if (!claim || !entry.fix) {
    return entry.text;
  }
  // The wrong claim restates a stale value; the fix is the correct value. The fixture builds
  // the corrected sentence from the claim's text and the fix so the applied edit is concrete.
  return correctedSentence(entry.text, claim.kind, entry.fix);
}

// Reconstruct the corrected sentence by swapping the stale value for the fix. The dataset's
// claim text for each kind embeds exactly one value, so a kind-aware swap is deterministic.
function correctedSentence(text, kind, fix) {
  // For every kind the fix is the corrected value that belongs in the sentence; the sentence
  // already has the right shape, so return it with the fix spliced where the value sits. The
  // simplest reliable reconstruction is to replace the trailing value segment per kind.
  switch (kind) {
    case "visits":
      return text.replace(/recorded [\d,]+ visits/, `recorded ${fix} visits`);
    case "opened":
      return text.replace(/opened in \d{4}/, `opened in ${fix}`);
    case "manager":
      // "<name> manages the <branch> branch." -> replace the leading name with the fix.
      return text.replace(/^.*?( manages the )/, `${fix}$1`);
    case "budget":
      return text.replace(/approved \$[\d.]+ million/, `approved ${fix}`);
    default:
      return text;
  }
}

function firstSpecialist() {
  // The triage agent hands off to the visits specialist first; the roster order in
  // topologies.mjs then walks the rest.
  return "visits_checker";
}

// The claim IDs named in a turn's user message. The prompts list claims as "c12: <text>"
// lines under CLAIMS, so a line-start "cN:" pattern recovers exactly this turn's claims.
function claimIdsIn(text) {
  const ids = [];
  const seen = new Set();
  for (const match of String(text).matchAll(/(?:^|\n)(c\d+):/gu)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids;
}

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
