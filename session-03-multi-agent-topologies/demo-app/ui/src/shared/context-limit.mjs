/** Use coded failures, never words appearing in successful model output. */
export function contextLimitNotice(state) {
  const failures = [
    ...(state.jobs ?? []), ...(state.autoResearchRuns ?? []),
    ...(state.editorial ? [state.editorial] : []),
  ].filter((entry) => (entry.error?.code ?? entry.errorCode) === "CONTEXT_LIMIT")
    .sort((a, b) => Date.parse(b.startedAt ?? 0) - Date.parse(a.startedAt ?? 0));
  const failure = failures[0];
  if (!failure) return null;
  const error = typeof failure.error === "object" ? failure.error : {};
  const source = error.limitSource ?? failure.limitSource;
  return {
    id: `${state.issue.id}:${state.documentVersion ?? 0}:${failure.id ?? failure.requestId}`,
    title: source === "app_input_bytes" ? "Too much context for this request" : "Too much context for the model",
    message: source === "app_input_bytes"
      ? "The app's input-size guard stopped this request before dispatch. Your work is preserved."
      : "The request exceeded the reported context or token limit. Your work is preserved; reduce the input before retrying.",
    detail: error.message ?? (typeof failure.error === "string" ? failure.error : ""),
    recordId: failure.executionId ?? (failure === state.editorial ? failure.requestId : null),
    taskId: failure.jobId ?? failure.id ?? "",
  };
}
