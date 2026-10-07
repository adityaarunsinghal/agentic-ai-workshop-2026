// Parse SSE framing with the directly pinned parser library.
import { createParser } from "eventsource-parser";

// Compare every replay metadata field, including nested values and absence.
import { isDeepStrictEqual } from "node:util";
import { RESOURCE_LIMITS_FOR_HARNESS_TESTING } from "./limits.mjs";
import { HarnessError } from "../agent/pi-mini.mjs";

// Reject malformed data without guessing missing protocol fields.
function requireValue(condition, message, code) {
  // Keep the failed exchange out of committed model history.
  if (!condition) {
    const error = Error(message);
    // Preserve a local validation code through the workshop error wrapper.
    if (code) error.code = code;
    throw error;
  }
}

// Identify JSON records without accepting arrays or null.
const record = (value) =>
  // Require a non-null object.
  value !== null && typeof value === "object" && !Array.isArray(value);

// A trailing usage frame may repeat empty fields without adding message data.
function emptyTrailingDelta(delta) {
  return Object.entries(delta).every(
    ([field, value]) =>
      // Null fields carry no payload, including fields unknown to this app.
      value == null ||
      // Only the already expected speaker may be repeated.
      (field === "role" && value === "assistant") ||
      // Empty text is permitted only for known text fields.
      ([
        "content",
        "reasoning",
        "reasoning_content",
        "reasoning_text",
        "refusal",
      ].includes(field) &&
        value === "") ||
      // Nonempty replay or tool arrays remain substantive, even with empty records.
      (["tool_calls", "reasoning_details"].includes(field) &&
        Array.isArray(value) &&
        value.length === 0),
  );
}

// Append only string deltas, including reasoning aliases.
function append(target, source, field) {
  // Null and absent fields carry no new text.
  if (source[field] == null) return;
  // Reject non-text deltas.
  requireValue(typeof source[field] === "string", "Invalid model text.");
  // Keep every character in arrival order.
  target[field] = (target[field] ?? "") + source[field];
  // Match the broker's maximum replayable text size.
  requireValue(
    target[field].length <= 2 * 1024 * 1024,
    // Explain that no text is silently shortened.
    "Model text exceeds the broker replay limit.",
  );
}

// Assemble indexed text fragments while leaving other replay records opaque.
function appendReasoning(details, fragment) {
  // Exclude only the top-level text delta from exact metadata matching.
  const { text, ...metadata } = fragment;
  // Merge only the indexed text shape confirmed by live provider evidence.
  if (
    fragment.type === "reasoning.text" &&
    typeof text === "string" &&
    // Missing or ambiguous indexes leave the original record untouched.
    Number.isSafeInteger(fragment.index) &&
    fragment.index >= 0
  ) {
    // Keep each logical block at the position of its first fragment.
    const existing = details.find((prior) => {
      // Compare complete non-text metadata without changing stored fields.
      const { text: priorText, ...priorMetadata } = prior;
      // Require the same type, index, format, identity and unknown metadata.
      return (
        typeof priorText === "string" &&
        // Field presence and nested values must also agree exactly.
        isDeepStrictEqual(priorMetadata, metadata)
      );
    });
    // Reuse a prior matching block even when fragments were interleaved.
    if (existing) {
      // Preserve the complete text under the existing replay size guard.
      append(existing, fragment, "text");
      // A transport fragment does not consume another logical record.
      return;
    }
    // Preserve the first fragment's metadata and original property order.
    const first = { ...fragment, text: "" };
    // Apply the same text guard to a block's first fragment.
    append(first, fragment, "text");
    // Retain the new logical block at its first appearance.
    details.push(first);
    // Keep encrypted, unindexed and other records uninterpreted.
  } else {
    // Preserve the complete original record, including opaque duplicates.
    details.push(fragment);
  }
  // Count logical records after merging eligible transport fragments.
  requireValue(
    details.length <= 128,
    // Preserve the broker's existing limit without dropping any context.
    "Reasoning replay exceeds the broker's 128-record limit.",
  );
}

// Assemble one paid response before allowing any tool execution.
export async function readCompletion(response, onText, { onUsage } = {}) {
  // The broker may reject admission with ordinary JSON before streaming.
  requireValue(response.body, "The broker returned no stream.");
  // An HTTP-200 error envelope is still a failed request. Preserve the same
  // safe metadata as an SSE error instead of reducing it to a format mismatch.
  if (
    response.headers.get("content-type")?.split(";")[0].trim() ===
    "application/json"
  ) {
    const data = await response.json();
    if (data?.error)
      throw new HarnessError(
        data.error.code || "PROVIDER_FAILED",
        data.error.message || "The broker request failed.",
        data.error,
      );
  }
  // Refuse an unexpected success response format.
  requireValue(
    // Ignore optional content-type parameters.
    response.headers.get("content-type")?.split(";")[0].trim() ===
      // Require the requested streaming contract.
      "text/event-stream",
    // Keep a protocol mismatch visible.
    "The broker did not return an SSE stream.",
  );

  // Build only message fields accepted by the broker on replay.
  const message = { role: "assistant", content: "" };
  // Stream indexes identify interleaved calls until assembly completes.
  const calls = new Map();
  // Decode split UTF-8 characters without replacement or corruption.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Own this model reader independently of all browser view streams.
  const reader = response.body.getReader();
  // Require both semantic completion and broker settlement.
  let finish = null,
    done = false,
    bytes = 0,
    trailingCR = false;

  // Validate every supplied finish reason, including repeated usage metadata.
  function recordFinish(value) {
    if (value == null) return;
    // Truncation and filtering must stay visible failures.
    requireValue(
      ["stop", "tool_calls"].includes(value),
      "The model did not finish its reply.",
      finish === null ? undefined : "INVALID_RESPONSE",
    );
    // Repeated termination must agree with the original reason.
    requireValue(
      finish === null || finish === value,
      "The model changed its finish reason.",
      "INVALID_RESPONSE",
    );
    finish = value;
  }

  // Accept only complete SSE events from the parser.
  const parser = createParser({
    // Bound an unfinished frame without discarding any of it.
    maxBufferSize: 1024 * 1024,
    // Do not display malformed framing or raw parser data.
    onError: () => {
      throw Error("Invalid broker SSE framing.");
    },
    // Assemble one broker event.
    onEvent(event) {
      // The broker uses ordinary data events for both replies and errors.
      requireValue(
        !event.event || event.event === "message",
        // Unknown event semantics require a contract decision.
        "Unexpected broker SSE event.",
      );
      // Reject additional events after terminal settlement.
      requireValue(!done, "The broker sent data after completion.");
      // This marker is emitted only after the broker commits settlement.
      if (event.data === "[DONE]") {
        // A marker alone cannot complete an unfinished assistant reply.
        requireValue(finish !== null, "The model omitted its finish reason.");
        // Record settlement without running tools inside the parser.
        done = true;
        return;
      }

      // Decode the broker's JSON without echoing malformed private data.
      let data;
      // Keep parse diagnostics out of browser-visible error messages.
      try {
        data = JSON.parse(event.data);
      } catch {
        // JSON parser errors can otherwise quote reasoning or tool arguments.
        throw Error("Invalid JSON in the broker stream.");
      }
      // Require an ordinary completion or terminal error object.
      requireValue(record(data), "Invalid broker completion.");
      // A terminal broker error can follow already visible text and usage.
      if (data.error) {
        // Preserve its useful explanation and operation reference.
        throw new HarnessError(
          data.error.code || "PROVIDER_FAILED",
          data.error.message || "The broker stream failed.",
          data.error,
        );
      }
      // Usage is an observation; the broker retains monetary authority.
      if (record(data.usage)) onUsage?.(data.usage);
      // A usage-only frame has an empty choices array.
      requireValue(
        Array.isArray(data.choices) && data.choices.length <= 1,
        // Never silently choose between multiple completions.
        "Unexpected model choices.",
      );
      // Usage belongs to the broker; it does not complete this exchange.
      if (!data.choices.length) return;
      // Read the sole advertised choice.
      const choice = data.choices[0];
      // Require the broker's first-choice contract.
      requireValue(
        record(choice) && choice.index === 0,
        // Reject ambiguous choice identities.
        "Unexpected model choice index.",
      );
      // Once finished, only empty deltas or usage may follow.
      const delta = choice.delta ?? {};
      // Keep malformed data out of the accumulator.
      requireValue(record(delta), "Invalid model delta.");
      if (finish !== null) {
        // A trailing frame cannot change or invalidate semantic completion.
        recordFinish(choice.finish_reason);
        // Usage was observed above; only known empty fields and nulls may follow.
        requireValue(
          emptyTrailingDelta(delta),
          "The model sent a delta after its finish reason.",
          "INVALID_RESPONSE",
        );
        // Do not append empty aliases or allocate replay arrays in history.
        return;
      }
      // Require the assistant role whenever a role is supplied.
      requireValue(
        delta.role == null || delta.role === "assistant",
        // Refuse another speaker in a completion.
        "Unexpected model role.",
      );
      // A refusal is a failed exchange, with any partial text preserved.
      requireValue(!delta.refusal, "The model refused this request.");

      // Preserve visible text and each supported reasoning alias.
      for (const field of [
        // Keep the answer text.
        "content",
        "reasoning",
        "reasoning_content",
        "reasoning_text",
      ])
        append(message, delta, field);
      // Display only answer text, never private reasoning.
      if (delta.content) onText(delta.content);
      // Assemble known text fragments and preserve opaque replay records.
      if (delta.reasoning_details != null) {
        // Each block must remain a replayable JSON record.
        requireValue(
          Array.isArray(delta.reasoning_details) &&
            // Leave every opaque block's own fields and indexes intact.
            delta.reasoning_details.every(record),
          // Reject invalid replay metadata.
          "Invalid reasoning replay records.",
        );
        // Allocate the replay list only when the model supplies it.
        message.reasoning_details ??= [];
        // Merge only indexed text with exactly matching non-text metadata.
        for (const fragment of delta.reasoning_details)
          // Keep the first block order and enforce the logical-record ceiling.
          appendReasoning(message.reasoning_details, fragment);
      }

      // Accumulate tool calls without executing partial arguments.
      if (delta.tool_calls != null) {
        // Require a list of streamed calls.
        requireValue(Array.isArray(delta.tool_calls), "Invalid tool deltas.");
        // Assemble each call by its transport index.
        for (const part of delta.tool_calls) {
          // Enforce the existing four-tool ceiling before allocation.
          requireValue(
            record(part) &&
              Number.isInteger(part.index) &&
              // Require a bounded zero-based transport index.
              part.index >= 0 &&
              part.index <
                RESOURCE_LIMITS_FOR_HARNESS_TESTING.toolCallsPerResponse,
            // Do not infer indexes from array order.
            "Invalid or excessive tool-call index.",
          );
          // Initialize a replayable function call without a transport index.
          const call = calls.get(part.index) ?? {
            // Accumulate the provider's call identity.
            id: "",
            // Only function tools are permitted by this app.
            type: "function",
            // Keep the complete function name and JSON argument string.
            function: { name: "", arguments: "" },
          };
          // Reject unsupported tool types.
          requireValue(
            part.type == null || part.type === "function",
            // Explain the unsupported call.
            "Unexpected tool-call type.",
          );
          // Append an identity supplied in one or more chunks.
          append(call, part, "id");
          // A delta may carry only its call index or identity.
          if (part.function != null) {
            // Validate the function container.
            requireValue(record(part.function), "Invalid tool function.");
            // Preserve split function names.
            append(call.function, part.function, "name");
            // Preserve split JSON arguments, including Unicode.
            append(call.function, part.function, "arguments");
          }
          // Save the assembled call in index order at completion.
          calls.set(part.index, call);
        }
      }
      // Record a finish reason without confusing it with settlement.
      recordFinish(choice.finish_reason);
    },
  });

  // Release the model reader on every success or failure.
  try {
    // Read until the broker's settlement marker.
    while (!done) {
      // The fetch deadline also governs this body read.
      const next = await reader.read();
      // Flush the UTF-8 decoder at EOF, which may expose malformed bytes.
      if (next.done) {
        // A partial SSE frame is never synthesized at EOF.
        parser.feed(decoder.decode());
        // Resolve the parser's deferred CR as CRLF only after an actual CR.
        if (trailingCR) parser.feed("\n");
        // Require a complete terminal marker.
        requireValue(done, "Broker stream interrupted before settlement.");
        // Stop reading the completed body.
        break;
      }
      // Match the broker's complete response byte ceiling.
      bytes += next.value.byteLength;
      // Fail visibly instead of truncating a model response.
      requireValue(bytes <= 4 * 1024 * 1024, "Model stream exceeds 4 MiB.");
      // Preserve split UTF-8 characters before inspecting line endings.
      const text = decoder.decode(next.value, { stream: true });
      // Remember an actual trailing CR; empty decoder chunks change nothing.
      if (text) trailingCR = text.endsWith("\r");
      // Let the parser own all decoded frame boundaries.
      parser.feed(text);
    }
    // Require tool termination precisely when calls were assembled.
    requireValue(
      (finish === "tool_calls") === calls.size > 0,
      // Refuse an incomplete tool exchange.
      "The model's finish reason does not match its tool calls.",
    );
    // Validate every call before any HN request is dispatched.
    const assembled = [...calls].sort(([a], [b]) => a - b);
    // Require contiguous, complete calls with unique identities.
    const identities = new Set();
    // Inspect all completed calls.
    for (const [position, [index, call]] of assembled.entries()) {
      // Match the broker's replayable call schema.
      requireValue(
        index === position &&
          call.id.length > 0 &&
          // Bound and deduplicate call identities.
          call.id.length <= 256 &&
          !identities.has(call.id) &&
          // Allow only ordinary advertised function names.
          /^[a-zA-Z0-9_-]{1,64}$/.test(call.function.name) &&
          // Keep the existing tool argument ceiling.
          call.function.arguments.length <= 65536,
        // Fail before executing any part of the tool batch.
        "Incomplete or duplicate tool call.",
      );
      // Require an entire JSON object, never a partial argument string.
      requireValue(
        record(JSON.parse(call.function.arguments)),
        // Let HN validate the remaining schema.
        "HN tool arguments must be a JSON object.",
      );
      // Remember this identity.
      identities.add(call.id);
    }
    // Replay only completed tool records with transport indexes removed.
    if (calls.size) message.tool_calls = assembled.map(([, call]) => call);
    // Text-only completions must contain a visible answer.
    else requireValue(message.content.trim(), "The model returned no text.");
    // Return only a validated and settled assistant message.
    return message;
    // Always release the stream even after malformed input.
  } finally {
    // Stop reading this completed or failed response without any retry.
    await reader.cancel().catch(() => {});
    // Release the reader lock.
    reader.releaseLock();
  }
}
