/** Scripted training responses only. The gateway never selects this in a live mode. */
const sentences = (text) => text.match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.map((part) => part.trim()).filter(Boolean) ?? [text];
const demo = (input) => /fictional|synthetic|simulated/iu.test(input.original.body);
const workflow = "In this invented exercise, a fictional editor compared two toy workflows and recorded the results locally.";
const limits = "The example does not report a real event, product, study, or employer.";

// Test seam: a test may force the fact-check audit to run out of its output budget
// (finish_reason "length", mapped to OUTPUT_LIMIT by the gateway). The audit is a
// RUN-level step, not a per-claim call, so an OUTPUT_LIMIT there stops the whole run
// — per-claim isolation never rescues a failed audit. fixtureAutoResearch returns the
// __forceOutputLimit marker, which fixtureTextCompletion turns into a "length" finish.
// Live modes never set this.
let forceAuditOutputLimit = false;
export function forceAuditOutputLimit_set(value) {
  forceAuditOutputLimit = Boolean(value);
}

export function fixtureAutoResearch(input) {
  if (!input?.task?.startsWith("auto_research_")) return null;
  if (input.task === "auto_research_audit" && forceAuditOutputLimit) {
    // Test seam: force the fact-check audit to run out of its output budget. The audit
    // is a run-level step, so this stops the whole run.
    return { __forceOutputLimit: true, audit: true };
  }
  if (input.task === "auto_research_audit") {
    // The scripted rubric respects the limits the prompt carries so a caller that
    // asks for a smaller audit (the Session 3 fact-check passes claims 3, goal 1)
    // gets a smaller rubric that its own parser accepts. The auto-research stage
    // passes the full limits, so the slices below are no-ops for it.
    const maxClaims = Math.max(1, input.limits?.claims ?? 2);
    const maxGoals = Math.max(1, input.limits?.goals ?? 2);
    const parts = sentences(input.original.body);
    return {
      claims: parts.slice(0, Math.min(2, maxClaims)).map((text, index) => ({
        id: `c${index + 1}`, text, importance: "central",
        query: demo(input) ? "synthetic workshop fictional editor sources" : text.slice(0, 300),
      })),
      goals: [
        { id: "g1", question: "What exactly was compared or observed?" },
        { id: "g2", question: "What conclusions can the available evidence support?" },
      ].slice(0, maxGoals),
    };
  }
  if (input.task === "auto_research_revision") {
    const synthetic = demo(input);
    return {
      headline: synthetic ? "A toy comparison shows a process, not product performance" : input.current.headline || "Unresolved story",
      body: synthetic ? `${workflow} ${limits} Treat the local comparison as a demonstration of a research process. ` +
        "To make claims about real products, collect product-specific measurements and independent evidence " +
        "rather than extending these fictional results." : input.current.body,
      sourceIds: [input.evidence[0].id],
      changes: [synthetic ? "Replace a real-world generalization with the source's explicit limits, retaining the concrete comparison."
        : "A synthetic provider cannot verify this real-world story. Preserve its copy for review."],
    };
  }
  if (input.task === "auto_research_evaluate") {
    const source = input.evidence.find((item) => item.text.includes(limits)) ?? input.evidence[0];
    const report = (story) => {
      const parts = sentences(story.body);
      const corrected = demo(input) && story.body.includes(workflow) && story.body.includes(limits);
      return {
        claims: input.audit.claims.map((claim, index) => ({
          id: claim.id, text: corrected ? [workflow, limits][index] : parts[index] || story.body,
          verdict: corrected ? "supported" : "unresolved",
          citations: corrected ? [{ sourceId: source.id, quote: [workflow, limits][index] }] : [],
          reason: corrected ? "The synthetic source explicitly contains this statement and its limits."
            : "The scripted source does not establish the original statement at this scope.",
        })),
        goals: input.audit.goals.map((goal) => ({ id: goal.id, met: true,
          reason: "The toy story retains a concrete comparison and an explicit scope for its conclusions." })),
        addedClaims: [],
      };
    };
    return {
      baseline: report(input.current), candidate: report(input.candidate),
      nextQueries: ["synthetic workshop sources independent measurement"],
    };
  }
  return null;
}
