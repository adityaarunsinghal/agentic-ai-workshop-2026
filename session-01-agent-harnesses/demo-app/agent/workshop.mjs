/**
 * The application's connection to its environment.
 *
 * HN supplies story metadata through MCP. The workshop broker supplies
 * inference and visitor storage. Credentials remain in this server module.
 * Pi-mini sees a stream function and executable tools, never HTTP headers.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAssistantMessageEventStream, HarnessError } from "./pi-mini.mjs";
import { readCompletion } from "../support/stream.mjs";
import { RESOURCE_LIMITS_FOR_HARNESS_TESTING } from "../support/limits.mjs";
import manifest from "../workshop-app.json" with { type: "json" };
import {
  ATTEMPT_LIMIT_HEADER,
  RECOVERY_HEADER,
  RECOVERY_VERSION,
  recoveryStatus,
  safeErrorMetadata,
  outcomeErrorMetadata,
  terminalRecovery,
} from "../support/recovery.mjs";

/** Text-only message conversion is deliberate: this app accepts no images. */
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((part) => part.type !== "text"))
    throw new HarnessError(
      "INVALID_CONTEXT",
      "Expected complete text content.",
    );
  return content.map((part) => part.text).join("\n");
}

/**
 * Convert Pi-shaped history into the broker's Chat Completions vocabulary.
 * Original comparison: Pi's openai-completions.ts, convertMessages.
 */
export function providerContext(messages) {
  const declarations = new Map();
  const instructions = [];
  const conversation = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) instructions.push(textContent(message.content));
      for (const tool of message.toolsAdded ?? [])
        declarations.set(tool.name, {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        });
      continue;
    }
    if (message.role === "user")
      conversation.push({
        role: "user",
        content: textContent(message.content),
      });
    else if (message.role === "toolResult")
      conversation.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: textContent(message.content),
      });
    else if (message.role === "assistant") {
      // Preserve every validated provider replay field, including opaque data.
      // Reconstructing only visible text would lose reasoning continuations.
      if (message.providerReplay) {
        conversation.push(structuredClone(message.providerReplay));
        continue;
      }
      const calls = message.content.filter((part) => part.type === "toolCall");
      conversation.push({
        role: "assistant",
        content: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      });
    } else
      throw new HarnessError("INVALID_CONTEXT", "Unsupported message role.");
  }
  return {
    messages: [
      { role: "system", content: instructions.join("\n\n") },
      ...conversation,
    ],
    tools: [...declarations.values()],
  };
}

/** The inspector is an explicitly labeled projection, with replay hidden. */
export function inspectableRequest(payload) {
  return {
    ...payload,
    messages: payload.messages.map((message) => {
      const projected = { ...message };
      for (const key of [
        "reasoning",
        "reasoning_content",
        "reasoning_text",
        "reasoning_details",
      ]) {
        if (Object.hasOwn(projected, key)) {
          const value = projected[key];
          projected[key] = {
            hidden: true,
            reason: "Provider replay retained on the server.",
            ...(typeof value === "string"
              ? { characters: value.length }
              : { records: value.length }),
          };
        }
      }
      return projected;
    }),
  };
}

/** Build clients lazily so readiness requires no remote connection. */
export function createWorkshop({
  env = process.env,
  fetcher = fetch,
  fixture = false,
} = {}) {
  if (fixture && env.WORKSHOP_RUNTIME === "hosted")
    throw new Error("Fixture mode cannot run inside a hosted workshop visit.");
  let workshopBootstrap, hnMcpClient, hnMcpTransport, hnToolDiscoveryPromise;
  let supportsInferenceProfileBinding = false;
  let supportsInferenceRecovery = false;
  const inferenceOperationsById = new Map();
  // Producer and reviewer share this budget and therefore one selection.
  const inferenceSelectionsByBudget = new WeakMap();
  const workshopRunToken = env.WORKSHOP_RUN_TOKEN;
  const isWorkshopBrokerConfigured = Boolean(
    env.WORKSHOP_BROKER_URL && workshopRunToken,
  );
  let workshopBrokerBaseUrl;
  if (isWorkshopBrokerConfigured) {
    workshopBrokerBaseUrl = new URL(env.WORKSHOP_BROKER_URL);
    if (
      !["http:", "https:"].includes(workshopBrokerBaseUrl.protocol) ||
      workshopBrokerBaseUrl.username ||
      workshopBrokerBaseUrl.password ||
      workshopBrokerBaseUrl.search ||
      workshopBrokerBaseUrl.hash
    )
      throw new Error("Invalid workshop broker URL.");
  }

  function cleanError(error) {
    const text = String(error?.message || error || "Request failed.");
    return workshopRunToken
      ? text.replaceAll(workshopRunToken, "[redacted]")
      : text;
  }

  function modelChanged() {
    return new HarnessError(
      "MODEL_CHANGED",
      "The selected model, pricing profile or funding changed. Start a new conversation with the current portal selection.",
    );
  }

  /** Copy primitive values so later bootstrap reads cannot rebind a briefing. */
  function selectedInference() {
    const { selection, fundingMode } = workshopBootstrap?.inference ?? {};
    if (
      !selection ||
      typeof selection.modelId !== "string" ||
      typeof selection.profileId !== "string" ||
      !selection.profileId ||
      (fundingMode !== undefined &&
        !["class", "personal"].includes(fundingMode))
    )
      throw new HarnessError(
        "CONTRACT",
        "The workshop must supply a model and pricing profile before inference.",
      );
    return Object.freeze({
      modelId: selection.modelId,
      profileId: selection.profileId,
      fundingMode,
    });
  }

  function signalFor(signal, timeout) {
    const remaining = workshopBootstrap
      ? Date.parse(workshopBootstrap.expiresAt) - Date.now()
      : timeout;
    if (remaining <= 0)
      throw new HarnessError(
        "SESSION_EXPIRED",
        "This workshop visit has expired.",
      );
    return AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(Math.max(1, Math.min(timeout, remaining))),
    ]);
  }

  async function request(
    path,
    {
      method = "GET",
      body,
      headers = {},
      signal,
      timeout = RESOURCE_LIMITS_FOR_HARNESS_TESTING.modelMs,
    } = {},
  ) {
    if (!isWorkshopBrokerConfigured)
      throw new HarnessError(
        "SETUP",
        "Start this app through the workshop portal.",
      );
    const response = await fetcher(new URL(path, workshopBrokerBaseUrl), {
      method,
      headers: {
        authorization: `Bearer ${workshopRunToken}`,
        "x-workshop-contract-version": manifest.schemaVersion,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: signalFor(signal, timeout),
    });
    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {
        /* Use the status below. */
      }
      // Only the broker's explicit selection signal authorizes this mapping.
      const changed =
        path === "/v1/llm/chat/completions" &&
        response.status === 409 &&
        data?.error?.code === "MODEL_NOT_ALLOWED" &&
        data.error.details?.selectionChanged === true;
      const error = changed
        ? modelChanged()
        : new HarnessError(
            data?.error?.code || `HTTP_${response.status}`,
            cleanError(
              data?.error?.message ||
                `Workshop returned HTTP ${response.status}.`,
            ),
            safeErrorMetadata(
              { ...data?.error, status: response.status },
              cleanError,
            ),
          );
      Object.assign(
        error,
        safeErrorMetadata(
          { ...data?.error, status: response.status },
          cleanError,
        ),
      );
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async function bootstrap(signal) {
    const response = await request("/v1/bootstrap", { signal });
    const next = await response.json();
    if (
      next.contractVersion !== manifest.schemaVersion ||
      next.runId !== env.WORKSHOP_RUN_ID ||
      !Number.isFinite(Date.parse(next.expiresAt))
    )
      throw new HarnessError(
        "CONTRACT",
        "The workshop bootstrap does not match this visit.",
      );
    if (next.simulated && !fixture)
      throw new HarnessError(
        "SIMULATION",
        "A hosted demo requires real workshop services.",
      );
    if (!["hosted", "readiness"].includes(next.mode))
      throw new HarnessError("CONTRACT", "Unsupported workshop mode.");
    if (
      next.mode === "hosted" &&
      !manifest.inference.models.includes(next.inference?.selection?.modelId)
    )
      throw new HarnessError(
        "MODEL",
        "Select an approved model through the portal.",
      );
    workshopBootstrap = next;
    // HTTP negotiation leaves the strict C01 JSON body unchanged.
    supportsInferenceProfileBinding =
      response.headers.get("x-workshop-inference-binding") === "profile-v1";
    supportsInferenceRecovery =
      response.headers.get(RECOVERY_HEADER) === RECOVERY_VERSION;
    return workshopBootstrap;
  }

  function assertLive() {
    if (
      workshopBootstrap?.mode !== "hosted" ||
      Date.parse(workshopBootstrap.expiresAt) <= Date.now()
    )
      throw new HarnessError(
        "SESSION_EXPIRED",
        "A live workshop visit is required.",
      );
  }

  async function discover(signal) {
    assertLive();
    if (hnToolDiscoveryPromise) return hnToolDiscoveryPromise;
    if (!workshopBootstrap.services.hn)
      throw new HarnessError(
        "HN_UNAVAILABLE",
        "HN is unavailable for this app.",
      );
    const endpoint = new URL(
      workshopBootstrap.services.hn.url,
      workshopBrokerBaseUrl,
    );
    if (
      endpoint.origin !== workshopBrokerBaseUrl.origin ||
      endpoint.username ||
      endpoint.password
    )
      throw new HarnessError(
        "HN_ORIGIN",
        "HN must use the workshop broker origin.",
      );
    hnMcpClient = new Client({ name: "agent-harness-demo", version: "1.0.0" });
    hnMcpTransport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: {
          authorization: `Bearer ${workshopRunToken}`,
          "x-workshop-contract-version": manifest.schemaVersion,
        },
      },
      fetch: (url, init) => fetcher(url, { ...init, redirect: "error" }),
      reconnectionOptions: { maxRetries: 0 },
    });
    try {
      await hnMcpClient.connect(hnMcpTransport, { timeout: 15000, signal });
      const catalog = await hnMcpClient.listTools(
        {},
        { signal, timeout: 15000 },
      );
      if (catalog.nextCursor)
        throw new HarnessError(
          "HN_CATALOG",
          "HN tool discovery was incomplete.",
        );
      const tool = catalog.tools.find((item) => item.name === "list_stories");
      if (!tool)
        throw new HarnessError(
          "HN_CATALOG",
          "HN did not advertise list_stories.",
        );
      hnToolDiscoveryPromise = structuredClone(tool);
      return hnToolDiscoveryPromise;
    } catch (error) {
      await hnMcpClient.close().catch(() => {});
      hnMcpClient = hnMcpTransport = null;
      throw new HarnessError(error.code ?? "HN_CONNECTION", cleanError(error));
    }
  }

  async function listStories(args, signal) {
    await discover(signal);
    // Bob owns his service. Only this advertised HN capability is callable.
    try {
      return await hnMcpClient.callTool(
        { name: "list_stories", arguments: args },
        undefined,
        {
          signal: signalFor(
            signal,
            RESOURCE_LIMITS_FOR_HARNESS_TESTING.sourceMs,
          ),
          timeout: RESOURCE_LIMITS_FOR_HARNESS_TESTING.sourceMs,
        },
      );
    } catch (error) {
      throw new HarnessError(error.code ?? "HN_REQUEST", cleanError(error));
    }
  }

  /**
   * This route only reads an operation already admitted by this app. A browser
   * reconnect or status reader cannot create, restart or cancel inference.
   */
  async function operation(operationId, signal) {
    const entry = inferenceOperationsById.get(operationId);
    if (!supportsInferenceRecovery || !entry)
      throw new HarnessError(
        "RECOVERY_UNAVAILABLE",
        "No status is available for this request.",
      );
    if (entry.reading) return entry.reading;
    entry.reading = (async () => {
      const response = await request(
        `/v1/llm/operations/${encodeURIComponent(operationId)}`,
        {
          signal,
          timeout: RESOURCE_LIMITS_FOR_HARNESS_TESTING.recoveryReadMs,
        },
      );
      const data = await response.json();
      return acceptOperation(entry, data.operation);
    })();
    try {
      return await entry.reading;
    } finally {
      entry.reading = null;
    }
  }

  function acceptOperation(entry, value) {
    const status = recoveryStatus(value, entry.id, cleanError);
    if (
      !status ||
      status.modelId !== entry.payload.model ||
      status.profileId !== entry.profileId ||
      (terminalRecovery(entry.status) && !terminalRecovery(status))
    )
      throw new HarnessError(
        "RECOVERY_STATUS",
        "The broker returned an incompatible request status.",
      );
    entry.budget.reconcile(status);
    if (!isDeepStrictEqual(entry.status, status)) {
      entry.status = status;
      entry.notify({
        type: "recovery",
        operationId: entry.id,
        role: entry.role,
        recovery: status,
      });
    }
    return structuredClone(status);
  }

  /** One sequential poller per active request, bounded by its original deadline. */
  function pollOperation(entry, signal) {
    const controller = new AbortController();
    const pollSignal = AbortSignal.any([controller.signal, signal]);
    const finished = (async () => {
      while (!pollSignal.aborted && Date.now() < entry.deadline) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            pollSignal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(
            done,
            RESOURCE_LIMITS_FOR_HARNESS_TESTING.recoveryPollMs,
          );
          pollSignal.addEventListener("abort", done, { once: true });
          if (pollSignal.aborted) done();
        });
        if (pollSignal.aborted) break;
        const status = await operation(entry.id, pollSignal).catch(() => null);
        if (terminalRecovery(status)) break;
      }
    })();
    return async () => {
      controller.abort();
      await finished;
    };
  }

  function stream({
    budget,
    role,
    notify = () => {},
    forceNoTools = false,
    resumeOperationId = null,
  }) {
    const selected =
      inferenceSelectionsByBudget.get(budget) ?? selectedInference();
    inferenceSelectionsByBudget.set(budget, selected);
    return (model, context, { signal }) => {
      const events = createAssistantMessageEventStream();
      void (async () => {
        assertLive();
        if (
          model.id !== selected.modelId ||
          (model.profileId !== undefined &&
            model.profileId !== selected.profileId)
        )
          throw modelChanged();
        const converted = providerContext(context.messages);
        const payload = {
          model: selected.modelId,
          messages: converted.messages,
          tools: converted.tools,
          tool_choice:
            forceNoTools || !converted.tools.length || budget.isLast(role)
              ? "none"
              : "auto",
          max_tokens: RESOURCE_LIMITS_FOR_HARNESS_TESTING.outputTokens,
          stream: true,
        };
        const bytes = Buffer.byteLength(JSON.stringify(payload));
        if (bytes > RESOURCE_LIMITS_FOR_HARNESS_TESTING.contextBytes)
          throw new HarnessError(
            "CONTEXT_LIMIT",
            "The complete request exceeds the context limit. Start a new conversation; nothing was shortened.",
          );
        // Older brokers cannot bind profiles atomically. Refresh before every
        // dispatch and reject changes without consuming a model-request slot.
        if (!supportsInferenceProfileBinding) {
          await bootstrap(signal);
          assertLive();
          if (!isDeepStrictEqual(selectedInference(), selected))
            throw modelChanged();
        }
        signal?.throwIfAborted();
        // Reserve every possible broker attempt before handing it control.
        // A final tool-free producer slot and the reviewer slot stay available.
        const priorOperationId = resumeOperationId;
        resumeOperationId = null;
        const prior = priorOperationId
          ? inferenceOperationsById.get(priorOperationId)
          : null;
        if (priorOperationId && !prior)
          throw new HarnessError(
            "RECOVERY_UNAVAILABLE",
            "The original request is unavailable.",
          );
        if (prior?.status && !terminalRecovery(prior.status))
          throw new HarnessError(
            "RECOVERY_PENDING",
            "Check the original request's status before trying again.",
          );
        const replay = prior?.status?.phase === "completed";
        if (replay && !prior.status.responseAvailable)
          throw new HarnessError(
            "RECOVERY_RESULT_UNAVAILABLE",
            "Completion was recorded but its cached response is unavailable.",
          );
        // Replay uses the exact original body and limit under its old identity.
        if (
          replay &&
          !isDeepStrictEqual(payload.messages, prior.payload.messages)
        )
          throw new HarnessError(
            "STALE_CHECKPOINT",
            "The saved request no longer matches its completed operation.",
          );
        const operationId = replay ? prior.id : randomUUID();
        const attemptLimit = replay
          ? prior.attemptLimit
          : budget.reserve(
              role,
              operationId,
              supportsInferenceRecovery
                ? RESOURCE_LIMITS_FOR_HARNESS_TESTING.brokerAttempts
                : 1,
              role === "producer" && payload.tool_choice !== "none",
            );
        const entry = replay
          ? prior
          : {
              id: operationId,
              payload: structuredClone(payload),
              profileId: selected.profileId,
              profileBinding: supportsInferenceProfileBinding,
              recoverySupported: supportsInferenceRecovery,
              attemptLimit,
              budget,
              notify,
              role,
              status: null,
              deadline: Math.min(
                Date.now() + RESOURCE_LIMITS_FOR_HARNESS_TESTING.modelMs,
                Date.parse(workshopBootstrap.expiresAt),
              ),
            };
        inferenceOperationsById.set(operationId, entry);
        notify({
          type: "request_start",
          operationId,
          role,
          bytes,
          attemptLimit,
          recoverySupported: entry.recoverySupported,
          ...(priorOperationId ? { priorOperationId, replay } : {}),
          payload: inspectableRequest(entry.payload),
        });
        const stopPolling = entry.recoverySupported
          ? pollOperation(entry, signal ?? new AbortController().signal)
          : async () => {};
        let usage = null;
        try {
          const response = await request("/v1/llm/chat/completions", {
            method: "POST",
            body: entry.payload,
            headers: {
              "x-workshop-operation-id": operationId,
              ...(entry.profileBinding
                ? { "x-workshop-expected-profile": selected.profileId }
                : {}),
              ...(entry.recoverySupported
                ? { [ATTEMPT_LIMIT_HEADER]: String(attemptLimit) }
                : {}),
            },
            signal,
          });
          const raw = await readCompletion(
            response,
            (delta) => {
              events.push({ type: "text_delta", delta });
            },
            {
              onUsage: (value) => {
                usage = value;
              },
            },
          );
          // A provider ignoring tool_choice:none cannot execute another effect.
          if (entry.payload.tool_choice === "none" && raw.tool_calls?.length)
            throw new HarnessError(
              "REQUEST_LIMIT",
              "The model requested tools after the final allowed request.",
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
            provider: "workshop",
            model: selected.modelId,
            stopReason: raw.tool_calls?.length ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage,
            providerReplay: raw,
          };
          await stopPolling();
          if (entry.recoverySupported)
            await operation(operationId).catch(() => {});
          notify({
            type: "request_end",
            operationId,
            role,
            usage,
            status: "settled",
            ...(entry.status ? { recovery: entry.status } : {}),
          });
          events.finish(message);
        } catch (error) {
          await stopPolling();
          if (entry.recoverySupported) {
            if (error.recovery)
              try {
                acceptOperation(entry, error.recovery);
              } catch {
                /* Retain the full allowance. */
              }
            if (!terminalRecovery(entry.status))
              await operation(operationId).catch(() => {});
          }
          const metadata = {
            ...safeErrorMetadata(error, cleanError),
            operationId,
          };
          delete metadata.recovery;
          if (entry.status) metadata.recovery = entry.status;
          notify({
            type: "request_end",
            operationId,
            role,
            status: "failed",
            message: cleanError(error),
            ...outcomeErrorMetadata(metadata),
          });
          throw new HarnessError(
            error.code ?? "PROVIDER_FAILED",
            cleanError(error),
            metadata,
          );
        } finally {
          await stopPolling();
        }
      })().catch((error) =>
        events.fail(
          new HarnessError(
            error.code ?? "PROVIDER_FAILED",
            cleanError(error),
            safeErrorMetadata(error, cleanError),
          ),
        ),
      );
      return events;
    };
  }

  async function loadUserPreferences(signal) {
    assertLive();
    if (
      workshopBootstrap.storage?.schema !== manifest.storage.schema ||
      workshopBootstrap.storage.visitorBytes < 1
    )
      throw new HarnessError(
        "STORAGE",
        "Visitor user-preferences storage is unavailable.",
      );
    try {
      const data = await (
        await request("/v1/storage/objects/hn-memory", {
          signal,
          timeout: 15000,
        })
      ).json();
      return checkedUserPreferencesResponse(data);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async function saveUserPreferences(value, etag, signal) {
    assertLive();
    if (
      Buffer.byteLength(JSON.stringify(value)) >
      RESOURCE_LIMITS_FOR_HARNESS_TESTING.userPreferencesBytes
    )
      throw new HarnessError(
        "STORAGE_LIMIT",
        "The complete user-preferences object is too large.",
      );
    try {
      const data = await (
        await request("/v1/storage/objects/hn-memory", {
          method: "PUT",
          body: { schema: manifest.storage.schema, value },
          headers:
            etag === null ? { "if-none-match": "*" } : { "if-match": etag },
          signal,
          timeout: 15000,
        })
      ).json();
      const saved = checkedUserPreferencesResponse(data);
      if (!isDeepStrictEqual(saved.value, value))
        throw new HarnessError(
          "STORAGE_RESPONSE",
          "Storage did not acknowledge the complete proposed user-preferences.",
        );
      return saved;
    } catch (error) {
      if (error.status === 412 || signal?.aborted) throw error;
      // Check Bob's existing order before offering another write.
      const observed = await loadUserPreferences(signal).catch(() => null);
      if (observed && isDeepStrictEqual(observed.value, value)) return observed;
      throw error;
    }
  }

  function checkedUserPreferencesResponse(data) {
    const object = data?.object;
    if (
      !object ||
      typeof object !== "object" ||
      !Object.hasOwn(object, "value") ||
      typeof object.etag !== "string" ||
      !object.etag ||
      object.schema !== manifest.storage.schema ||
      object.key !== "hn-memory"
    )
      throw new HarnessError(
        "STORAGE_RESPONSE",
        "Storage returned an invalid user-preferences response. Existing state was retained.",
      );
    return object;
  }

  async function close() {
    if (hnMcpTransport?.sessionId)
      await hnMcpTransport.terminateSession().catch(() => {});
    await hnMcpClient?.close().catch(() => {});
    hnMcpClient = hnMcpTransport = hnToolDiscoveryPromise = null;
  }

  return {
    fixture,
    configured: isWorkshopBrokerConfigured,
    bootstrap,
    discover,
    listStories,
    stream,
    operation,
    loadUserPreferences,
    saveUserPreferences,
    close,
    cleanError,
    get recoverySupported() {
      return supportsInferenceRecovery;
    },
    get current() {
      return workshopBootstrap;
    },
  };
}
