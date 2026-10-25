export const CHAT_MODEL = "openai/gpt-6-luna";
export const DECISION_MODELS = Object.freeze([
  "typesafe/jev-1.13",
  "perplexity/pplx-decider-v1.1-27b",
]);
export const MAX_TURNS = 10;
export const DECISION_QUESTION_LIMIT = 128;
export const DECISION_CHOICE_LIMIT = 32;
export const DECISION_QUESTION_ID_LIMIT = 64;

export class ResearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
  }
}

export function inputContextLimit(inputBytes, limitBytes) {
  return Object.assign(new ResearchError("CONTEXT_LIMIT",
    `The complete request is ${inputBytes} bytes, exceeding the app's ${limitBytes}-byte input limit. ` +
    "Reduce the supplied context before trying again. No model request was sent."), {
    limitSource: "app_input_bytes", inputBytes, limitBytes, retryable: false,
  });
}

const contextCodes = new Set([
  "context_limit", "context_length_exceeded", "context_window_exceeded",
  "max_tokens_exceeded", "token_limit_exceeded",
]);
const objectOrEmpty = (value) => isObject(value) ? value : {};

/** Inspect error envelopes only, never assistant text or successful responses. */
export function contextFailure(supplied, { workshop = false } = {}) {
  const error = objectOrEmpty(supplied), details = objectOrEmpty(error.details);
  const provider = objectOrEmpty(details.providerError ?? error);
  const metadata = objectOrEmpty(provider.metadata);
  let raw = objectOrEmpty(metadata.raw);
  if (typeof metadata.raw === "string") {
    try { raw = objectOrEmpty(JSON.parse(metadata.raw)); } catch { /* Prose is not a typed error. */ }
  }
  const nested = objectOrEmpty(raw.error);
  const layers = [provider, metadata, raw, nested, objectOrEmpty(nested.metadata), details, error];
  const providerCode = layers.flatMap((layer) => [layer.code, layer.type, layer.error_type, layer.errorType])
    .find((code) => typeof code === "string" && contextCodes.has(code.toLowerCase()));
  if (!providerCode) return null;
  const limitSource = ["app_input_bytes", "provider", "broker"].includes(details.limitSource)
    ? details.limitSource
    : !workshop || details.providerError || details.errorType ||
        typeof error.code === "string" && error.code.startsWith("UPSTREAM_")
      ? "provider" : "broker";
  const original = layers.find((layer) => typeof layer.message === "string" && layer.message.trim())?.message;
  return Object.assign(new ResearchError("CONTEXT_LIMIT",
    `${limitSource === "provider" ? "The model provider" : "The inference broker"} rejected the request because it exceeds its context or token limit. ` +
    "Reduce the supplied context or requested output before trying again." +
    (original ? ` ${original.slice(0, 800)}` : "")), {
    limitSource, providerCode, retryable: false,
  });
}

export function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ResearchError(
      "CONFIG",
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  return value;
}

export function turnLimit(value = MAX_TURNS) {
  return integer(value, "maxTurns", 1, MAX_TURNS);
}

export function requireTrace(trace, http = false) {
  for (const method of ["start", "record", ...(http ? ["fetch"] : [])])
    if (typeof trace?.[method] !== "function")
      throw new ResearchError("INTERFACE", `trace.${method} is required.`);
}

export function errorInfo(error, config = {}) {
  let message = String(error?.message ?? error ?? "Research failed.");
  for (const secret of [config.apiKey, config.token])
    if (typeof secret === "string" && secret) message = message.replaceAll(secret, "[redacted]");
  return {
    code: typeof error?.code === "string" ? error.code : "RESEARCH_FAILED",
    message,
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...Object.fromEntries(["limitSource", "providerCode", "retryable", "retryAfterMs", "inputBytes", "limitBytes"]
      .filter((key) => ["string", "number", "boolean"].includes(typeof error?.[key]))
      .map((key) => [key, error[key]])),
  };
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireText(value, name, maximum = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new ResearchError("INPUT", `${name} must contain 1–${maximum} characters.`);
  return value.trim();
}

export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

export function correlation(job, extra = {}) {
  return {
    jobId: job.id,
    requestId: job.requestId,
    slotId: job.slotId,
    issueId: job.issueId,
    parentId: job.parentId,
    ...extra,
  };
}

/** Pi retains opaque provider replay in its transcript, outside the public inspector. */
export function inspectable(value) {
  if (Array.isArray(value)) return value.map(inspectable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    ["thinkingSignature", "thoughtSignature", "providerReplay", "reasoning_details"].includes(key)
      ? "[retained by Pi on server]"
      : inspectable(entry),
  ]));
}
