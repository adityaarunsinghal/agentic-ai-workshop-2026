import { tmpdir } from "node:os";
import { join } from "node:path";

export function configuration(env = process.env) {
  const mode = env.SESSION2_MODE ||
    (env.WORKSHOP_RUNTIME === "hosted" ? "hosted" :
      env.WORKSHOP_DEVELOPMENT_TOKEN ? "development" :
        env.OPENROUTER_API_KEY ? "local" : "fixture");
  if (!["fixture", "local", "development", "hosted"].includes(mode))
    throw new Error("Choose fixture, local, development, or hosted mode.");
  if (mode === "fixture" && env.WORKSHOP_RUNTIME === "hosted")
    throw new Error("A hosted workshop visit cannot use fixtures.");
  if (mode === "local" && !env.OPENROUTER_API_KEY)
    throw new Error("Local inference requires a private OPENROUTER_API_KEY.");
  return {
    mode, fixture: mode === "fixture",
    uiHotReload: ["local", "development"].includes(mode) && env.LOCAL_UI_HOT_RELOAD === "1",
    model: ["development", "hosted"].includes(mode) ? null :
      env.OPENROUTER_MODEL || "openai/gpt-6-luna",
    decisionModel: env.OPENROUTER_DECISION_MODEL || "typesafe/jev-1.13",
    apiKey: mode === "local" ? env.OPENROUTER_API_KEY : undefined,
    brokerUrl: mode === "development" ? env.WORKSHOP_DEVELOPMENT_URL : env.WORKSHOP_BROKER_URL,
    token: mode === "development" ? env.WORKSHOP_DEVELOPMENT_TOKEN : env.WORKSHOP_RUN_TOKEN,
    profileId: env.WORKSHOP_PROFILE_ID,
    persistenceSchema: "newspaper.edition.v1",
    persistenceTimeoutMs: Number(env.SESSION2_STORAGE_TIMEOUT_MS || 15000),
    persistenceDebounceMs: 500,
    modelTimeoutMs: Number(env.SESSION2_MODEL_TIMEOUT_MS || 360000),
    maxTokens: Number(env.SESSION2_MAX_OUTPUT_TOKENS || 32768),
    maxTurns: 10, maxDecisionRequests: 300,
    maxInferenceCostUsd: Number(env.SESSION2_MAX_COST_USD || 1),
    maxRequestCostUsd: Number(env.SESSION2_MAX_REQUEST_COST_USD || 0.05),
    port: Number(env.PORT || 8088),
    host: env.HOST || (mode === "hosted" ? "0.0.0.0" : "127.0.0.1"),
    stateFile: env.SESSION2_STATE_FILE || (mode === "hosted"
      ? join(tmpdir(), "session-02-editor-view", "issue.json")
      : ".local/editor-state.json"),
    exportsDirectory: mode === "hosted"
      ? join(tmpdir(), "session-02-editor-view", "exports")
      : env.SESSION2_EXPORTS_DIRECTORY || ".local/exports",
    readiness: env.WORKSHOP_READINESS === "1",
  };
}
