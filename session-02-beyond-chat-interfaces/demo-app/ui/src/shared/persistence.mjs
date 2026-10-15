import { supersedeFailedIntents } from "./state.mjs";

// Retire only fields explicitly replaced in the same paper generation.
// Other fields, story slots and foreign-paper failures retain their authority.
export function supersedePersistenceFailures(failures, intent, { issueId, epoch }) {
  return failures.flatMap((failure) => failure.issueId !== issueId || failure.epoch !== epoch
    ? [failure]
    : supersedeFailedIntents([{ ...failure, status: "failed" }], intent));
}

export function persistenceAcknowledgesFailure(persistence, failure) {
  return persistence?.phase === "saved" && persistence.error === null &&
    Number.isSafeInteger(persistence.version) && persistence.version > 0 &&
    Number.isSafeInteger(persistence.acknowledgedRevision) &&
    persistence.version >= failure.version &&
    persistence.acknowledgedRevision >= failure.revision;
}

export function persistenceDisplay(persistence, { pending = false, failed = false, resetting = false } = {}) {
  const phase = persistence?.phase;
  if (resetting) return { label: "Starting new newspaper…", busy: true, saved: false, failed: false };
  if (failed || phase === "failed" || phase === "conflict" || persistence?.error) {
    return {
      label: phase === "conflict" ? "Save conflict" : "Edition not saved",
      busy: false, saved: false, failed: true,
    };
  }
  if (pending || phase === "pending" || phase === "saving")
    return { label: phase === "pending" && !pending ? "Changes pending" : "Saving edition…", busy: true, saved: false, failed: false };
  if (phase === "saved") return { label: "Edition saved", busy: false, saved: true, failed: false };
  return {
    label: phase === "readiness" ? "Readiness preview" : "Save not confirmed",
    busy: false, saved: false, failed: false,
  };
}
