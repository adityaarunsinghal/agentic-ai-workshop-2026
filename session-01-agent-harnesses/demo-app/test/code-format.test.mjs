import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, embeddedCode, highlightCode, prettyJson } from "../ui/code-format.mjs";

test("JSON display preserves duplicate keys, big integers, escapes and numeric notation", () => {
  const original = '{"id":900719925474099312345,"id":-0,"rate":1.00e+3,"text":"\\\\u0061","items":[]}';
  assert.equal(prettyJson(original), '{\n  "id": 900719925474099312345,\n  "id": -0,\n  "rate": 1.00e+3,\n  "text": "\\\\u0061",\n  "items": []\n}');
  const invalid = '{"unfinished":';
  assert.equal(prettyJson(invalid), invalid);
  const deep = "[".repeat(100) + "0" + "]".repeat(100);
  assert.equal(prettyJson(deep), deep);
});

test("syntax colors escape markup and preserve source text including CRLF", () => {
  const source = "const sample = '<img src=x onerror=alert(1)>';\r\n// A comment.\r\n";
  const result = highlightCode(source, "demo.mjs");
  assert.equal(result.text, source);
  assert.equal(result.language, "javascript");
  assert.match(result.html, /hljs-keyword/);
  assert.doesNotMatch(result.html, /<img|<script|onerror="/);
  assert.match(result.html, /&#13;/);
  assert.equal(detectLanguage("constructor"), "plaintext");
  assert.equal(detectLanguage("original.ts"), "typescript");
});

test("embedded JSON and code are optional display projections without editing the record", () => {
  const value = { content: [{ text: '{"id":900719925474099312345}' }],
    answer: "Example:\n```python\nprint('hello')\n```", other: "Ordinary newspaper prose." };
  const original = structuredClone(value);
  const found = embeddedCode(value);
  assert.deepEqual(found.map(({ path, language }) => ({ path, language })), [
    { path: "content[0].text", language: "json" }, { path: "answer", language: "python" },
  ]);
  assert.deepEqual(value, original);
  assert.equal(embeddedCode(value, { maxEntries: 1 }).length, 1);
});
