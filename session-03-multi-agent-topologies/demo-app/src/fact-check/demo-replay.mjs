// LEARNING: A recorded fact-check replays real GPT-6 Luna replies through the SAME harness
// and topology code, with no broker request and zero cost. It exists only for the demo
// story under the demo toggle; real execution never touches this path.
//
// The recording (demo-recordings.json) was built from three live GPT-6 Luna runs through the
// workshop broker on the current code and 160-claim story. For each topology it holds, per
// independent agent thread, the ordered list of model replies (reply text + usage + the
// recorded per-call duration). A thread is one agent conversation:
//   single: the one single_checker conversation            -> "single"
//   graph:  each per-claim verifier conversation            -> "graph:<claimId>"
//   swarm:  each specialist's hop sequence                  -> "swarm:<agent>"
//
// The replay answers each fact_check model call POSITIONALLY within its thread: the Nth live
// request to a thread gets the Nth recorded reply for that thread. Positional (not
// turn-number) matching is deliberate. The recording came from a broker run where a few calls
// errored and retried, leaving gaps in turn numbering; on deterministic replay there is no
// broker and every call succeeds, so the live turn sequence is contiguous. Matching by
// position within the thread lines the two up regardless of those gaps.
//
// Next: fact-check.mjs calls this when demoMode is on; createGateway stays untouched.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ResearchError } from "../agent/policy.mjs";
import { parseModelJsonObject } from "../agent/json-response.mjs";

const RECORDINGS_URL = new URL("./demo-recordings.json", import.meta.url);

let cached = null;
function recordings() {
  if (!cached) {
    cached = JSON.parse(readFileSync(fileURLToPath(RECORDINGS_URL), "utf8"));
  }
  return cached;
}

// The agent thread a fact_check call belongs to, from the purpose string the harness sets and
// (for graph) the claimId the harness carries on its per-claim phase span. The purpose format
// is fixed by fact-check.mjs/topologies.mjs: "Fact-check (<topology>): <agent> turn N".
function threadIdFor({ topology, purpose, claimId }) {
  if (topology === "graph") {
    if (!claimId) {
      throw new ResearchError(
        "DEMO_REPLAY",
        `A recorded graph call arrived without a claimId (purpose ${JSON.stringify(purpose)}).`,
      );
    }
    return `graph:${claimId}`;
  }
  // single and swarm are strictly sequential (one model call at a time), so one global
  // thread keyed by the topology preserves their request order. graph is concurrent, so each
  // claim's verifier is its own thread keyed by claimId.
  return topology;
}


/**
 * Create a per-run replay source for one recorded topology. It holds a cursor per agent
 * thread and hands out that thread's recorded replies in order. One instance serves one
 * fact-check run, so its cursors are not shared across runs.
 */
export function createDemoReplay(topology) {
  const data = recordings();
  const recording = data?.topologies?.[topology];
  if (!recording) {
    throw new ResearchError(
      "DEMO_REPLAY",
      `No recorded run is bundled for the ${topology} arrangement.`,
    );
  }
  // Group the flat call list back into per-thread ordered lists by the "<threadId>#<seq>" key.
  const byThread = new Map();
  for (const call of recording.calls) {
    const [threadId, seqText] = String(call.key).split("#");
    const seq = Number(seqText);
    const list = byThread.get(threadId) ?? [];
    list[seq] = call;
    byThread.set(threadId, list);
  }
  const cursors = new Map(); // threadId -> next index

  return {
    topology,
    label: recording.label,
    model: recording.model,
    score: recording.score,
    // What the recorded live run cost through the broker; the replay itself costs nothing.
    costUsd: recording.costUsd ?? null,

    // Answer one fact_check model call from the recording. Mirrors the real gateway's
    // completeText return contract so fact-check.mjs parses, salvages, verdicts and records
    // exactly as it does live: on a clean single JSON object it returns {text, json, usage,
    // operationId}; on a batched reply (several objects in one turn, which GPT-6 Luna emits)
    // it throws JSON_RESPONSE carrying the text, so structuredAgent's salvage path runs.
    completeText({ purpose, claimId }) {
      const threadId = threadIdFor({ topology, purpose, claimId });
      const list = byThread.get(threadId);
      const index = cursors.get(threadId) ?? 0;
      const call = list?.[index];
      if (!call) {
        // single and swarm are one sequential thread, and the live harness winds them down to
        // their own turn/hop limit: it can make ONE more call than the broker run recorded,
        // because the recording stopped capturing when the run ended at that same limit. Past
        // the end of a sequential thread, answer with an empty reply, which throws
        // JSON_RESPONSE exactly as the recorded trailing empty turns did, so the harness winds
        // the run down on its own limit rather than treating the tail as drift. graph is keyed
        // per claim with an exact per-claim turn count, so a missing graph reply is real drift
        // and still errors.
        if (topology !== "graph") {
          cursors.set(threadId, index + 1);
          const operationId = randomUUID();
          throw Object.assign(
            new ResearchError("JSON_RESPONSE", "The model response needs JSON format recovery."),
            { operationId, usage: { input_tokens: null, output_tokens: null }, simulated: true, demoReplay: true },
            { text: "" },
          );
        }
        throw new ResearchError(
          "DEMO_REPLAY",
          `The recorded ${topology} run has no reply for ${threadId} call ${index + 1} ` +
            `(purpose ${JSON.stringify(purpose)}). The recording and the current code have ` +
            `drifted; re-record before replaying.`,
        );
      }
      cursors.set(threadId, index + 1);

      const operationId = randomUUID();
      const usage = {
        input_tokens: call.usage?.input_tokens ?? null,
        output_tokens: call.usage?.output_tokens ?? null,
      };
      const observation = { operationId, usage, simulated: true, demoReplay: true };

      let json;
      try {
        json = parseModelJsonObject(call.text).value;
      } catch {
        // A batched reply the strict parse rejects. Throw exactly as the real gateway does so
        // the harness's lenient first-object recovery runs on the recorded text.
        throw Object.assign(
          new ResearchError("JSON_RESPONSE", "The model response needs JSON format recovery."),
          observation,
          { text: call.text },
        );
      }
      return { text: call.text, json, ...observation };
    },

    // The recorded per-call duration for this thread's next call, used only to pace the
    // replay. Returns null when no duration was captured.
    durationFor({ purpose, claimId }) {
      const threadId = threadIdFor({ topology, purpose, claimId });
      const list = byThread.get(threadId);
      const index = cursors.get(threadId) ?? 0;
      return list?.[index]?.durationMs ?? null;
    },
  };
}

// Whether a recorded run is bundled for a topology (used by tests and by the harness guard).
export function hasRecording(topology) {
  return Boolean(recordings()?.topologies?.[topology]);
}
