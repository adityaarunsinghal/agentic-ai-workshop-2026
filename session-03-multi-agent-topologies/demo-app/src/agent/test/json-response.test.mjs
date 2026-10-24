import assert from "node:assert/strict";
import test from "node:test";
import { parseModelJsonObject } from "../json-response.mjs";

test("ordinary JSON stays exact and fenced JSON records its normalization", () => {
  const text = '{"body":"A quoted \\"claim\\".\\nAnother paragraph.","sourceIds":["source-1"]}';
  assert.deepEqual(parseModelJsonObject(text), { value: JSON.parse(text), recovery: null });
  const fenced = parseModelJsonObject(`\`\`\`json\n${text}\n\`\`\``);
  assert.deepEqual(fenced.value, JSON.parse(text));
  assert.equal(fenced.recovery.markdownFence, true);
});

test("literal string controls can be escaped without repairing missing JSON syntax", () => {
  const parsed = parseModelJsonObject('{"body":"First paragraph.\n\nSecond paragraph."}');
  assert.equal(parsed.value.body, "First paragraph.\n\nSecond paragraph.");
  assert.equal(parsed.recovery.stringControlsEscaped, true);
  for (const text of ['{"body":"unfinished', '{"body":"ok",}', '{"body":"bad\\\nline"}'])
    assert.throws(() => parseModelJsonObject(text), { code: "JSON_RESPONSE" });
});

test("a repeated complete candidate survives an identical truncated final copy", () => {
  const candidate = { headline: "Observed event", body: "A supported claim.", sourceIds: ["source-1"], changes: ["Clarified attribution."] };
  const text = JSON.stringify(candidate);
  const response = Array.from({ length: 8 }, () => text).join("\n(Actually only JSON object no extra)\n") +
    "\n(JSON ONLY.)\n" + text.slice(0, 42);
  const parsed = parseModelJsonObject(response);
  assert.deepEqual(parsed.value, candidate);
  assert.deepEqual(parsed.recovery, {
    kind: "identical_json_repetitions", completeCopies: 8, discardedPartialCopy: true,
    markdownFence: false, stringControlsEscaped: false,
  });
});

test("conflicting answers, qualifications and a lone partial rewrite require explicit recovery", () => {
  for (const [text, reason] of [
    ['{"body":"first"}\n{"body":"different"}', "conflicting_objects"],
    ['{"body":"first"}\nThis assertion is unsupported.', "non_json_suffix"],
    ['{"body":"first"}\n{"body":"f', "incomplete_json"],
    ['{"body":"first"}\n{"body":"first"}\n{"body":"different', "incomplete_json"],
  ]) assert.throws(() => parseModelJsonObject(text), (error) =>
    error.code === "JSON_RESPONSE" && error.reason === reason);
});

test("braces inside strings and reordered identical keys do not confuse object boundaries", () => {
  const first = '{"body":"Text with } [ and { braces.","sourceIds":["source-1"]}';
  const second = '{"sourceIds":["source-1"],"body":"Text with } [ and { braces."}';
  assert.deepEqual(parseModelJsonObject(`${first}\n${second}`).value, JSON.parse(first));
  for (const text of ['null', '[]', '"a string"', '42'])
    assert.throws(() => parseModelJsonObject(text), { code: "JSON_RESPONSE", reason: "not_object" });
});
