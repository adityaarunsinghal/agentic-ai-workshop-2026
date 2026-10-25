import { setTimeout as wait } from "node:timers/promises";
import { abortable, contextFailure, ResearchError } from "./policy.mjs";
import { reportedCost } from "./budget.mjs";

const terminal = new Set(["completed", "failed", "cancelled"]);
const money = (value) => reportedCost({ cost: value }) !== null;

/** A receipt is financial evidence only for the exact operation we sent. */
export function recoveryReceipt(value, { operationId, model, profileId }) {
  if (value?.version !== "workshop.inference-operation.v1" ||
      value.operationId !== operationId || value.modelId !== model ||
      value.profileId !== profileId || !terminal.has(value.phase) ||
      value.usage?.unsettledRequests !== 0 || !money(value.usage?.reservedUsd) ||
      Number(value.usage.reservedUsd) !== 0 || reportedCost(value.usage) === null) return null;
  return { cost: reportedCost(value.usage), noCharge: reportedCost(value.usage) === 0,
    beforeDispatch: value.attemptsUsed === 0 && Array.isArray(value.attempts) && value.attempts.length === 0 };
}

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const delay = Math.ceil(Number(value) * 1000);
    return Number.isSafeInteger(delay) ? delay : null;
  }
  const at = /^[A-Za-z]{3}, /.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export async function responseFailure(response, binding) {
  let body;
  try { body = await response.clone().json(); } catch { /* An unstructured failure cannot prove a charge. */ }
  const supplied = body?.error ?? body;
  const receipt = binding.workshop ? recoveryReceipt(supplied?.details?.recovery, binding) : null;
  const code = typeof supplied?.code === "string" ? supplied.code : `HTTP_${response.status}`;
  const context = contextFailure(supplied, binding);
  const provider = !binding.workshop || Boolean(supplied?.details?.providerError) || code.startsWith("UPSTREAM_");
  const permanentLimit = !provider && code === "RATE_LIMITED" && supplied?.retryable === false;
  const concurrency = !provider && (code === "CONCURRENCY_LIMIT" ||
    supplied?.details?.limitSource === "broker_concurrency");
  const explanation = typeof supplied?.message === "string" ? supplied.message.slice(0, 800) : null;
  const message = permanentLimit
    ? "This visit has reached its request limit. Your newspaper is saved. End this visit and start a new one to continue AI work."
    : response.status === 429
      ? `${provider ? "The model provider rate limited this request (HTTP 429)." :
        concurrency ? "The workshop broker refused this request at its concurrency limit." :
          "The inference service rate limited this request (HTTP 429)."} Your copy and layout are retained.` +
        (explanation ? ` ${explanation}` : "")
      : explanation
        ? explanation
        : `The inference service returned HTTP ${response.status}. Your copy is retained.`;
  const header = response.headers.get("retry-after");
  const delay = retryAfterMs(header);
  const suppliedDelay = supplied?.details?.retryAfterMs;
  const invalidDelay = header !== null && delay === null ||
    supplied?.details?.retryGuidanceInvalid === true ||
    suppliedDelay != null && (!Number.isSafeInteger(suppliedDelay) || suppliedDelay < 0);
  return Object.assign(context ?? new ResearchError(permanentLimit ? "RUN_REQUEST_LIMIT" : code, message), {
    status: response.status, receipt,
    // Retry only an explicit rate refusal with proven zero exposure. Unknown
    // transport outcomes and interrupted streams are never replayed.
    ...(!context && typeof supplied?.retryable === "boolean" ? { retryable: supplied.retryable } : {}),
    safeToRetry: !context && !invalidDelay && response.status === 429 && supplied?.retryable !== false &&
      supplied?.details?.contentForwarded !== true && Boolean(receipt?.noCharge),
    retryAfterMs: header !== null ? delay :
      Number.isSafeInteger(suppliedDelay) && suppliedDelay >= 0 ? suppliedDelay : null,
    operationId: binding.operationId,
    permanent: !context && (permanentLimit || response.status === 402 ||
      ["SESSION_EXPIRED", "SESSION_REVOKED", "ALLOWANCE_EXHAUSTED"].includes(code)),
    raw: body,
  });
}

/** Track independent requests; budgets and the broker own admission limits. */
export function createInferenceControl({ trace, onChange = () => {}, sleep = wait } = {}) {
  let active = 0, blocked = null;
  const waiting = new Map();
  const snapshot = () => ({
    active, queued: 0, retrying: [...waiting.values()],
    blocked: blocked && { code: blocked.code, message: blocked.message },
  });
  const publish = () => onChange(snapshot());
  async function acquire({ signal } = {}) {
    signal?.throwIfAborted();
    if (blocked) throw blocked;
    active++;
    publish();
    let released = false;
    return () => { if (!released) { released = true; active--; publish(); } };
  }
  async function beforeDispatch(signal) {
    signal?.throwIfAborted();
    if (blocked) throw blocked;
  }
  async function retry(error, { attempt, signal, ...metadata }) {
    if (error.permanent) { blocked = error; publish(); return false; }
    if (!error.safeToRetry || attempt > 4) return false;
    const delayMs = Math.max(error.retryAfterMs ?? 0, Math.min(30_000, 2000 * 2 ** (attempt - 1)));
    // A long provider cooldown needs a later user action, not an unbounded job.
    if (delayMs > 60_000) return false;
    const record = { ...metadata, attempt, retryAt: new Date(Date.now() + delayMs).toISOString(),
      message: `${error.message} This rejected attempt was not charged; waiting before retrying.` };
    waiting.set(metadata.operationId, record);
    trace.record("inference.retry_wait", { ...record, status: "waiting", delayMs, code: error.code });
    publish();
    try {
      await abortable(sleep(delayMs, undefined, { signal }), signal);
      await beforeDispatch(signal);
      return true;
    }
    finally { waiting.delete(metadata.operationId); publish(); }
  }
  return { acquire, beforeDispatch, retry, snapshot };
}
