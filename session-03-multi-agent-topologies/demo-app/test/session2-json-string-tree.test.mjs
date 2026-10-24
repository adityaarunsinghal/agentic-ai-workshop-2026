import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { inspectionDisplay, JSON_TREE_LIMITS } from "../ui/src/shared/code-display.mjs";

test("JSON strings become bounded annotated display trees while raw data, masking and count comments survive", async (t) => {
  const id = "12345678-1234-4123-8123-123456789abc";
  const value = {
    payload: JSON.stringify({
      nativeState: JSON.stringify({ requestId: id, questions: '[{"text":"<script>fixture</script>"}]' }),
      token: "private-fixture-secret",
    }),
    scalar: "42", flag: "true", nullText: "null", quoted: '"ordinary quoted prose"',
    broken: '{"broken":}', prose: "Ordinary prose.",
    prototype: '{"__proto__":{"polluted":"data only"},"constructor":{"prototype":{"safe":true}}}',
  };
  const before = structuredClone(value);
  const display = inspectionDisplay(value);
  assert.deepEqual(value, before);
  assert.deepEqual(display.clean, before);
  assert.equal(display.tree.payload.nativeState.requestId, id);
  assert.deepEqual(display.tree.payload.nativeState.questions, [{ text: "<script>fixture</script>" }]);
  assert.equal(display.tree.payload.token, "[redacted]");
  for (const field of ["scalar", "flag", "nullText", "quoted", "broken", "prose"])
    assert.equal(display.tree[field], value[field]);
  for (const parsed of [display.tree.payload, display.tree.payload.nativeState, display.tree.payload.nativeState.questions])
    assert.equal(display.parsedValues.has(parsed), true);
  assert.equal(display.parsedValues.has(display.tree.payload.nativeState.questions[0]), false);
  assert.equal(Object.hasOwn(display.tree.prototype, "__proto__"), true);
  assert.deepEqual(display.tree.prototype.__proto__, { polluted: "data only" });
  assert.equal(Object.getPrototypeOf(display.tree.prototype), Object.prototype);
  assert.equal({}.polluted, undefined);
  const array = inspectionDisplay(' [1, {"nested":"[]"}] ');
  assert.deepEqual(array.tree, [1, { nested: [] }]);
  assert.equal(array.parsedValues.has(array.tree), true);
  assert.equal(array.parsedValues.has(array.tree[1].nested), true);

  let nested = '{"end":true}';
  for (let index = 0; index < JSON_TREE_LIMITS.decodedLayers + 2; index++) nested = JSON.stringify({ nested });
  let last = inspectionDisplay(nested).tree, layers = 0;
  while (typeof last === "object") { layers++; last = last.nested; }
  assert.equal(layers, JSON_TREE_LIMITS.decodedLayers);
  assert.equal(typeof last, "string");
  for (const bounded of [
    `{"text":"${"x".repeat(JSON_TREE_LIMITS.characters)}"}`,
    JSON.stringify(Array.from({ length: JSON_TREE_LIMITS.nodes + 1 }, () => 0)),
    "[".repeat(JSON_TREE_LIMITS.depth + 1) + "0" + "]".repeat(JSON_TREE_LIMITS.depth + 1),
  ]) assert.equal(inspectionDisplay({ bounded }).tree.bounded, bounded);

  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const saved = {};
  for (const [key, replacement] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: replacement });
  }
  const loader = await createServer({
    configFile: false, root: fileURLToPath(new URL("../ui", import.meta.url)),
    server: { middlewareMode: true, watch: null, hmr: false },
  });
  const root = createRoot(dom.window.document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    await loader.close();
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const { JsonInspector } = await loader.ssrLoadModule("/src/shared/Inspector.jsx");
  await act(() => root.render(React.createElement(JsonInspector, { value })));
  const button = dom.window.document.querySelector("button");
  assert.equal(button.textContent, "Expand tree", "the tree still starts collapsed");
  await act(() => button.click());
  const annotations = [...dom.window.document.querySelectorAll(".json-parsed-string")];
  assert.equal(annotations.length, 4);
  assert.ok(annotations.every((element) => element.textContent === "# parsed JSON string"));
  assert.ok(annotations.every((element) => /\d+ items?/.test(element.parentElement.textContent)));
  assert.ok(dom.window.document.querySelector('.incidental-value[data-concealed="true"]'), "decoded opaque IDs still use the reveal mask");
  assert.equal(dom.window.document.querySelector("script"), null);
  assert.ok(!dom.window.document.body.textContent.includes("private-fixture-secret"));
  assert.deepEqual(value, before);
});
