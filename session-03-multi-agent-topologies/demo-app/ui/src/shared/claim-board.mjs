// LEARNING: SESSION 3 CLAIM BOARD DERIVATION
// Pure, framework-free logic for the claim board: pick the fact-check run to show and project
// its real-time per-claim state into a compact board the Execution view renders. Kept in a
// plain module (no JSX) so Node tests can import it directly and the React view can reuse it.
// Next: ui/src/shared/Execution.jsx renders ClaimBoard over the value returned here.

export const BOARD_ACTIVE = new Set(["queued", "running"]);
export const BOARD_TERMINAL = new Set(["supported", "contradicted", "needs_evidence"]);
export const STATE_LABEL = {
  waiting: "Waiting",
  checking: "Checking",
  supported: "Supported",
  contradicted: "Contradicted",
  needs_evidence: "Not enough evidence",
};
export const TOPOLOGY_LABEL = { single: "Single agent", graph: "Graph", swarm: "Swarm" };

// Pick the fact-check run to board and join it to its story's claim text. When a run is in
// scope (the user opened one), board that run; otherwise board the most recent run that still
// carries a claim array, preferring an active one. Returns null when no fact-check run with a
// claim board exists, so the board simply does not render for non-fact-check scopes.
export function deriveClaimBoard({ autoResearchRuns = [], stories = [], taskId = "", demoMode = false } = {}) {
  const withBoard = autoResearchRuns.filter((run) => Array.isArray(run?.claims) && run.claims.length);
  if (!withBoard.length) {
    return null;
  }
  const scoped = taskId ? withBoard.find((run) => run.id === taskId) : null;
  const active = withBoard.find((run) => BOARD_ACTIVE.has(run.status));
  const run = scoped ?? active ?? withBoard[0];
  if (!run) {
    return null;
  }
  const story = stories.find((item) => item.slotId === run.slotId);
  const claimText = new Map();
  // The story body is one sentence per claim in canonical order; the harness derives claim ids
  // the same way, so the planted-claim list gives text for planted ids and the body split
  // covers the rest. Hover text is best-effort; a missing entry falls back to the claim id.
  for (const planted of story?.plantedClaims ?? []) {
    if (planted?.id && typeof planted.text === "string") {
      claimText.set(planted.id, planted.text);
    }
  }
  const tally = { waiting: 0, checking: 0, supported: 0, contradicted: 0, needs_evidence: 0 };
  let caught = 0;
  let missed = 0;
  let planted = 0;
  // Demo outcome per settled claim, judged against the planted answer key: tp caught a planted
  // error, fn missed one, fp flagged a true claim, tn let a true claim pass.
  const outcomes = { tp: 0, fn: 0, fp: 0, tn: 0 };
  const cells = run.claims.map((entry) => {
    const state = tally[entry.state] === undefined ? "waiting" : entry.state;
    tally[state]++;
    if (entry.planted) {
      planted++;
      if (state === "contradicted") {
        caught++;
      } else if (BOARD_TERMINAL.has(state)) {
        missed++;
      }
    }
    let outcome = null;
    if (demoMode && BOARD_TERMINAL.has(state)) {
      const flagged = state === "contradicted";
      outcome = entry.planted ? (flagged ? "tp" : "fn") : flagged ? "fp" : "tn";
      outcomes[outcome]++;
    }
    return {
      id: entry.id,
      state,
      outcome,
      planted: Boolean(entry.planted),
      text: claimText.get(entry.id) ?? null,
    };
  });
  const terminal = tally.supported + tally.contradicted + tally.needs_evidence;
  return {
    run,
    topology: run.topology ?? "single",
    status: run.status,
    active: BOARD_ACTIVE.has(run.status),
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
    costUsd: typeof run.costUsd === "number" ? run.costUsd : null,
    recordedCostUsd: typeof run.recordedCostUsd === "number" ? run.recordedCostUsd : null,
    recorded: Boolean(run.recordedCostUsd != null || run.recorded),
    outcomes,
    turn: run.turn ?? 0,
    maxTurns: run.maxTurns ?? null,
    cells,
    tally,
    total: cells.length,
    terminal,
    checking: tally.checking,
    caught,
    missed,
    planted,
    falseAlarms: outcomes.fp,
    demoMode: demoMode && planted > 0,
  };
}

export function elapsedLabel(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
// The progress label for the board head: single shows its turn, graph how many checkers are
// working right now, swarm how many claims the current specialist holds.
export function progressLabelFor(board) {
  if (!board) {
    return "";
  }
  if (board.topology === "single") {
    // run.maxTurns is the whole run's request ceiling, not the agent's turn limit, so show the turn alone.
    return `Turn ${board.turn}`;
  }
  if (board.topology === "graph") {
    return `${board.checking} agent${board.checking === 1 ? "" : "s"} checking`;
  }
  return "Specialists handing off work";
}
