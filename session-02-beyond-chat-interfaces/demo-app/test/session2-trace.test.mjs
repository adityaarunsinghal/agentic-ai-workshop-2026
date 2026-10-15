import test from "node:test";
import assert from "node:assert/strict";
import { createTrace } from "../src/trace.mjs";

test("Execution preserves requests and visible output while retaining SDK reasoning on the server", () => {
  const trace = createTrace({ secrets: ["fixture-secret"] });
  trace.record("agent.message_update", {
    update: { type: "thinking_delta", delta: "private reasoning", contentIndex: 0 },
  });
  trace.record("model.response", {
    message: {
      content: [
        { type: "thinking", thinking: "private reasoning", thinkingSignature: "opaque replay" },
        { type: "text", text: "Visible answer" },
        { type: "toolCall", name: "fetch_read", arguments: { url: "https://example.org" } },
      ],
      usage: { cost: 0.001 },
    },
    authorization: "Bearer fixture-secret",
  });
  trace.record("agent.message_update", {
    update: { type: "text_delta", delta: "Visible answer", contentIndex: 1 },
  });
  trace.record("source.response", {
    headers: { "set-cookie": "opaque-session=private-cookie; HttpOnly", "content-type": "text/plain" },
  });
  const serialized = JSON.stringify(trace.entries);
  assert.doesNotMatch(serialized, /private reasoning|opaque replay|fixture-secret|private-cookie/);
  assert.equal(trace.entries[0].update.delta, "[retained on server]");
  assert.equal(trace.entries[1].message.content[1].text, "Visible answer");
  assert.deepEqual(trace.entries[1].message.content[2].arguments, { url: "https://example.org" });
  assert.equal(trace.entries[1].message.usage.cost, 0.001);
  assert.equal(trace.entries[2].update.delta, "Visible answer");
  assert.equal(trace.entries[3].headers["set-cookie"], "[retained on server]");
  assert.equal(trace.entries[3].headers["content-type"], "text/plain");
});

test("fetch failures retain only known network cause codes, never transport credentials", async (t) => {
  const trace = createTrace();
  t.after(() => trace.close());
  for (const code of ["UND_ERR_INVALID_ARG", "ECONNRESET", "UNKNOWN_PRIVATE_CODE"]) {
    const cause = Object.assign(new Error("http://visit:private-proxy-secret@127.0.0.1/"), {
      code, headers: { "proxy-authorization": "private-proxy-secret" },
    });
    const dispatcher = { dispatch() { throw cause; } };
    await assert.rejects(trace.fetch("https://source.example.org/", { dispatcher }), TypeError);
    const entry = trace.entries.at(-1);
    assert.equal(entry.status, "failed");
    assert.equal(entry.causeCode, code === "UNKNOWN_PRIVATE_CODE" ? undefined : code);
    assert.doesNotMatch(JSON.stringify(entry), /private-proxy-secret|UNKNOWN_PRIVATE_CODE|127\.0\.0\.1/);
  }
});
