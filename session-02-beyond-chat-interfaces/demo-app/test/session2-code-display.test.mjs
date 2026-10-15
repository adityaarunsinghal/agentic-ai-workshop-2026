import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { undo, redo } from "@codemirror/commands";
import { highlightingFor } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { highlightCode, prettyJson, MAX_HIGHLIGHT_CHARACTERS } from "../ui/src/shared/code-format.mjs";
import { copyCode, inspectionCodeFields, inspectionDisplay } from "../ui/src/shared/code-display.mjs";
import { renderMarkdown } from "../ui/src/shared/markdown-display.mjs";
import { formatJsonArguments, jsonArgumentsState } from "../ui/src/shared/json-arguments.mjs";

const exactJson = String.raw`{"id":900719925474099312345,"id":-0,"scale":1.2300e+09,"text":"\u0061\/\n<script>alert('fixture')</script>"}`;

test("formatted inspection preserves the redacted value and decodes separate views without changing JSON lexemes", () => {
  const value = {
    authorization: "private fixture credential",
    payload: { arguments: exactJson, content: '```python\nprint("<script>fixture</script>")\n```' },
  };
  const before = structuredClone(value);
  const display = inspectionDisplay(value);
  assert.deepEqual(value, before);
  assert.equal(display.tree.authorization, "[redacted]");
  assert.ok(!JSON.stringify(display.tree).includes("private fixture credential"));
  assert.equal(display.clean.payload.arguments, exactJson);
  assert.deepEqual(display.tree.payload.arguments, JSON.parse(exactJson));
  assert.equal(display.parsedValues.has(display.tree.payload.arguments), true);
  const fields = inspectionCodeFields(display.clean);
  assert.deepEqual(fields.map(({ path, language }) => ({ path, language })), [
    { path: "payload.arguments", language: "json" },
    { path: "payload.content", language: "python" },
  ]);
  assert.equal(fields[0].text, exactJson);
  const highlighted = highlightCode(fields[0].text, "json", { formatJson: true });
  assert.match(highlighted.text, /900719925474099312345/);
  assert.match(highlighted.text, /1\.2300e\+09/);
  assert.match(highlighted.text, /\\u0061\\\/\\n/);
  assert.equal(highlighted.text.match(/"id"/g).length, 2);
  const document = new JSDOM(`<pre><code>${highlighted.html}</code></pre>`).window.document;
  assert.equal(document.querySelector("code").textContent, highlighted.text);
  assert.equal(document.querySelector("script"), null);
  assert.ok(document.querySelector('code [class^="hljs-"]'));
});

test("bounded embedded discovery keeps the complete original value and long display text available", () => {
  const value = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, `{"index":${index}}`]));
  const display = inspectionDisplay(value);
  assert.equal(inspectionCodeFields(display.clean).length, 12);
  assert.deepEqual(display.clean, value);
  assert.deepEqual(display.tree.field0, { index: 0 });
  const long = `${"x".repeat(MAX_HIGHLIGHT_CHARACTERS + 1)}<script>END_OF_FULL_TEXT</script>`;
  const highlighted = highlightCode(long, "javascript");
  assert.equal(highlighted.text, long);
  assert.ok(highlighted.html.endsWith("&lt;script&gt;END_OF_FULL_TEXT&lt;/script&gt;"));
});

test("Markdown renders colored fences and safe links without active HTML or remote images", () => {
  const source = [
    "# A source-backed briefing",
    '<script>globalThis.fixtureExecuted = true</script><img src="https://images.example/remote" onerror="alert(1)">',
    '[HN source](https://news.ycombinator.com/item?id=123) [bad](javascript:alert(1))',
    '![Remote diagram](https://images.example/diagram.png)',
    '```html',
    '<img src="https://images.example/code" onerror="alert(2)"><script>alert(3)</script>',
    '```',
    '```json',
    exactJson,
    '```',
  ].join("\n\n");
  const document = new JSDOM(renderMarkdown(source)).window.document;
  assert.equal(document.querySelectorAll("script, img, iframe, style, object, embed").length, 0);
  const links = [...document.querySelectorAll("a")];
  assert.deepEqual(links.map((link) => link.getAttribute("href")), [
    "https://images.example/remote", "https://news.ycombinator.com/item?id=123",
  ]);
  assert.ok(links.every((link) => link.getAttribute("rel") === "noopener noreferrer"));
  assert.ok(document.querySelector(".markdown-image-alt").textContent.includes("Remote diagram"));
  const code = [...document.querySelectorAll("pre code")];
  assert.equal(code.length, 2);
  assert.ok(code[0].textContent.includes('<script>alert(3)</script>'));
  assert.ok(code[0].querySelector('[class^="hljs-"]'));
  assert.equal(code[1].textContent, prettyJson(`${exactJson}\n\n`));
  assert.ok(code[1].textContent.includes("900719925474099312345"));
  assert.equal(code[1].textContent.match(/"id"/g).length, 2);
  assert.ok([...document.querySelectorAll("button")].every((button) => button.type === "button"));
});

test("unknown fence hints and script-looking Markdown attributes remain escaped text", () => {
  const document = new JSDOM(renderMarkdown([
    '```unknown"><img/onerror=alert(1)>',
    '</code></pre><script>alert("fixture")</script>',
    '```',
    '<a href="javascript:alert(2)">raw HTML</a>',
    '[unsafe](data:text/html;base64,PHNjcmlwdD4=)',
  ].join("\n"))).window.document;
  assert.equal(document.querySelectorAll("script, img, a").length, 0);
  assert.equal(document.querySelector("pre code").textContent, '</code></pre><script>alert("fixture")</script>\n');
  assert.ok(document.querySelector("pre code").classList.contains("language-plaintext"));
});

test("copy uses the entire display text and native selection remains usable when clipboard permission is denied", async () => {
  const document = new JSDOM("<pre tabindex='0'><code></code></pre>").window.document;
  const element = document.querySelector("code");
  const display = highlightCode(exactJson, "json", { formatJson: true });
  element.innerHTML = display.html;
  let copied;
  const clipboard = { writeText: async (text) => { copied = text; } };
  Object.defineProperty(document.defaultView.navigator, "clipboard", { value: clipboard });
  assert.equal(await copyCode(display.text, element), "Copied");
  assert.equal(copied, display.text);
  clipboard.writeText = async () => { throw new Error("Permission denied"); };
  assert.equal(await copyCode(display.text, element), "Code selected. Press Ctrl/Cmd+C to copy.");
  assert.equal(document.getSelection().toString(), display.text);
  assert.equal(element.textContent, display.text);
});

function argumentTarget(text) {
  let state = jsonArgumentsState(text);
  let calls = 0;
  return {
    get state() { return state; },
    get calls() { return calls; },
    dispatch(transaction) { calls++; state = transaction.state; },
  };
}

test("JSON argument colors preserve unformatted input, and explicit formatting is a single undoable edit", () => {
  const original = ` \t${exactJson.slice(0, -1)},\r\n  "enabled":true }\r\n`;
  const target = argumentTarget(original);
  assert.equal(target.state.sliceDoc(), original);
  assert.equal(target.calls, 0);
  assert.equal(highlightingFor(target.state, [tags.propertyName]), "code-property");
  assert.equal(highlightingFor(target.state, [tags.string]), "code-string");
  assert.equal(highlightingFor(target.state, [tags.number]), "code-number");
  assert.equal(formatJsonArguments(target), true);
  assert.equal(target.calls, 1);
  assert.equal(target.state.sliceDoc(), prettyJson(original));
  assert.equal(target.state.sliceDoc().match(/"id"/g).length, 2);
  assert.equal(undo(target), true);
  assert.equal(target.state.sliceDoc(), original);
  assert.equal(redo(target), true);
  assert.equal(target.state.sliceDoc(), prettyJson(original));
});

test("incomplete JSON and an active composition remain untouched without new diagnostics or dispatches", () => {
  const incomplete = argumentTarget('{"日本語": "typing');
  assert.equal(formatJsonArguments(incomplete), false);
  assert.equal(incomplete.state.sliceDoc(), '{"日本語": "typing');
  assert.equal(incomplete.calls, 0);
  const composing = argumentTarget('{"日本語":"入力"}');
  composing.composing = true;
  assert.equal(formatJsonArguments(composing), false);
  assert.equal(composing.calls, 0);
  assert.equal(composing.state.sliceDoc(), '{"日本語":"入力"}');
});
