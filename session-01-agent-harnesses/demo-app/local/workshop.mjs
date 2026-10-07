/**
 * Explicit local environments for the same application and Agent.
 * Fixture responses are scripted. Live mode uses the supplied OpenRouter key.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  HarnessError,
} from "../agent/pi-mini.mjs";
import { providerContext, inspectableRequest } from "../agent/workshop.mjs";
import { readCompletion } from "../support/stream.mjs";
import { RESOURCE_LIMITS_FOR_HARNESS_TESTING as limits } from "../support/limits.mjs";
import { createLocalHn } from "./hn.mjs";
import { createLocalStore } from "./store.mjs";
import { fixtureCompletion } from "./fixture.mjs";

export function createLocalWorkshop({
  mode,
  env = process.env,
  fetcher = fetch,
  storeFile,
  fixtureDelay = 180,
} = {}) {
  if (!["fixture", "live"].includes(mode))
    throw new Error("Choose the explicit fixture or live local mode.");
  if (
    env.WORKSHOP_RUNTIME === "hosted" ||
    env.WORKSHOP_RUN_TOKEN ||
    env.WORKSHOP_BROKER_URL ||
    env.WORKSHOP_RUN_ID
  )
    throw new Error(
      "Local modes cannot run with hosted workshop configuration.",
    );
  const fixture = mode === "fixture";
  const key = fixture ? null : env.OPENROUTER_API_KEY;
  const modelId = fixture ? "fixture/hn-briefing" : env.OPENROUTER_MODEL;
  if (!fixture && (!key?.trim() || !modelId?.trim()))
    throw new Error(
      "Live local mode requires OPENROUTER_API_KEY and OPENROUTER_MODEL. Set them privately in .env or your environment.",
    );
  if (
    !fixture &&
    (modelId !== modelId.trim() ||
      modelId.startsWith("openrouter/") ||
      /[<>]/.test(modelId))
  )
    throw new Error("Supply an explicit OpenRouter model ID.");
  const source = createLocalHn({ fixture, fetcher });
  const store = createLocalStore(
    storeFile ??
      (fixture
        ? ":memory:"
        : resolve(env.LOCAL_WORKDIR || ".local", "preferences.sqlite")),
  );
  const boot = {
    mode: fixture ? "fixture" : "local",
    runId: randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    inference: {
      selection: { modelId, profileId: fixture ? "scripted" : "local" },
      fundingMode: fixture ? undefined : "personal",
    },
    usage: null,
  };
  const cleanError = (error) => {
    const message = String(error?.message || error || "Local request failed.");
    return key ? message.replaceAll(key, "[redacted]") : message;
  };
  function assertLive(signal) {
    signal?.throwIfAborted();
    if (Date.now() >= Date.parse(boot.expiresAt))
      throw new HarnessError(
        "SESSION_EXPIRED",
        "Restart the local preview to begin a new visit.",
      );
  }
  function stream({ budget, role, forceNoTools = false, notify = () => {} }) {
    return (model, context, { signal }) => {
      const events = createAssistantMessageEventStream();
      void (async () => {
        assertLive(signal);
        if (model.id !== modelId)
          throw new HarnessError(
            "MODEL_CHANGED",
            "The configured local model changed.",
          );
        const converted = providerContext(context.messages);
        const payload = {
          model: modelId,
          messages: converted.messages,
          tools: converted.tools,
          tool_choice:
            forceNoTools || !converted.tools.length || budget.isLast(role)
              ? "none"
              : "auto",
          max_tokens: limits.outputTokens,
          stream: true,
          provider: { require_parameters: true, allow_fallbacks: false },
          plugins: [{ id: "context-compression", enabled: false }],
        };
        const bytes = Buffer.byteLength(JSON.stringify(payload));
        if (bytes > limits.contextBytes)
          throw new HarnessError(
            "CONTEXT_LIMIT",
            "The complete request exceeds the context limit. Start a new conversation.",
          );
        const operationId = randomUUID();
        budget.reserve(
          role,
          operationId,
          1,
          role === "producer" && payload.tool_choice !== "none",
        );
        notify({
          type: "request_start",
          operationId,
          role,
          bytes,
          attemptLimit: 1,
          recoverySupported: false,
          payload: inspectableRequest(payload),
          source: fixture ? "fixture" : "OpenRouter",
        });
        let usage = null;
        try {
          const requestSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(
              Math.max(
                1,
                Math.min(
                  limits.modelMs,
                  Date.parse(boot.expiresAt) - Date.now(),
                ),
              ),
            ),
          ]);
          let response;
          if (fixture) {
            await delay(fixtureDelay, undefined, { signal: requestSignal });
            response = new Response(fixtureCompletion(payload), {
              headers: { "content-type": "text/event-stream" },
            });
          } else {
            response = await fetcher(
              "https://openrouter.ai/api/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${key}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(payload),
                redirect: "error",
                signal: requestSignal,
              },
            );
          }
          if (!response.ok)
            throw new HarnessError(
              `HTTP_${response.status}`,
              `OpenRouter returned HTTP ${response.status}. Check your model, account allowance and provider activity.`,
            );
          const raw = await readCompletion(
            response,
            (text) => events.push({ type: "text_delta", delta: text }),
            { onUsage: (value) => (usage = value) },
          );
          requestSignal.throwIfAborted();
          if (payload.tool_choice === "none" && raw.tool_calls?.length)
            throw new HarnessError(
              "REQUEST_LIMIT",
              "The final response requested more tools.",
            );
          const message = {
            role: "assistant",
            content: [
              { type: "text", text: raw.content },
              ...(raw.tool_calls ?? []).map((call) => ({
                type: "toolCall",
                id: call.id,
                name: call.function.name,
                arguments: JSON.parse(call.function.arguments),
              })),
            ],
            api: "openai-completions",
            provider: fixture ? "fixture" : "openrouter",
            model: modelId,
            stopReason: raw.tool_calls?.length ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage,
            providerReplay: raw,
          };
          // Here the terminal marker confirms stream completion. Usage comes
          // from the provider; this local adapter has no class billing ledger.
          notify({
            type: "request_end",
            operationId,
            role,
            status: "completed",
            usage,
          });
          events.finish(message);
        } catch (error) {
          const message = cleanError(error);
          notify({
            type: "request_end",
            operationId,
            role,
            status: "failed",
            message,
          });
          throw new HarnessError(
            typeof error.code === "string" ? error.code : "PROVIDER_FAILED",
            message,
          );
        }
      })().catch((error) => events.fail(error));
      return events;
    };
  }
  return {
    fixture,
    runtimeMode: fixture ? "fixture" : "local",
    configured: true,
    recoverySupported: false,
    cleanError,
    async bootstrap(signal) {
      assertLive(signal);
      return structuredClone(boot);
    },
    discover: (signal) => {
      assertLive(signal);
      return source.discover(signal);
    },
    listStories: (args, signal) => {
      assertLive(signal);
      return source.listStories(args, signal);
    },
    loadUserPreferences: (signal) => store.load(signal),
    saveUserPreferences: (value, etag, signal) => {
      assertLive(signal);
      return store.save(value, etag, signal);
    },
    stream,
    async operation() {
      throw new HarnessError(
        "RECOVERY_UNAVAILABLE",
        "Local mode has no workshop billing journal. Check OpenRouter activity before repeating an uncertain request.",
      );
    },
    async close() {
      await source.close();
      store.close();
    },
    get current() {
      return boot;
    },
  };
}
