/**
 * A small teaching harness, adapted from Pi 1.0.0's Agent and agent loop.
 * Original: reference/pi-1.0.0/packages/agent/src/{agent,agent-loop}.ts.
 * Copyright (c) 2025 Mario Zechner. Original MIT notice is in reference/.
 *
 * Read Agent first, then runLoop. The application supplies tools, policy and
 * a model stream. This module contains no HN, HTTP, credentials or UI logic.
 *
 * A request obtains one model response. A turn includes that response and
 * its tools. A run is one prompt() execution. A session holds several runs.
 *
 * This subset executes tools sequentially and validates a whole batch first.
 * Failed requests retain complete exchanges and a server-owned checkpoint.
 * Explicit continuation preserves prior effects. See README for differences.
 */
import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { isDeepStrictEqual } from "node:util";
import {
  safeErrorMetadata,
  outcomeErrorMetadata,
} from "../support/recovery.mjs";

// Schema validation checks data shape. Permission is a separate hook below.
// HN's MCP declaration uses Draft 7. Ajv's default validator implements that
// dialect; the 2020 validator rejects its explicit metaschema before dispatch.
const toolArgumentSchemaValidator = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const compiledToolArgumentValidators = new WeakMap();

/** A typed failure gives the application an honest stopping reason. */
export class HarnessError extends Error {
  constructor(code, message, metadata) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    Object.assign(this, safeErrorMetadata(metadata));
  }
}

/** Build a user message without changing the person's input. */
export function userMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

/**
 * Harry: retain the conversation and coordinate the current execution.
 * Pi counterpart: packages/agent/src/agent.ts, Agent.
 */
export class Agent {
  constructor(options) {
    if (typeof options?.streamFn !== "function")
      throw new TypeError("Agent requires an explicit streamFn.");
    const initialAgentState = options.initialState ?? {};
    if (!initialAgentState.model?.id)
      throw new TypeError("Select a model explicitly.");
    if (options.toolExecution && options.toolExecution !== "sequential")
      throw new TypeError("Pi-mini supports sequential tool execution.");

    // Functions stay in this process. Only declarations go to the model.
    const tools = [...(initialAgentState.tools ?? [])];
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new TypeError("Tool names must be unique.");
    for (const tool of tools) validateToolDefinition(tool);
    const initialSystemMessage = {
      role: "system",
      content: initialAgentState.systemPrompt ?? "",
      toolsAdded: tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
      timestamp: Date.now(),
    };
    this.state = {
      model: { ...initialAgentState.model },
      tools,
      messages: initialAgentState.messages?.length
        ? structuredClone(initialAgentState.messages)
        : [initialSystemMessage],
      isStreaming: false,
      streamingMessage: null,
      pendingToolCalls: new Set(),
      errorMessage: null,
      outcome: null,
    };
    this.options = options;
    this.listeners = new Set();
    this.steering = [];
    this.followUps = [];
    this.active = null;
    this.checkpoint = null;
    this.revision = 0;
    this.unresolvedTool = null;
  }

  /** Observe events in order; a UI subscriber should enqueue its output. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start one run. Another prompt requires idle state; steer/followUp have
   * explicit queue semantics while the current run is active.
   */
  async prompt(input) {
    this.assertPromptReady();
    const messages = typeof input === "string" ? [userMessage(input)] : input;
    if (!Array.isArray(messages) || !messages.length)
      throw new TypeError("A prompt needs text or a nonempty message array.");
    // An edited request replaces unanswered input. Earlier complete tool
    // exchanges remain in history and explicit continue retains the exact input.
    if (this.checkpoint?.stage === "request")
      while (this.state.messages.at(-1)?.role === "user")
        this.state.messages.pop();
    this.checkpoint = null;
    this.revision++;
    return this.executeRun(messages);
  }

  /** Admission must happen before the application changes a run's owner. */
  assertPromptReady() {
    if (this.active)
      throw new HarnessError("BUSY", "An agent run is already active.");
    if (this.unresolvedTool || this.checkpoint?.stage === "tools")
      throw new HarnessError(
        "TOOL_UNRESOLVED",
        "Resolve the pending tool exchange before another prompt.",
      );
  }

  /**
   * Resume only this Agent's exact checkpoint. No caller can supply replacement
   * history. A new prompt, modified transcript or consumed checkpoint rejects.
   * Automatic provider attempts stay inside streamFn's single model request.
   */
  async continue(checkpointId) {
    if (this.active)
      throw new HarnessError("BUSY", "An agent run is already active.");
    const checkpoint = this.checkpoint;
    if (
      !checkpoint ||
      checkpoint.id !== checkpointId ||
      checkpoint.revision !== this.revision ||
      !isDeepStrictEqual(
        checkpoint.context,
        this.options.continuationContext ?? null,
      ) ||
      !isDeepStrictEqual(this.state.messages, checkpoint.messages)
    )
      throw new HarnessError(
        "STALE_CHECKPOINT",
        "This continuation is no longer current.",
      );
    if (this.unresolvedTool)
      throw new HarnessError(
        "TOOL_UNRESOLVED",
        "Establish the pending tool's outcome before continuing.",
      );
    this.checkpoint = null;
    return this.executeRun([], checkpoint);
  }

  /** Save complete local progress, including a pending validated tool batch. */
  saveCheckpoint(stage, progress = {}) {
    this.checkpoint = {
      id: randomUUID(),
      revision: this.revision,
      stage,
      messages: structuredClone(this.state.messages),
      originalRunId: this.active.id,
      context: structuredClone(this.options.continuationContext ?? null),
      ...structuredClone(progress),
    };
  }

  /**
   * Application readback can establish an uncertain effect. Only the exact
   * pending call may be acknowledged; no tool execution happens in this method.
   */
  resolveTool(callId, result, checkpointId = this.checkpoint?.id) {
    if (
      this.active ||
      this.unresolvedTool?.callId !== callId ||
      this.checkpoint?.stage !== "tools" ||
      this.checkpoint.id !== checkpointId ||
      !isDeepStrictEqual(
        this.checkpoint.context,
        this.options.continuationContext ?? null,
      ) ||
      !Array.isArray(result.content)
    )
      throw new HarnessError(
        "TOOL_UNRESOLVED",
        "No matching pending tool can be acknowledged.",
      );
    const checkpoint = this.checkpoint;
    const message = {
      role: "toolResult",
      toolCallId: callId,
      toolName: this.unresolvedTool.name,
      content: structuredClone(result.content),
      isError: Boolean(result.isError),
      timestamp: Date.now(),
    };
    this.state.messages.push(message);
    checkpoint.messages = structuredClone(this.state.messages);
    checkpoint.toolResults.push(message);
    checkpoint.nextTool++;
    this.unresolvedTool = null;
  }

  async executeRun(messages, continuation = null) {
    // Reserve activity before the first await so simultaneous calls cannot run.
    const controller = new AbortController();
    let resolveIdle;
    const idle = new Promise((resolve) => {
      resolveIdle = resolve;
    });
    this.active = { id: randomUUID(), controller, idle };
    // Cancellation may arrive in agent_start before the first loop boundary.
    // Keep the resumed progress under a fresh identity even in that window.
    if (continuation)
      this.checkpoint = {
        ...structuredClone(continuation),
        id: randomUUID(),
        originalRunId: this.active.id,
      };
    this.state.isStreaming = true;
    this.state.errorMessage = null;
    this.state.outcome = null;
    const start = this.state.messages.length;

    try {
      await this.emit({
        type: "agent_start",
        ...(continuation
          ? {
              resumedFrom: continuation.originalRunId,
              checkpointId: continuation.id,
            }
          : {}),
      });
      await runLoop(this, messages, continuation);
      this.state.outcome = { status: "completed" };
      this.checkpoint = null;
    } catch (error) {
      // A failed partial response is visible in events but excluded from replay.
      // Completed tool results remain, even if a later tool needs a new approval.
      if (this.checkpoint)
        this.state.messages = structuredClone(this.checkpoint.messages);
      const aborted = controller.signal.aborted;
      const code = aborted ? "CANCELLED" : (error.code ?? "RUN_FAILED");
      this.state.errorMessage = aborted
        ? "Stopped by the user."
        : String(error.message || error);
      this.state.outcome = {
        status: aborted ? "cancelled" : "failed",
        code,
        message: this.state.errorMessage,
        ...outcomeErrorMetadata(error),
      };
    } finally {
      // agent_end reports a settled outcome, including failures.
      try {
        await this.emit({
          type: "agent_end",
          outcome: this.state.outcome,
          messages: this.state.messages.slice(start),
        });
      } finally {
        this.state.isStreaming = false;
        this.state.streamingMessage = null;
        this.state.pendingToolCalls.clear();
        this.active = null;
        resolveIdle();
      }
    }
  }

  /** The current run includes model work, tools and awaited event handlers. */
  waitForIdle() {
    return this.active?.idle ?? Promise.resolve();
  }

  /** Request cancellation; an already completed effect remains completed. */
  abort() {
    this.active?.controller.abort();
  }

  /** Change direction after the current assistant response and tools finish. */
  steer(message) {
    return this.queue(this.steering, message, "steering");
  }

  /** Deliver another input after ordinary tool work would naturally stop. */
  followUp(message) {
    return this.queue(this.followUps, message, "follow-up");
  }

  queue(queue, input, kind) {
    if (!this.active) throw new HarnessError("IDLE", "Start a run first.");
    if (queue.length)
      throw new HarnessError(
        "QUEUE_FULL",
        `One ${kind} input is already queued.`,
      );
    const text =
      typeof input?.content === "string"
        ? input.content
        : Array.isArray(input?.content) &&
            input.content.every(
              (part) => part.type === "text" && typeof part.text === "string",
            )
          ? input.content.map((part) => part.text).join("\n")
          : "";
    if (input?.role !== "user" || !text.trim())
      throw new TypeError("Queue a nonempty user message, as in Pi.");
    const message = { ...structuredClone(input), inputId: randomUUID() };
    queue.push(message);
    // This return ID is a Pi-mini addition for the application's queue view.
    return message.inputId;
  }

  /** Return unexecuted input so the application can keep it visible. */
  clearAllQueues() {
    return [...this.steering.splice(0), ...this.followUps.splice(0)];
  }

  get signal() {
    return this.active?.controller.signal;
  }

  /** Update runtime state, then let every subscriber observe the same event. */
  async emit(event) {
    const record = {
      ...event,
      agentRunId: this.active?.id,
      timestamp: Date.now(),
    };
    if (event.type === "message_end") this.state.messages.push(event.message);
    if (event.type === "tool_execution_start")
      this.state.pendingToolCalls.add(event.toolCallId);
    if (event.type === "tool_execution_end")
      this.state.pendingToolCalls.delete(event.toolCallId);
    for (const listener of this.listeners) await listener(record, this.signal);
  }
}

/**
 * The scheduler: observations and queued input determine another request.
 * Pi counterpart: packages/agent/src/agent-loop.ts, runLoop.
 */
export async function runLoop(agent, prompts, continuation = null) {
  let pendingUserMessages = [...prompts];
  let explicitContinuation = false;
  let turnNumber = 0;

  // The outer loop accepts follow-up input after ordinary work would stop.
  while (true) {
    let assistantRequestedToolCalls = true;

    // The inner loop follows tool results and steering into another request.
    while (assistantRequestedToolCalls || pendingUserMessages.length) {
      agent.signal.throwIfAborted();
      await agent.emit({ type: "turn_start", turn: ++turnNumber });
      for (const message of pendingUserMessages) {
        await agent.emit({ type: "message_start", message });
        await agent.emit({ type: "message_end", message });
      }
      pendingUserMessages = [];

      // A complete request checkpoint contains all earlier observations.
      // Tool continuation resumes the saved batch before another model request.
      if (continuation?.stage !== "tools") agent.saveCheckpoint("request");
      const message =
        continuation?.stage === "tools"
          ? continuation.message
          : await streamAssistantResponse(agent);
      const requestedToolCalls = message.content.filter(
        (part) => part.type === "toolCall",
      );

      // Inspect the entire batch before executing its first effect.
      const validatedToolCalls = requestedToolCalls.map((call) =>
        prepareToolCall(agent, call),
      );
      const toolResults =
        continuation?.stage === "tools" ? [...continuation.toolResults] : [];
      const nextToolCallIndex =
        continuation?.stage === "tools" ? continuation.nextTool : 0;
      continuation = null;
      if (requestedToolCalls.length)
        agent.saveCheckpoint("tools", {
          message,
          nextTool: nextToolCallIndex,
          toolResults,
        });
      for (
        let index = nextToolCallIndex;
        index < validatedToolCalls.length;
        index++
      ) {
        toolResults.push(
          await executePreparedToolCall(
            agent,
            message,
            validatedToolCalls[index],
          ),
        );
        agent.saveCheckpoint("tools", {
          message,
          nextTool: index + 1,
          toolResults,
        });
        agent.signal.throwIfAborted();
      }
      agent.saveCheckpoint("request");

      // A policy hook sees the finalized assistant and tool observations.
      const context = {
        message,
        toolResults,
        context: { messages: agent.state.messages, tools: agent.state.tools },
      };
      const decision = await agent.options.finishTurn?.(context, agent.signal);
      await agent.emit({
        type: "turn_end",
        turn: turnNumber,
        message,
        toolResults,
      });
      if (decision?.action === "end") return;

      explicitContinuation = decision?.action === "continue";
      pendingUserMessages = agent.steering.splice(0, 1);
      assistantRequestedToolCalls = requestedToolCalls.length > 0;
      if (assistantRequestedToolCalls || pendingUserMessages.length)
        explicitContinuation = false;
    }

    pendingUserMessages = agent.followUps.splice(0, 1);
    if (pendingUserMessages.length) {
      explicitContinuation = false;
      continue;
    }
    if (explicitContinuation) {
      explicitContinuation = false;
      continue;
    }
    return;
  }
}

/**
 * Prepare the model's view, then assemble one evolving assistant response.
 * Pi counterpart: agent-loop.ts, streamAssistantResponse.
 */
export async function streamAssistantResponse(agent) {
  // A projection can include retrieved memory without rewriting stored history.
  let modelRequestContext = {
    messages: structuredClone(agent.state.messages),
    tools: agent.state.tools,
  };
  const preparedModelRequest = await agent.options.prepareRequest?.(
    { context: modelRequestContext, model: agent.state.model },
    agent.signal,
  );
  if (preparedModelRequest?.context)
    modelRequestContext = preparedModelRequest.context;
  let messagesForModelRequest = modelRequestContext.messages;
  if (agent.options.transformContext)
    messagesForModelRequest = await agent.options.transformContext(
      messagesForModelRequest,
      agent.signal,
    );
  if (agent.options.convertToLlm)
    messagesForModelRequest = await agent.options.convertToLlm(
      messagesForModelRequest,
    );

  agent.signal.throwIfAborted();
  const modelResponseEventStream = await agent.options.streamFn(
    agent.state.model,
    { messages: messagesForModelRequest },
    { signal: agent.signal },
  );
  let streamingAssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "pending",
    timestamp: Date.now(),
  };
  agent.state.streamingMessage = streamingAssistantMessage;
  await agent.emit({
    type: "message_start",
    message: streamingAssistantMessage,
  });

  for await (const event of modelResponseEventStream) {
    agent.signal.throwIfAborted();
    if (event.type === "text_delta") {
      // Deltas update the same response; they are not new conversation turns.
      streamingAssistantMessage.content[0].text += event.delta;
      await agent.emit({
        type: "message_update",
        message: streamingAssistantMessage,
        assistantMessageEvent: { type: "text_delta", delta: event.delta },
      });
    }
  }
  const completeAssistantMessage = await modelResponseEventStream.result();
  agent.signal.throwIfAborted();
  if (!["stop", "toolUse"].includes(completeAssistantMessage.stopReason))
    throw new HarnessError(
      "INCOMPLETE_RESPONSE",
      "The model response did not finish.",
    );
  if (!Array.isArray(completeAssistantMessage.content))
    throw new HarnessError(
      "INVALID_RESPONSE",
      "The model returned invalid content.",
    );
  if (
    completeAssistantMessage.content.filter((part) => part.type === "toolCall")
      .length >
      0 !==
    (completeAssistantMessage.stopReason === "toolUse")
  )
    throw new HarnessError(
      "INVALID_RESPONSE",
      "Tool calls and stop reason disagree.",
    );
  agent.state.streamingMessage = null;
  await agent.emit({ type: "message_end", message: completeAssistantMessage });
  return completeAssistantMessage;
}

/** Validate arguments without coercing the model's original values. */
export function validateToolDefinition(tool) {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
    typeof tool.description !== "string" ||
    typeof tool.execute !== "function"
  )
    throw new TypeError("A tool requires name, description and execute.");
  compiledToolArgumentValidators.set(
    tool,
    toolArgumentSchemaValidator.compile(tool.parameters),
  );
}

/** Resolve the requested name before any code can execute. */
export function prepareToolCall(agent, call) {
  const tool = agent.state.tools.find(
    (candidate) => candidate.name === call.name,
  );
  if (!tool)
    throw new HarnessError("UNKNOWN_TOOL", `Tool ${call.name} is unavailable.`);
  const validate = compiledToolArgumentValidators.get(tool);
  if (!validate(call.arguments)) {
    const paths = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new HarnessError(
      "INVALID_ARGUMENTS",
      `Invalid ${tool.name} arguments: ${paths}`,
    );
  }
  return { tool, call, args: structuredClone(call.arguments) };
}

/**
 * Tim executes only after argument validation and Harry's permission check.
 * Pi counterpart: agent-loop.ts, prepareToolCall/executePreparedToolCall.
 */
export async function executePreparedToolCall(
  agent,
  assistantMessage,
  prepared,
) {
  const { tool, call, args } = prepared;
  const hookContext = {
    assistantMessage,
    toolCall: call,
    args,
    context: { messages: agent.state.messages, tools: agent.state.tools },
  };
  const permission = await agent.options.beforeToolCall?.(
    hookContext,
    agent.signal,
  );
  agent.signal.throwIfAborted();
  await agent.emit({
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.name,
    args,
  });
  let result;
  agent.signal.throwIfAborted();
  // Until a complete result has been recorded, an interrupted execution has
  // an unknown effect. Continuation cannot silently execute it again.
  agent.unresolvedTool = { callId: call.id, name: call.name };
  try {
    result = permission?.block
      ? {
          content: [
            { type: "text", text: permission.reason || "Permission denied." },
          ],
          isError: true,
        }
      : await tool.execute(
          call.id,
          args,
          agent.signal,
          async (partialResult) => {
            await agent.emit({
              type: "tool_execution_update",
              toolCallId: call.id,
              toolName: call.name,
              partialResult,
            });
          },
        );
  } catch (error) {
    agent.signal.throwIfAborted();
    if (error.code === "TOOL_UNRESOLVED") throw error;
    // Tool failure is an observation. The next bounded turn may recover.
    result = {
      content: [{ type: "text", text: String(error.message || error) }],
      isError: true,
    };
  }
  const modified = permission?.block
    ? undefined
    : await agent.options.afterToolCall?.(
        { ...hookContext, result, isError: Boolean(result.isError) },
        agent.signal,
      );
  if (modified) result = { ...result, ...modified };
  if (!Array.isArray(result.content))
    throw new HarnessError(
      "INVALID_TOOL_RESULT",
      "A tool omitted its content.",
    );
  const message = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: Boolean(result.isError),
    timestamp: Date.now(),
  };
  await agent.emit({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result,
    isError: message.isError,
  });
  await agent.emit({ type: "message_start", message });
  await agent.emit({ type: "message_end", message });
  agent.unresolvedTool = null;
  return message;
}

/**
 * A small async event stream connects a provider adapter to the loop.
 * Pi counterpart: packages/ai/src/utils/event-stream.ts.
 */
export function createAssistantMessageEventStream() {
  const events = [];
  let wake,
    done = false,
    outcome,
    failure;
  return {
    push(event) {
      if (done) return;
      events.push(event);
      wake?.();
      wake = null;
    },
    finish(message) {
      outcome = message;
      done = true;
      wake?.();
    },
    fail(error) {
      failure = error;
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (events.length) yield events.shift();
        if (done) break;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
    },
    async result() {
      if (!done)
        throw new Error("Consume the response stream before result().");
      if (failure) throw failure;
      return outcome;
    },
  };
}
