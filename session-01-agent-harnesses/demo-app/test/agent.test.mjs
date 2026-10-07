import test from "node:test";
import assert from "node:assert/strict";
import { Agent, createAssistantMessageEventStream } from "../agent/pi-mini.mjs";

test("an invalid tool batch cannot partially execute", async () => {
  let effects = 0;
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    stream.finish({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "valid",
          name: "remember",
          arguments: { topic: "tools" },
        },
        {
          type: "toolCall",
          id: "invalid",
          name: "remember",
          arguments: { topic: 42 },
        },
      ],
    });
    return stream;
  };
  const agent = new Agent({
    initialState: {
      model: { id: "fixture/validation" },
      tools: [
        {
          name: "remember",
          description: "Record the supplied topic.",
          parameters: {
            type: "object",
            properties: { topic: { type: "string" } },
            required: ["topic"],
            additionalProperties: false,
          },
          execute: async () => {
            effects++;
            return { content: [{ type: "text", text: "Saved" }] };
          },
        },
      ],
    },
    streamFn,
  });
  await agent.prompt("Remember a topic.");
  assert.equal(agent.state.outcome.code, "INVALID_ARGUMENTS");
  assert.equal(effects, 0);
});
