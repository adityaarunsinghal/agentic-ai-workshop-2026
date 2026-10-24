const list = (value) => Array.isArray(value) ? value : [];

// An explicit server availability check takes precedence over a bounded recent
// trace, which may omit a perfectly readable older record.
export function resultExecutionHistory(result = {}) {
  return result.executionHistory ?? {
    available: null, recordId: result.executionId ?? result.requestId ?? null,
    taskId: result.taskId ?? result.jobId ?? null,
    origin: "unknown", label: "Execution history availability is unknown.",
  };
}

export function savedExecutionResult(state, id) {
  if (!id) return null;
  const results = [...list(state?.briefings), state?.editorial, ...list(state?.editorialHistory)];
  return results.find((result) => result && resultExecutionHistory(result).available === false &&
    [result.requestId, result.executionId, result.jobId, result.id].includes(id)) ?? null;
}

export function briefingText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(briefingText).filter(Boolean).join("\n\n");
  return typeof value?.text === "string" ? value.text
    : typeof value?.content === "string" ? value.content : "";
}

export function briefingViews(state, submittedJob = null) {
  const jobs = new Map(list(state.jobs).map((job) => [job.id, job]));
  if (submittedJob && !jobs.has(submittedJob.id)) jobs.set(submittedJob.id, submittedJob);
  const briefings = [...list(state.briefings)];
  for (const job of jobs.values()) {
    if (!(job.id === submittedJob?.id || job.kind === "briefing" || job.requestKind === "briefing" || job.type === "briefing")) continue;
    if (!briefings.some((briefing) => briefing.jobId === job.id || briefing.id === job.briefingId)) {
      briefings.push({ id: job.briefingId ?? job.id, jobId: job.id, prompt: job.prompt });
    }
  }
  return briefings.map((briefing) => {
    const job = jobs.get(briefing.jobId) ?? list(state.jobs).find((entry) => entry.briefingId === briefing.id);
    return {
      ...briefing, job,
      prompt: briefing.prompt ?? job?.prompt ?? "HN briefing",
      status: briefing.status ?? job?.status ?? "pending",
      answer: briefingText(briefing.answer ?? job?.answer),
      cards: list(briefing.cards).filter((card) => card && (typeof card === "object" || typeof card === "string")),
      sourceIds: list(briefing.sourceIds ?? job?.sourceIds ?? briefing.cards?.map((card) => card?.sourceId ?? card?.id)).filter(Boolean),
      partialText: `${briefing.partialTextTruncated ?? job?.partialTextTruncated ? "… " : ""}${briefingText(briefing.partialText ?? job?.partialText)}`,
      phase: briefing.phase ?? job?.phase,
      error: briefing.error ?? job?.error,
      executionHistory: resultExecutionHistory(briefing),
      // Only a current job can be cancelled. Saved IDs confer no authority.
      canCancel: Boolean(job && ["pending", "queued", "researching", "reading", "writing", "running"].includes(job.status)),
    };
  });
}
