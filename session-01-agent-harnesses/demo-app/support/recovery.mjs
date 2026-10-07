/**
 * The portable recovery-v1 projection. This independently installable app
 * copies only declared public fields; provider bodies and credentials never
 * become recovery metadata. The broker remains the accounting authority.
 */
export const RECOVERY_HEADER = "x-workshop-recovery";
export const RECOVERY_VERSION = "recovery-v1";
export const ATTEMPT_LIMIT_HEADER = "x-workshop-attempt-limit";
export const terminalRecovery = (status) =>
  ["completed", "failed", "cancelled"].includes(status?.phase);

const text = (value) => typeof value === "string" && value.length <= 4096;
const money = (value) =>
  typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value);
const date = (value) => text(value) && Number.isFinite(Date.parse(value));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const nullableText = (value) => value === null || text(value);

/** Invalid or incomplete accounting stays unknown; it never frees a slot. */
export function recoveryStatus(value, operationId, clean = (s) => s) {
  if (
    !value ||
    value.version !== "workshop.inference-operation.v1" ||
    !text(value.operationId) ||
    !value.operationId ||
    (operationId !== undefined && value.operationId !== operationId) ||
    !["running", "retry_wait", "completed", "failed", "cancelled"].includes(
      value.phase,
    ) ||
    !text(value.modelId) ||
    !nullableText(value.profileId) ||
    !integer(value.maxAttempts) ||
    value.maxAttempts < 1 ||
    value.maxAttempts > 3 ||
    !integer(value.attemptsUsed) ||
    value.attemptsUsed > value.maxAttempts ||
    !Array.isArray(value.attempts) ||
    value.attempts.length !== value.attemptsUsed ||
    !(value.nextRetryAt === null || date(value.nextRetryAt)) ||
    !date(value.deadlineAt) ||
    typeof value.responseAvailable !== "boolean" ||
    !money(value.usage?.knownCostUsd) ||
    !money(value.usage?.reservedUsd) ||
    !integer(value.usage?.unsettledRequests) ||
    value.usage.unsettledRequests > value.attemptsUsed
  )
    return null;
  const ids = new Set();
  const attempts = [];
  for (const [index, attempt] of value.attempts.entries()) {
    if (
      attempt?.index !== index + 1 ||
      !text(attempt.operationId) ||
      !attempt.operationId ||
      ids.has(attempt.operationId) ||
      ![
        "reserved",
        "dispatched",
        "uncertain",
        "settled",
        "cancelled",
        "no_charge",
        "conservative",
      ].includes(attempt.state) ||
      typeof attempt.dispatched !== "boolean" ||
      !nullableText(attempt.provider) ||
      !(attempt.actualCostUsd === null || money(attempt.actualCostUsd)) ||
      !money(attempt.reservedUsd)
    )
      return null;
    ids.add(attempt.operationId);
    attempts.push({
      index: attempt.index,
      operationId: clean(attempt.operationId),
      state: attempt.state,
      dispatched: attempt.dispatched,
      provider: attempt.provider === null ? null : clean(attempt.provider),
      actualCostUsd: attempt.actualCostUsd,
      reservedUsd: attempt.reservedUsd,
    });
  }
  let failure = null;
  if (value.failure !== null) {
    const raw = value.failure;
    if (
      !raw ||
      !text(raw.code) ||
      !text(raw.message) ||
      !Number.isInteger(raw.status) ||
      raw.status < 100 ||
      raw.status > 599 ||
      typeof raw.retryable !== "boolean" ||
      (raw.correlationId !== undefined && !text(raw.correlationId))
    )
      return null;
    failure = {
      code: clean(raw.code),
      message: clean(raw.message),
      status: raw.status,
      retryable: raw.retryable,
      ...(raw.correlationId === undefined
        ? {}
        : { correlationId: clean(raw.correlationId) }),
    };
  }
  return {
    version: value.version,
    operationId: clean(value.operationId),
    phase: value.phase,
    modelId: clean(value.modelId),
    profileId: value.profileId === null ? null : clean(value.profileId),
    maxAttempts: value.maxAttempts,
    attemptsUsed: value.attemptsUsed,
    nextRetryAt: value.nextRetryAt,
    deadlineAt: value.deadlineAt,
    responseAvailable: value.responseAvailable,
    attempts,
    usage: {
      knownCostUsd: value.usage.knownCostUsd,
      reservedUsd: value.usage.reservedUsd,
      unsettledRequests: value.usage.unsettledRequests,
    },
    failure,
  };
}

/** Preserve the useful error envelope without copying arbitrary details. */
export function safeErrorMetadata(error, clean = (s) => s) {
  const metadata = {};
  const recovery = recoveryStatus(
    error?.recovery ?? error?.details?.recovery,
    undefined,
    clean,
  );
  const status = Number.isInteger(error?.status)
    ? error.status
    : (error?.httpStatus ?? recovery?.failure?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599)
    metadata.status = status;
  if (typeof error?.retryable === "boolean")
    metadata.retryable = error.retryable;
  for (const field of ["correlationId", "operationId"])
    if (text(error?.[field])) metadata[field] = clean(error[field]);
  const details = {};
  for (const field of [
    "errorType",
    "providerName",
    "limitSource",
    "retryAfterHeader",
    "state",
    "billingDisposition",
  ])
    if (text(error?.details?.[field]))
      details[field] = clean(error.details[field]);
  for (const field of [
    "retryGuidanceInvalid",
    "contentForwarded",
    "selectionChanged",
    "responseAvailable",
  ])
    if (typeof error?.details?.[field] === "boolean")
      details[field] = error.details[field];
  if (integer(error?.details?.retryAfterMs))
    details.retryAfterMs = error.details.retryAfterMs;
  if (
    Number.isInteger(error?.details?.upstreamStatus) &&
    error.details.upstreamStatus >= 100 &&
    error.details.upstreamStatus <= 599
  )
    details.upstreamStatus = error.details.upstreamStatus;
  if (Object.keys(details).length) metadata.details = details;
  if (recovery) metadata.recovery = recovery;
  return metadata;
}

/** Outcome.status describes execution; HTTP status has its own field. */
export function outcomeErrorMetadata(error, clean) {
  const { status, ...metadata } = safeErrorMetadata(error, clean);
  return {
    ...metadata,
    ...(status === undefined ? {} : { httpStatus: status }),
  };
}
