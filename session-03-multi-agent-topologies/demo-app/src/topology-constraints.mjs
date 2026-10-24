// LEARNING: The swarm handoff must carry the story's writing constraints. This
// detector names which constraints a handed-over state failed to carry, so a
// dropped constraint is visible in Execution rather than silently lost.
// A null or partial carry drops the missing ones; a complete carry drops nothing.

export function constraintGaps(constraints, carried) {
  const gaps = [];
  if (!carried || typeof carried !== "object") {
    return ["frame word limit", "audience", "lock state"];
  }
  if (constraints.frameWordLimit != null && carried.frameWordLimit == null) {
    gaps.push("frame word limit");
  }
  if (constraints.audience != null && carried.audience == null) {
    gaps.push("audience");
  }
  if (carried.locked === undefined) {
    gaps.push("lock state");
  }
  return gaps;
}

// A stable alias the Session 3 tests import to exercise the detector directly.
export const constraintGapsForTest = constraintGaps;
