// LEARNING: Trace model and decision requests from payload to response and usage receipt.
// Start: createGateway(), then createConversation(), completeText(), and decide().
// Next: budget.mjs for reservations; inference-control.mjs for dispatch and retries.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { streamSimple as streamPi } from "@earendil-works/pi-ai/api/openai-completions";
import {
  fixtureCompletion,
  fixtureDecisions,
  fixtureTextCompletion,
} from "./fixture.mjs";
import { createInferenceBudget, reportedCost } from "./budget.mjs";
import { createInferenceControl, responseFailure } from "./inference-control.mjs";
import { parseModelJsonObject } from "./json-response.mjs";
import {
  CHAT_MODEL,
  DECISION_MODELS,
  DECISION_QUESTION_LIMIT,
  DECISION_CHOICE_LIMIT,
  DECISION_QUESTION_ID_LIMIT,
  abortable,
  errorInfo,
  inputContextLimit,
  inspectable,
  integer,
  isObject,
  requireText,
  requireTrace,
  ResearchError,
  turnLimit,
} from "./policy.mjs";

const MODES = ["fixture", "local", "development", "hosted"];
const NATIVE_DECISIONS_VERSION = "decisions-v1";
const zeroUsage = () => {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
};

// MAIN BEHAVIOR: configure the boundary, then follow its three model-call paths.

/** Server-only policy/identity adapter. Pi AI owns provider serialization and parsing. */
export function createGateway({ trace, config = {} } = {}) {
  requireTrace(trace, true);
  config = {
    ...config,
    headers: { ...config.headers },
    modelHeaders: { ...config.modelHeaders },
    decisionProfiles: { ...config.decisionProfiles },
    decisionSnapshots: { ...config.decisionSnapshots },
    modelMetadata: structuredClone(config.modelMetadata ?? {}),
    ...(config.allowedModels ? { allowedModels: [...config.allowedModels] } : {}),
  };
  trace.addSecret?.(config.apiKey);
  trace.addSecret?.(config.token);
  const mode = config.mode ?? "fixture";
  if (!MODES.includes(mode)) {
    throw new ResearchError("CONFIG", "Unknown inference mode.");
  }
  const fixture = mode === "fixture";
  const workshop = mode === "development" || mode === "hosted";
  let selectedModel = workshop
    ? null
    : requireText(config.model ?? CHAT_MODEL, "Chat model", 256);
  let profileId =
    !workshop && config.profileId
      ? requireText(config.profileId, "Workshop pricing profile", 256)
      : null;
  const selectedDecisionModel = decisionModel(
    config.decisionModel ?? DECISION_MODELS[0],
  );
  const maxTurns = turnLimit(config.maxTurns);
  const requestedMaxTokens = integer(
    config.maxTokens ?? 32_768,
    "maxTokens",
    64,
    32_768,
  );
  let maxTokens = requestedMaxTokens;
  const timeoutMs = integer(
    config.modelTimeoutMs ?? 360_000,
    "modelTimeoutMs",
    1,
    600_000,
  );
  const bootstrapTimeoutMs = integer(
    config.bootstrapTimeoutMs ?? 5000,
    "bootstrapTimeoutMs",
    1,
    15_000,
  );
  const maxBytes = integer(
    config.maxContextBytes ?? 1_048_576,
    "maxContextBytes",
    1024,
    16_777_216,
  );
  const decisionLimit = integer(
    config.maxDecisionRequests ?? 300,
    "maxDecisionRequests",
    1,
    1000,
  );
  const key = fixture
    ? "fixture-unused"
    : requireText(
        workshop ? config.token : config.apiKey,
        workshop ? "Workshop token" : "OpenRouter API key",
        8192,
      );
  const broker = workshop ? baseUrl(config.brokerUrl, "brokerUrl") : null;
  const chatBase = fixture
    ? "https://fixture.invalid/v1"
    : workshop
      ? `${broker}/v1/llm`
      : baseUrl(config.baseUrl ?? "https://openrouter.ai/api/v1", "baseUrl");
  let decisionsUrl = fixture
    ? "https://fixture.invalid/decisions"
    : workshop
      ? `${broker}/v1/llm/decisions`
      : "https://openrouter.ai/api/alpha/decisions";
  const operations = new Map();
  const budget = createInferenceBudget({ config, trace, fixture });
  const control = createInferenceControl({
    trace,
    onChange: config.onInferenceActivity,
    sleep: config.retrySleep,
  });
  for (const entry of budget.pending) {
    operations.set(entry.operationId, {
      operationId: entry.operationId,
      model: entry.model,
      profileId: entry.profileId,
      kind: entry.kind === "decision" ? "decision" : "chat",
      status: "unknown",
    });
  }
  delete config.initialInferenceEntries;
  let decisionsUsed = 0;
  let editorialUsed = 0;
  let bootstrapPromise;
  let recoveryPromise;
  const recoveryChecks = new Map();
  let nativeDecisions;
  let nativeDecisionsReadAt = 0;
  let nativeRefreshPromise;
  let bootstrapResolved = false;
  let resolvedSelection;

  // MAIN BEHAVIOR: conversational calls, single responses, and typed decisions.

  /**
   * One session per story request. Keep this object for any Pi continuation;
   * neither Agent.continue() nor a fit rewrite creates a fresh allowance.
   */
  function createConversation({
    model: id = selectedModel,
    maxTurns: requestedLimit = maxTurns,
    jobId,
    requestId,
    parentId = trace.context?.().parentId ?? null,
    signal: ownerSignal,
    purpose = "Story research",
    jsonOnly = false,
    requestKind = "story",
    actor = "agent",
  } = {}) {
    if (workshop && !selectedModel) {
      throw new ResearchError(
        "SELECTION_PENDING",
        "Read the workshop model selection before starting a conversation.",
      );
    }
    if (workshop && id !== selectedModel) {
      throw new ResearchError(
        "MODEL_CHANGED",
        "Use the chat model selected by workshop bootstrap before starting a conversation.",
      );
    }
    const model = modelFor(id);
    const limit = Math.min(maxTurns, turnLimit(requestedLimit));
    const operationIds = [];
    const usage = [];
    const ownerId = jobId ?? requestId ?? randomUUID();
    if (requestKind === "story") {
      budget.protectFinal(ownerId, model.id);
    }
    let turns = 0;
    let requests = 0;
    let finalSent = false;
    let finalRequested = null;
    let inFlight = false;
    const finalTurnReason = () => {
      return (
        finalRequested ??
        (turns + 1 >= limit
          ? "max_turns"
          : turns > 0 && requestKind === "story" && !budget.canReserve(model.id)
            ? "remaining_allowance"
            : null)
      );
    };

    const streamFn = (requestedModel, context, options = {}) => {
      if (requestedModel.id !== model.id || requestedModel.baseUrl !== model.baseUrl) {
        return failedStream(
          model,
          new ResearchError(
            "MODEL_CHANGED",
            "A story's model and endpoint are pinned.",
          ),
          options.signal,
        );
      }
      if (inFlight) {
        return failedStream(
          model,
          new ResearchError(
            "CONVERSATION_BUSY",
            "This conversation already has an active turn. Wait for its result before continuing.",
          ),
          options.signal,
        );
      }
      if (turns >= limit || finalSent) {
        trace.record("model.blocked", {
          jobId,
          requestId,
          parentId,
          turns,
          code: "TURN_LIMIT",
        });
        return failedStream(
          model,
          new ResearchError(
            "TURN_LIMIT",
            "The story has exhausted its conversational turns.",
          ),
          options.signal,
        );
      }
      const finalReason = finalTurnReason();
      const final = Boolean(finalReason);
      const toolsDisabled =
        final || getCurrentTools(normalizeContext(context).messages).length === 0;
      inFlight = true;
      const turn = ++turns;
      let operationId = randomUUID();
      finalSent = final;
      const data = {
        operationId,
        jobId,
        requestId,
        parentId,
        purpose,
        requestKind,
        actor,
        turn,
        model: model.id,
        mode,
        profileId,
        simulated: fixture,
      };
      const span = trace.start("model", {
        ...data,
        maxTurns: limit,
        toolsDisabled,
        finalReason,
        maxAttempts: 1,
      });
      operationIds.push(operationId);
      operations.set(operationId, { ...data, kind: "chat", status: "running" });
      const events = createAssistantMessageEventStream();
      let dispatched = false;
      let sdkCalled = false;
      let reportedUsage = null;
      let transportFailure;
      let release;
      const signal = AbortSignal.any([
        ...[ownerSignal, options.signal].filter(Boolean),
        AbortSignal.timeout(timeoutMs),
      ]);

      const sdkDispatch = async (input, init) => {
        if (sdkCalled) {
          throw new ResearchError(
            "SDK_RETRY",
            "A conversational turn permits exactly one SDK dispatch.",
          );
        }
        sdkCalled = true;
        signal.throwIfAborted();
        const request = new Request(input, init);
        if (
          request.url !== `${model.baseUrl}/chat/completions` ||
          request.method !== "POST"
        ) {
          throw new ResearchError(
            "TRANSPORT",
            "The SDK requested an unexpected endpoint.",
          );
        }
        const body = await request.clone().text();
        const payload = JSON.parse(body);
        if (Buffer.byteLength(body) > maxBytes) {
          throw inputContextLimit(Buffer.byteLength(body), maxBytes);
        }
        if (
          payload.model !== model.id ||
          (final && (payload.tool_choice !== "none" || payload.tools?.length))
        ) {
          throw new ResearchError(
            "TURN_LIMIT",
            "The final SDK dispatch must have tools disabled.",
          );
        }
        for (let attempt = 1; ; attempt++) {
          await control.beforeDispatch(signal);
          const reservationUsd = budget.reserve(operationId, {
            model: model.id,
            profileId,
            kind: requestKind,
            payload,
            ownerId,
            final,
          });
          dispatched = true;
          requests++;
          request.headers.set("x-workshop-operation-id", operationId);
          const visibleHeaders = Object.fromEntries(
            [
              "content-type",
              "accept",
              "user-agent",
              "x-stainless-retry-count",
              "x-workshop-contract-version",
              "x-workshop-operation-id",
              "x-workshop-expected-profile",
              "x-workshop-attempt-limit",
            ]
              .filter((name) => {
                return request.headers.has(name);
              })
              .map((name) => {
                return [name, request.headers.get(name)];
              }),
          );
          trace.record("model.request", {
            ...data,
            parentId: span.id,
            payload: inspectable(payload),
            headers: visibleHeaders,
            authorization: "[server credential]",
            serverOnly: true,
            reservationUsd,
            attempt,
          });
          const response = fixture
            ? await (config.fixtureChat?.({ payload, turn, operationId }) ??
                (requestKind === "story"
                  ? fixtureCompletion(payload, { step: turn - 1, ...config.fixture })
                  : fixtureTextCompletion(payload)))
            : await trace.fetch(
                request.url,
                {
                  method: request.method,
                  headers: request.headers,
                  body,
                  signal,
                  redirect: "error",
                },
                {
                  ...data,
                  parentId: span.id,
                  kind: "model.http",
                  maxAttempts: 1,
                  timeoutMs,
                },
              );
          trace.record("model.http_response", {
            ...data,
            parentId: span.id,
            status: response.status,
            headers: Object.fromEntries(response.headers),
            simulated: fixture,
          });
          if (response.ok) {
            return response;
          }
          const failure = await responseFailure(response, {
            operationId,
            model: model.id,
            profileId,
            workshop,
          });
          trace.record("inference.rejected", {
            ...data,
            parentId: span.id,
            status: "failed",
            error: failure.raw,
            code: failure.code,
            receipt: failure.receipt,
            attempt,
          });
          if (failure.receipt) {
            budget.settle(operationId, failure.receipt.cost);
            reportedUsage = { cost: failure.receipt.cost };
          }
          Object.assign(operations.get(operationId), {
            status: "failed",
            error: errorInfo(failure, config),
            usage: failure.receipt ? { cost: failure.receipt.cost } : null,
          });
          // This is a new admission only after an explicit, zero-charge refusal.
          // Never replay accepted requests, partial output or unknown outcomes.
          if (
            !(await control.retry(failure, {
              attempt,
              signal,
              operationId,
              jobId,
              requestId,
              purpose,
            }))
          ) {
            throw failure;
          }
          operationId = randomUUID();
          reportedUsage = null;
          data.operationId = operationId;
          operationIds.push(operationId);
          operations.set(operationId, { ...data, kind: "chat", status: "running" });
        }
      };
      const sdkFetch = async (input, init) => {
        try {
          return await sdkDispatch(input, init);
        } catch (error) {
          // The provider SDK wraps custom-fetch failures as "Connection error".
          // Retain our original admission/transport cause across that boundary.
          transportFailure ??= error;
          throw error;
        }
      };

      void (async () => {
        let message;
        try {
          signal.throwIfAborted();
          await abortable(ready(), signal);
          if (workshop && model.id !== selectedModel) {
            throw new ResearchError(
              "MODEL_CHANGED",
              "Use the chat model selected by workshop bootstrap before starting a conversation.",
            );
          }
          data.profileId = profileId;
          operations.get(operationId).profileId = profileId;
          release = await control.acquire({ signal });
          const provider = streamPi(model, context, {
            ...options,
            apiKey: key,
            headers: headers(operationId, profileId),
            fetch: sdkFetch,
            signal,
            timeoutMs,
            maxRetries: 0,
            maxTokens: model.maxTokens,
            toolChoice: toolsDisabled ? "none" : "auto",
            transport: "sse",
            cacheRetention: "none",
            onPayload: (payload) => {
              if (toolsDisabled) {
                payload.tool_choice = "none";
                delete payload.tools;
              }
              if (jsonOnly) {
                payload.response_format = { type: "json_object" };
              }
              if (!workshop && !fixture) {
                payload.provider = { require_parameters: true, allow_fallbacks: false };
                payload.plugins = [{ id: "context-compression", enabled: false }];
              }
              trace.record("model.sdk_payload", {
                ...data,
                parentId: span.id,
                payload: inspectable(payload),
                serverOnly: true,
              });
              return payload;
            },
            onResponse: (response) => {
              return trace.record("model.sdk_response", {
                ...data,
                parentId: span.id,
                response,
              });
            },
            onProviderStreamEvent: (chunk) => {
              if (chunk.usage) {
                reportedUsage = structuredClone(chunk.usage);
              } else if (chunk.choices?.[0]?.usage) {
                reportedUsage = structuredClone(chunk.choices[0].usage);
              }
              trace.record("model.provider_event", {
                ...data,
                parentId: span.id,
                event: inspectable(chunk),
                serverOnly: true,
              });
            },
          });
          for await (const event of provider) {
            if (event.type !== "done" && event.type !== "error") {
              events.push(event);
            }
          }
          message = await provider.result();
          if (transportFailure) {
            throw transportFailure;
          }
          if (
            final &&
            message.content.some((part) => {
              return part.type === "toolCall";
            })
          ) {
            throw new ResearchError(
              "TURN_LIMIT",
              "The final response requested forbidden tools.",
            );
          }
          if (message.responseModel && message.responseModel !== model.id) {
            throw new ResearchError(
              "MODEL_CHANGED",
              "The provider returned a different chat model.",
            );
          }
          if (
            !["error", "aborted"].includes(message.stopReason) &&
            !message.content.some((part) => {
              return (
                part.type === "toolCall" || (part.type === "text" && part.text.trim())
              );
            })
          ) {
            throw new ResearchError(
              "EMPTY_RESPONSE",
              "The provider returned no usable response; no retry was dispatched.",
            );
          }
          if (message.errorMessage) {
            message.errorMessage = errorInfo(message.errorMessage, config).message;
          }
          if (dispatched) {
            budget.settle(operationId, reportedCost(reportedUsage));
          }
        } catch (error) {
          if (dispatched) {
            try {
              budget.settle(operationId, reportedCost(reportedUsage));
            } catch {
              /* The original cost-limit failure remains visible. */
            }
          }
          message = await failedStream(model, error, signal).result();
        } finally {
          release?.();
          inFlight = false;
        }
        const failed = ["error", "aborted"].includes(message.stopReason);
        usage.push({ operationId, turn, usage: reportedUsage, simulated: fixture });
        Object.assign(operations.get(operationId), {
          status: failed ? "failed" : "completed",
          usage: reportedUsage,
        });
        trace.record("model.response", {
          ...data,
          parentId: span.id,
          status: failed ? message.stopReason : "completed",
          message: inspectable(message),
          usage: reportedUsage,
          sdkUsage: message.usage,
          costBasis: "provider-reported-or-unavailable",
          serverOnly: true,
        });
        span.finish({
          ...data,
          status: failed ? message.stopReason : "completed",
          dispatched,
          usage: reportedUsage,
          error: message.errorMessage ?? null,
          ...(message.errorCode ? { errorCode: message.errorCode } : {}),
        });
        events.push(
          failed
            ? { type: "error", reason: message.stopReason, error: message }
            : { type: "done", reason: message.stopReason, message },
        );
        events.end(message);
      })().catch((error) => {
        const failure = failedStream(model, error, signal);
        void failure.result().then((message) => {
          events.push({ type: "error", reason: message.stopReason, error: message });
          events.end(message);
        });
      });
      return events;
    };
    return {
      model,
      streamFn,
      maxTurns: limit,
      close: () => {
        return budget.releaseFinal(ownerId);
      },
      finishNext: (reason) => {
        if (!["copy_fit", "remaining_allowance", "max_turns"].includes(reason)) {
          throw new ResearchError(
            "INPUT",
            "A final turn needs an explicit copy_fit, remaining_allowance, or max_turns reason.",
          );
        }
        finalRequested ??= reason;
      },
      get turns() {
        return turns;
      },
      get finalTurnReason() {
        return finalTurnReason();
      },
      get finalTurnNeeded() {
        return Boolean(finalTurnReason());
      },
      get finalSent() {
        return finalSent;
      },
      get requests() {
        return requests;
      },
      get operationIds() {
        return [...operationIds];
      },
      get usage() {
        return structuredClone(usage);
      },
    };
  }

  /** One accounted main-model call; a caller-owned research loop also caps its total calls. */
  async function completeText({
    messages,
    purpose = "General-model editorialization",
    model,
    jsonOnly = false,
    json = false,
    signal,
    parentId = trace.context?.().parentId ?? null,
    requestId,
    notify,
    requestKind = "editorial",
    jobId,
  } = {}) {
    if (!Array.isArray(messages) || !messages.length) {
      throw new ResearchError(
        "INPUT",
        "completeText requires a nonempty Pi message array.",
      );
    }
    if (decisionsUsed + editorialUsed >= decisionLimit) {
      throw new ResearchError(
        "DECISION_LIMIT",
        "This visit has exhausted its editorial and auto-research inference allowance.",
      );
    }
    signal?.throwIfAborted();
    const selection = await abortable(ready(), signal);
    signal?.throwIfAborted();
    if (decisionsUsed + editorialUsed >= decisionLimit) {
      throw new ResearchError(
        "DECISION_LIMIT",
        "This visit has exhausted its editorial and auto-research inference allowance.",
      );
    }
    model ??= selection.model;
    requireText(purpose, "Inference purpose", 256);
    const prepared = messages.map((message) => {
      return { ...message, timestamp: message.timestamp ?? Date.now() };
    });
    if (jsonOnly || json) {
      prepared.unshift({
        role: "system",
        content:
          "Return exactly one JSON object, without a Markdown fence, commentary or a second version. End your response immediately after the object's closing brace.",
        timestamp: Date.now(),
      });
    }
    const conversation = createConversation({
      model,
      maxTurns: 1,
      parentId,
      requestId,
      signal,
      purpose,
      jsonOnly: jsonOnly || json,
      requestKind,
      jobId,
      actor: requestKind === "auto_research" ? "agent" : "editor",
    });
    editorialUsed++;
    const stream = conversation.streamFn(
      conversation.model,
      normalizeContext({ messages: prepared }),
      { signal },
    );
    for await (const event of stream) {
      notify?.({
        type: event.type,
        purpose,
        operationId: conversation.operationIds.at(-1),
        ...(event.type === "text_delta" ? { delta: event.delta } : {}),
      });
    }
    const message = await stream.result();
    const operationId = conversation.operationIds.at(-1);
    const observation = {
      model,
      operationId,
      usage: conversation.usage[0]?.usage ?? null,
      simulated: fixture,
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason ?? message.stopReason,
      outputLimitReached: message.stopReason === "length",
      maxOutputTokens: conversation.model.maxTokens,
    };
    if (["error", "aborted"].includes(message.stopReason)) {
      throw Object.assign(
        new ResearchError(
          message.errorCode ?? "INFERENCE_FAILED",
          message.errorMessage ?? "The main model failed.",
        ),
        observation,
        message.errorDetails,
      );
    }
    const text = message.content
      .filter((part) => {
        return part.type === "text";
      })
      .map((part) => {
        return part.text;
      })
      .join("\n")
      .trim();
    let parsed, jsonRecovery;
    if (observation.outputLimitReached) {
      trace.record("model.output_limit", {
        operationId,
        parentId,
        jobId,
        requestId,
        model,
        status: "output-limit",
        maxOutputTokens: observation.maxOutputTokens,
        outputTokens:
          observation.usage?.completion_tokens ??
          observation.usage?.output_tokens ??
          null,
        stopReason: observation.stopReason,
      });
    }
    if (jsonOnly || json) {
      try {
        const result = parseModelJsonObject(text);
        parsed = result.value;
        jsonRecovery = result.recovery;
      } catch (error) {
        throw Object.assign(
          new ResearchError(
            observation.outputLimitReached ? "OUTPUT_LIMIT" : "JSON_RESPONSE",
            observation.outputLimitReached
              ? "The model reached its output limit before returning one usable JSON object."
              : "The model response needs JSON format recovery.",
          ),
          observation,
          { text, parseReason: error.reason ?? "malformed_json" },
        );
      }
      if (jsonRecovery) {
        trace.record("model.json_recovery", {
          operationId,
          parentId,
          jobId,
          requestId,
          model,
          status: "recovered",
          recovery: jsonRecovery,
          stopReason: observation.stopReason,
          outputLimitReached: observation.outputLimitReached,
        });
      }
    }
    return {
      text,
      ...(parsed !== undefined ? { json: parsed } : {}),
      ...(jsonRecovery ? { jsonRecovery } : {}),
      ...observation,
    };
  }

  async function decide({
    state,
    questions,
    model = selectedDecisionModel,
    signal: callerSignal,
    parentId = trace.context?.().parentId ?? null,
    jobId,
    requestId,
  } = {}) {
    decisionModel(model);
    validateQuestions(questions);
    if (!(typeof state === "string" || isObject(state))) {
      throw new ResearchError(
        "DECISIONS",
        "Decision state must be a string or JSON object.",
      );
    }
    const payload = jsonCopy({ model, state, questions }, "Decision request");
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > maxBytes) {
      throw inputContextLimit(Buffer.byteLength(body), maxBytes);
    }
    callerSignal?.throwIfAborted();
    const hadBootstrap = bootstrapResolved;
    await abortable(ready(), callerSignal);
    callerSignal?.throwIfAborted();
    if (decisionsUsed + editorialUsed >= decisionLimit) {
      throw new ResearchError(
        "DECISION_LIMIT",
        "This visit has exhausted its separate decision allowance.",
      );
    }
    let decisionProfile;
    try {
      decisionProfile = nativeProfileFor(model);
    } catch (error) {
      if (!workshop || !hadBootstrap || error.code !== "DECISIONS_UNAVAILABLE") {
        throw error;
      }
    }
    if (
      workshop &&
      hadBootstrap &&
      (decisionProfile === undefined || Date.now() - nativeDecisionsReadAt >= 30_000)
    ) {
      await abortable(refreshNativeDecisions(), callerSignal);
      callerSignal?.throwIfAborted();
      decisionProfile = nativeProfileFor(model);
    }
    // Another independent request may have entered while availability refreshed.
    if (decisionsUsed + editorialUsed >= decisionLimit) {
      throw new ResearchError(
        "DECISION_LIMIT",
        "This visit has exhausted its separate decision allowance.",
      );
    }
    let operationId = randomUUID();
    const data = {
      operationId,
      parentId,
      jobId,
      requestId,
      model,
      profileId: decisionProfile,
      mode,
      simulated: fixture,
      actor: "editor",
      requestKind: "decision",
    };
    const span = trace.start("decision", {
      ...data,
      state: payload.state,
      questions: payload.questions,
      maxAttempts: 1,
    });
    decisionsUsed++;
    operations.set(operationId, {
      ...data,
      kind: "decision",
      status: "running",
      payload,
    });
    let dispatched = false;
    let actualUsage = null;
    let actualModel = model;
    let release;
    const signal = AbortSignal.any([
      ...[callerSignal].filter(Boolean),
      AbortSignal.timeout(timeoutMs),
    ]);
    try {
      release = await control.acquire({
        signal,
        operationId,
        jobId,
        requestId,
        purpose: "Editorial decisions",
      });
      let response;
      for (let attempt = 1; ; attempt++) {
        await control.beforeDispatch(signal);
        const reservationUsd = budget.reserve(operationId, {
          model,
          profileId: decisionProfile,
          kind: "decision",
          payload,
        });
        trace.record("decision.request", {
          ...data,
          parentId: span.id,
          payload,
          reservationUsd,
        });
        dispatched = true;
        response = fixture
          ? new Response(
              JSON.stringify(
                await (config.fixtureDecide?.(payload) ?? fixtureDecisions(payload)),
              ),
              { headers: { "content-type": "application/json" } },
            )
          : await trace.fetch(
              decisionsUrl,
              {
                method: "POST",
                headers: {
                  ...headers(operationId, decisionProfile),
                  "content-type": "application/json",
                },
                body,
                redirect: "error",
                signal,
              },
              {
                ...data,
                parentId: span.id,
                kind: "decision.http",
                maxAttempts: 1,
                timeoutMs,
              },
            );
        if (response.ok) {
          break;
        }
        const failure = await responseFailure(response, {
          operationId,
          model,
          profileId: decisionProfile,
          workshop,
        });
        trace.record("inference.rejected", {
          ...data,
          parentId: span.id,
          status: "failed",
          error: failure.raw,
          code: failure.code,
          receipt: failure.receipt,
          attempt,
        });
        if (failure.receipt) {
          budget.settle(operationId, failure.receipt.cost);
          actualUsage = { cost: failure.receipt.cost };
        }
        Object.assign(operations.get(operationId), {
          status: "failed",
          error: errorInfo(failure, config),
          usage: failure.receipt ? { cost: failure.receipt.cost } : null,
        });
        if (
          !(await control.retry(failure, {
            attempt,
            signal,
            operationId,
            jobId,
            requestId,
            purpose: "Editorial decisions",
          }))
        ) {
          throw failure;
        }
        operationId = randomUUID();
        actualUsage = null;
        data.operationId = operationId;
        operations.set(operationId, {
          ...data,
          kind: "decision",
          status: "running",
          payload,
        });
      }
      const raw = await response.text();
      trace.record("decision.response", {
        ...data,
        parentId: span.id,
        status: response.status,
        body: raw,
      });
      if (!response.ok) {
        throw new ResearchError(
          `HTTP_${response.status}`,
          `Decisions returned HTTP ${response.status}; no fallback or retry was dispatched.`,
        );
      }
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        throw new ResearchError(
          "DECISIONS_RESPONSE",
          "Decisions returned invalid JSON.",
        );
      }
      actualUsage = result.usage ?? null;
      if (typeof result.model === "string") {
        actualModel = result.model;
      }
      budget.settle(operationId, reportedCost(actualUsage));
      validateAnswers(result, payload, config);
      signal.throwIfAborted();
      Object.assign(operations.get(operationId), {
        status: "completed",
        response: result,
        usage: result.usage ?? null,
      });
      const resolvedModel = resolvedDecisionModel(model, result.model, config);
      const output = {
        ...result,
        operationId,
        requestedModel: model,
        model: resolvedModel,
        usage: actualUsage,
        ...(fixture ? { simulated: true } : {}),
      };
      span.finish({
        ...data,
        status: "completed",
        resolvedModel,
        answers: result.answers,
        usage: actualUsage,
      });
      return output;
    } catch (error) {
      if (dispatched) {
        try {
          budget.settle(operationId, reportedCost(actualUsage));
        } catch {
          /* Preserve the original failure. */
        }
      }
      const failure = inferenceFailure(error, signal);
      Object.assign(operations.get(operationId), {
        status: "failed",
        error: failure,
        usage: actualUsage,
      });
      span.finish({ ...data, status: "failed", error: failure });
      throw Object.assign(new ResearchError(failure.code, failure.message), {
        ...failure,
        operationId,
        model: actualModel,
        usage: actualUsage,
        simulated: fixture,
      });
    } finally {
      release?.();
    }
  }

  // SUPPORTING HELPERS: bootstrap, validation, and settlement stay at this boundary.

  function ready() {
    if (!workshop) {
      return Promise.resolve({ mode, model: selectedModel, profileId });
    }
    const hadBootstrap = bootstrapResolved;
    bootstrapPromise ??= (async () => {
      const raw = await readBootstrap();
      const selection = raw.inference?.selection;
      const resolvedProfile = requireText(
        selection?.profileId,
        "Bootstrap pricing profile",
        256,
      );
      const resolvedModel = requireText(
        selection?.modelId,
        "Bootstrap chat model",
        256,
      );
      modelFor(resolvedModel);
      updateNativeDecisions(raw);
      updateOutputCapacity(raw, resolvedModel, resolvedProfile);
      const resolved = {
        mode,
        model: resolvedModel,
        profileId: resolvedProfile,
        fundingMode: raw.inference?.fundingMode ?? null,
        requestedOutputTokens: requestedMaxTokens,
        effectiveOutputTokens: maxTokens,
      };
      resolved.run = {
        id: raw.runId,
        expiresAt: raw.expiresAt,
        budgetUsd: raw.usage?.limitUsd,
      };
      resolved.usage = raw.usage;
      trace.record("inference.selection", resolved);
      await config.onSelection?.(resolved);
      profileId = resolvedProfile;
      selectedModel = resolvedModel;
      resolvedSelection = resolved;
      bootstrapResolved = true;
      return resolved;
    })().catch((error) => {
      bootstrapPromise = undefined;
      throw error;
    });
    return bootstrapPromise.then(async (selection) => {
      if (hadBootstrap && Date.now() - nativeDecisionsReadAt >= 30_000) {
        await refreshNativeDecisions();
      }
      await reconcilePending();
      return { ...(resolvedSelection ?? selection), effectiveOutputTokens: maxTokens };
    });
  }

  async function readBootstrap() {
    const response = await trace.fetch(
      `${broker}/v1/bootstrap`,
      {
        headers: {
          authorization: `Bearer ${key}`,
          "x-workshop-contract-version": config.contractVersion ?? "workshop.app.v1",
          "x-workshop-native-decisions": NATIVE_DECISIONS_VERSION,
        },
        redirect: "error",
        signal: AbortSignal.timeout(bootstrapTimeoutMs),
      },
      { kind: "inference.bootstrap", actor: "gateway", readOnly: true },
    );
    if (!response.ok) {
      throw new ResearchError(
        `HTTP_${response.status}`,
        "Workshop bootstrap is unavailable; no inference was dispatched.",
      );
    }
    return response.json();
  }

  function updateOutputCapacity(raw, model = selectedModel, profile = profileId) {
    if (
      !model ||
      !profile ||
      raw.inference?.selection?.modelId !== model ||
      raw.inference?.selection?.profileId !== profile
    ) {
      return;
    }
    const advertised = raw.inference?.profiles?.find((entry) => {
      return entry.id === profile && entry.modelId === model;
    })?.maxOutputTokens;
    // Earlier C01 projections use the original 4,096-token policy. Wait for
    // the running broker to advertise its new capacity before requesting it.
    const capacity =
      Number.isSafeInteger(advertised) && advertised > 0 ? advertised : 4096;
    const next = Math.min(requestedMaxTokens, capacity);
    if (next !== maxTokens) {
      trace.record("inference.output_capacity", {
        model,
        profileId: profile,
        requestedOutputTokens: requestedMaxTokens,
        effectiveOutputTokens: next,
        advertisedOutputTokens: capacity,
        status: "complete",
      });
    }
    maxTokens = next;
  }

  function updateNativeDecisions(raw) {
    const capability = raw.decisions;
    if (Array.isArray(capability?.models) && typeof capability.url === "string") {
      const advertised = capability.url.startsWith("/v1/")
        ? `${broker}${capability.url}`
        : new URL(capability.url, `${broker}/`).href;
      if (new URL(advertised).origin !== new URL(broker).origin) {
        throw new ResearchError(
          "CONFIG",
          "Native Decisions must use the configured workshop gateway.",
        );
      }
      decisionsUrl = advertised;
    }
    nativeDecisions = capability;
    nativeDecisionsReadAt = Date.now();
  }

  function refreshNativeDecisions() {
    // Availability is a read-only catalog snapshot, not a lifetime permission.
    // Concurrent editorial batches share this read without changing chat selection.
    nativeRefreshPromise ??= readBootstrap()
      .then(async (raw) => {
        updateNativeDecisions(raw);
        const previousCapacity = maxTokens;
        updateOutputCapacity(raw);
        if (resolvedSelection && previousCapacity !== maxTokens) {
          resolvedSelection = {
            ...resolvedSelection,
            effectiveOutputTokens: maxTokens,
            usage: raw.usage ?? resolvedSelection.usage,
          };
          await config.onSelection?.(resolvedSelection);
        }
      })
      .finally(() => {
        nativeRefreshPromise = undefined;
      });
    return nativeRefreshPromise;
  }

  function decisionLimits(model = selectedDecisionModel) {
    const route = nativeDecisions?.models?.find((entry) => {
      return entry.id === model;
    });
    const contextTokens =
      Number.isSafeInteger(route?.contextTokens) && route.contextTokens > 4096
        ? route.contextTokens
        : model === "perplexity/pplx-decider-v1.1-27b"
          ? 262144
          : 64000;
    return {
      contextTokens,
      maxRequestBytes: Math.min(maxBytes, contextTokens - 4096),
      maxQuestions: DECISION_QUESTION_LIMIT,
      maxChoices: DECISION_CHOICE_LIMIT,
    };
  }

  function nativeProfileFor(model) {
    const configured = config.decisionProfiles?.[model] ?? config.decisionProfileId;
    if (!workshop) {
      return configured;
    }
    const routes = Array.isArray(nativeDecisions?.models)
      ? nativeDecisions.models.filter((route) => {
          return route?.id === model;
        })
      : [];
    const route = routes.length === 1 ? routes[0] : null;
    // The decisions-v1 bootstrap advertises native availability separately from chat.
    if (
      nativeDecisions?.version !== NATIVE_DECISIONS_VERSION ||
      !route ||
      route.enabled !== true ||
      route.quoteFresh !== true ||
      typeof route.profileId !== "string" ||
      !route.profileId.trim() ||
      route.profileId.length > 256 ||
      route.profileId.trim() === profileId
    ) {
      throw new ResearchError(
        "DECISIONS_UNAVAILABLE",
        "Workshop bootstrap does not advertise an enabled, freshly quoted native pricing profile for this model; no inference was dispatched.",
      );
    }
    const advertised = requireText(
      route.profileId,
      "Native decision pricing profile",
      256,
    );
    // An explicit native profile is a pin, not permission to bypass availability.
    if (
      configured !== undefined &&
      requireText(configured, "Configured native decision pricing profile", 256) !==
        advertised
    ) {
      throw new ResearchError(
        "MODEL_CHANGED",
        "The advertised native pricing profile differs from the configured decision profile; no inference was dispatched.",
      );
    }
    return advertised;
  }

  function modelFor(id = selectedModel) {
    requireText(id, "Chat model", 256);
    if (config.allowedModels && !config.allowedModels.includes(id)) {
      throw new ResearchError("MODEL_NOT_ALLOWED", `Unsupported chat model: ${id}.`);
    }
    return {
      id,
      name: id,
      api: "openai-completions",
      provider: workshop ? "workshop" : fixture ? "fixture" : "openrouter",
      baseUrl: chatBase,
      input: ["text"],
      reasoning: config.modelMetadata?.reasoning ?? false,
      contextWindow: config.modelMetadata?.contextWindow ?? 128_000,
      maxTokens,
      cost: config.modelMetadata?.cost ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      headers: config.modelHeaders,
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        ...(config.modelMetadata?.compat ?? {}),
      },
    };
  }

  function headers(operationId, profileId) {
    return {
      ...config.headers,
      ...(workshop
        ? {
            "x-workshop-contract-version": config.contractVersion ?? "workshop.app.v1",
            "x-workshop-operation-id": operationId,
            ...(profileId ? { "x-workshop-expected-profile": profileId } : {}),
            "x-workshop-attempt-limit": "1",
          }
        : {}),
      authorization: `Bearer ${key}`,
    };
  }

  /** Recover confirmed charges after a restart without replaying paid requests. */
  async function reconcilePending({ force = false } = {}) {
    if (recoveryPromise) {
      return recoveryPromise;
    }
    const pending = budget.pending
      .filter((entry) => {
        return (
          operations.get(entry.operationId)?.status !== "running" &&
          (force || Date.now() - (recoveryChecks.get(entry.operationId) ?? 0) >= 30_000)
        );
      })
      .slice(0, 10);
    recoveryPromise = Promise.all(
      pending.map(async ({ operationId }) => {
        recoveryChecks.set(operationId, Date.now());
        try {
          await operation(operationId, { signal: AbortSignal.timeout(5000) });
        } catch (error) {
          trace.record("inference.recovery_unavailable", {
            operationId,
            status: "unconfirmed",
            error: errorInfo(error, config),
          });
        }
      }),
    ).finally(() => {
      recoveryPromise = undefined;
    });
    return recoveryPromise;
  }

  /** Explicit read-only recovery/status lookup; never resends an inference request. */
  async function operation(operationId, { signal } = {}) {
    const original = operations.get(operationId);
    if (!original) {
      throw new ResearchError(
        "OPERATION_UNKNOWN",
        "This gateway did not admit that operation.",
      );
    }
    if (!workshop) {
      return structuredClone(original);
    }
    const statusHeaders = headers(operationId, original.profileId);
    delete statusHeaders["x-workshop-attempt-limit"];
    const response = await trace.fetch(
      `${broker}/v1/llm/operations/${encodeURIComponent(operationId)}`,
      {
        headers: statusHeaders,
        redirect: "error",
        signal,
      },
      {
        operationId,
        parentId: original.parentId,
        kind: "inference.status",
        readOnly: true,
      },
    );
    if (!response.ok) {
      throw new ResearchError(
        `HTTP_${response.status}`,
        "The operation status is unavailable.",
      );
    }
    const result = await response.json();
    const status = result.operation ?? result;
    const statusModel = status.modelId ?? status.model;
    if (
      (status.operationId ?? status.id) !== operationId ||
      typeof statusModel !== "string" ||
      (original.kind === "decision"
        ? !resolvedDecisionModel(original.model, statusModel, config)
        : statusModel !== original.model) ||
      (original.profileId !== undefined && status.profileId !== original.profileId)
    ) {
      throw new ResearchError(
        "OPERATION_CHANGED",
        "The broker status does not match the admitted operation.",
      );
    }
    trace.record("inference.status", { operationId, status });
    if (
      ["completed", "failed", "cancelled"].includes(status.phase ?? status.status) &&
      status.usage?.unsettledRequests === 0
    ) {
      budget.settle(operationId, reportedCost(status.usage));
    }
    return status;
  }

  function inferenceFailure(error, signal) {
    const timedOut = signal?.aborted && signal.reason?.name === "TimeoutError";
    const failure = timedOut
      ? {
          code: "INFERENCE_TIMEOUT",
          message:
            "The model response timed out. Your copy is retained. The request may have been charged; check its status before starting another request.",
        }
      : errorInfo(error, config);
    if (signal?.aborted && !timedOut) {
      failure.code = "ABORTED";
    }
    return failure;
  }

  function failedStream(model, error, signal) {
    const failure = inferenceFailure(error, signal);
    const events = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage: zeroUsage(),
      stopReason: signal?.aborted ? "aborted" : "error",
      errorCode: failure.code,
      errorMessage: failure.message,
      errorDetails: failure,
      ...(typeof failure.retryable === "boolean"
        ? { retryable: failure.retryable }
        : {}),
    };
    events.push({ type: "error", reason: message.stopReason, error: message });
    events.end(message);
    return events;
  }

  return {
    mode,
    decisionModel: selectedDecisionModel,
    maxTurns,
    modelFor,
    ready,
    createConversation,
    completeText,
    decide,
    decisionLimits,
    operation,
    recover: () => {
      return reconcilePending({ force: true });
    },
    get model() {
      return selectedModel;
    },
    get maxTokens() {
      return maxTokens;
    },
    get requestedMaxTokens() {
      return requestedMaxTokens;
    },
    get profileId() {
      return profileId;
    },
    get budget() {
      return budget.summary();
    },
    get decisionsUsed() {
      return decisionsUsed;
    },
    get editorialUsed() {
      return editorialUsed;
    },
    get activity() {
      return control.snapshot();
    },
  };
}

// SUPPORTING HELPERS: validate payloads, model identity, and returned answers.

function jsonCopy(value, name) {
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    throw new ResearchError("INPUT", `${name} must be JSON data.`);
  }
  if (!isDeepStrictEqual(copy, value)) {
    throw new ResearchError("INPUT", `${name} must contain only JSON values.`);
  }
  return copy;
}

function decisionModel(model) {
  if (!DECISION_MODELS.includes(model)) {
    throw new ResearchError(
      "MODEL_NOT_ALLOWED",
      `Unsupported decision model: ${String(model)}.`,
    );
  }
  return model;
}

function validateQuestions(questions) {
  if (
    !isObject(questions) ||
    !Object.keys(questions).length ||
    Object.keys(questions).length > DECISION_QUESTION_LIMIT
  ) {
    throw new ResearchError(
      "DECISIONS",
      `Supply 1–${DECISION_QUESTION_LIMIT} independent named questions.`,
    );
  }
  for (const [id, question] of Object.entries(questions)) {
    requireText(id, "Question ID", DECISION_QUESTION_ID_LIMIT);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(id)) {
      throw new ResearchError(
        "DECISIONS",
        "Question IDs must start with a letter and contain only letters, digits, underscores, or hyphens.",
      );
    }
    if (!isObject(question) || !["choice", "noul"].includes(question.type)) {
      throw new ResearchError(
        "DECISIONS",
        "Only native Choice and Noul questions are supported.",
      );
    }
    requireText(question.instructions, "Question instructions", 16_000);
    if (
      !isObject(question.criteria) ||
      Object.values(question.criteria).some((value) => {
        return typeof value !== "string" || !value.trim();
      })
    ) {
      throw new ResearchError("DECISIONS", "Questions need explicit criteria.");
    }
    const keys = Object.keys(question.criteria);
    if (
      question.type === "choice" &&
      (keys.length < 2 || keys.length > DECISION_CHOICE_LIMIT)
    ) {
      throw new ResearchError(
        "DECISIONS",
        `Choice needs 2–${DECISION_CHOICE_LIMIT} predeclared alternatives.`,
      );
    }
    if (
      question.type === "noul" &&
      (keys.length !== 2 || !keys.includes("true") || !keys.includes("false"))
    ) {
      throw new ResearchError("DECISIONS", "Noul criteria must define true and false.");
    }
  }
}

function resolvedDecisionModel(requested, actual, config) {
  const pinned = config.decisionSnapshots?.[requested];
  if (pinned) {
    resolvedDecisionModel(requested, pinned, {});
    if (actual === pinned) {
      return actual;
    }
    throw new ResearchError(
      "MODEL_CHANGED",
      "Decisions did not return the pinned model snapshot.",
    );
  }
  if (actual === undefined) {
    return requested;
  }
  if (actual === requested) {
    return actual;
  }
  if (typeof actual === "string" && actual.startsWith(`${requested}-`)) {
    const date = actual.slice(requested.length + 1);
    if (/^\d{8}$/u.test(date)) {
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      const parsed = new Date(`${iso}T00:00:00Z`);
      if (
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === iso
      ) {
        return actual;
      }
    }
  }
  throw new ResearchError(
    "MODEL_CHANGED",
    "Decisions returned a model outside the requested family.",
  );
}

function validateAnswers(response, payload, config) {
  if (!isObject(response) || !isObject(response.answers)) {
    throw new ResearchError(
      "DECISIONS_RESPONSE",
      "The native Decisions response has no answers.",
    );
  }
  resolvedDecisionModel(payload.model, response.model, config);
  if (
    !isDeepStrictEqual(
      Object.keys(response.answers).sort(),
      Object.keys(payload.questions).sort(),
    )
  ) {
    throw new ResearchError(
      "DECISIONS_RESPONSE",
      "Decisions returned a different question set.",
    );
  }
  const probability = (value) => {
    return Number.isFinite(value) && value >= 0 && value <= 1;
  };
  for (const [id, question] of Object.entries(payload.questions)) {
    const answer = response.answers[id];
    if (!isObject(answer) || answer.type !== question.type) {
      throw new ResearchError("DECISIONS_RESPONSE", `Invalid answer type for ${id}.`);
    }
    if (question.type === "noul") {
      if (!probability(answer.noul) || "confidence" in answer) {
        throw new ResearchError(
          "DECISIONS_RESPONSE",
          "Noul must contain its native probability, without a confidence field.",
        );
      }
    } else {
      if (!Object.hasOwn(question.criteria, answer.choice)) {
        throw new ResearchError(
          "DECISIONS_RESPONSE",
          "Choice selected an undeclared alternative.",
        );
      }
      if (answer.confidence !== undefined && !probability(answer.confidence)) {
        throw new ResearchError(
          "DECISIONS_RESPONSE",
          "Choice returned invalid confidence.",
        );
      }
      if (
        answer.probabilities !== undefined &&
        (!isObject(answer.probabilities) ||
          !isDeepStrictEqual(
            Object.keys(answer.probabilities).sort(),
            Object.keys(question.criteria).sort(),
          ) ||
          Object.values(answer.probabilities).some((value) => {
            return !probability(value);
          }))
      ) {
        throw new ResearchError(
          "DECISIONS_RESPONSE",
          "Choice returned invalid probabilities.",
        );
      }
    }
  }
  return response;
}

function baseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ResearchError("CONFIG", `${name} must be an absolute HTTP URL.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ResearchError(
      "CONFIG",
      `${name} must be an HTTP URL without credentials, a query, or a fragment.`,
    );
  }
  return url.href.replace(/\/$/u, "");
}
