/**
 * Display-only code formatting. Records and model/tool inputs are never edited.
 * Both independently installable demos carry the same small presentation module.
 */
import core from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";

const highlighter = core.newInstance();
const languages = { json, xml, javascript, typescript, python, bash, css, yaml, markdown, sql, diff, go, rust, java, cpp };
for (const [name, language] of Object.entries(languages))
  highlighter.registerLanguage(name, language);
const aliases = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", sh: "bash", shell: "bash",
  shellscript: "bash", zsh: "bash", console: "bash",
  html: "xml", htm: "xml", svg: "xml", yml: "yaml", md: "markdown",
  jsonc: "json", json5: "json", c: "cpp", cc: "cpp", cxx: "cpp", "c++": "cpp",
  rs: "rust", patch: "diff", text: "plaintext", txt: "plaintext",
};
export const MAX_HIGHLIGHT_CHARACTERS = 500000;
const escapeHtml = (text) => text.replace(/[&<>"'\r]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\r": "&#13;",
}[character]));

export function detectLanguage(hint = "") {
  const value = String(hint).trim().toLowerCase();
  const extension = value.split(/[\\/]/).at(-1).split(".").at(-1);
  return Object.hasOwn(aliases, value) ? aliases[value]
    : Object.hasOwn(aliases, extension) ? aliases[extension]
      : Object.hasOwn(languages, value) ? value
        : Object.hasOwn(languages, extension) ? extension : "plaintext";
}

/**
 * Change JSON whitespace without reserializing its numbers, keys or strings.
 * Large integers, duplicate keys, numeric notation and escapes stay exact.
 */
export function prettyJson(value) {
  const text = String(value ?? "");
  if (text.length > MAX_HIGHLIGHT_CHARACTERS) return text;
  try { JSON.parse(text); } catch { return text; }
  const tokens = text.match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g) ?? [];
  const output = [];
  let depth = 0;
  const newline = () => output.push("\n", "  ".repeat(depth));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], previous = tokens[index - 1], next = tokens[index + 1];
    if (token === "{" || token === "[") {
      output.push(token);
      if (!((token === "{" && next === "}") || (token === "[" && next === "]"))) {
        depth++;
        if (depth > 80) return text;
        newline();
      }
    } else if (token === "}" || token === "]") {
      if (!((token === "}" && previous === "{") || (token === "]" && previous === "["))) {
        depth = Math.max(0, depth - 1);
        newline();
      }
      output.push(token);
    } else if (token === ",") {
      output.push(token); newline();
    } else if (token === ":") output.push(": ");
    else output.push(token);
  }
  return output.join("");
}

export function highlightCode(value, language = "plaintext", { formatJson = false } = {}) {
  const original = String(value ?? "");
  const selected = detectLanguage(language);
  const text = formatJson && selected === "json" ? prettyJson(original) : original;
  const result = { text, language: selected, formatted: text !== original };
  if (selected === "plaintext" || text.length > MAX_HIGHLIGHT_CHARACTERS)
    return { ...result, html: escapeHtml(text), highlighted: false };
  try {
    return {
      ...result, html: highlighter.highlight(text, { language: selected, ignoreIllegals: true })
        .value.replace(/\r/g, "&#13;"),
      highlighted: true,
    };
  } catch {
    return { ...result, html: escapeHtml(text), highlighted: false };
  }
}

/** Decode only explicit JSON strings and fenced code, with bounded discovery. */
export function embeddedCode(value, { maxEntries = 12, maxDepth = 10 } = {}) {
  const found = [], seen = new WeakSet(), duplicates = new Set();
  let visited = 0;
  const add = (path, language, text) => {
    if (found.length >= maxEntries) return;
    const key = `${language}:${text}`;
    if (duplicates.has(key)) return;
    duplicates.add(key);
    found.push({ path: path || "value", language, text });
  };
  function visit(item, path, depth) {
    if (found.length >= maxEntries || depth > maxDepth || ++visited > 5000) return;
    if (typeof item === "string") {
      if (item.length > MAX_HIGHLIGHT_CHARACTERS) return;
      const trimmed = item.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { JSON.parse(trimmed); add(path, "json", item); return; } catch { /* Keep ordinary text untouched. */ }
      }
      for (const match of item.matchAll(/(?:^|\n)(`{3,}|~{3,})[ \t]*([^\s\n]*)[^\n]*\n([\s\S]*?)(?:\n\1[ \t]*(?=\n|$))/g))
        add(path, detectLanguage(match[2]), match[3]);
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item))
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
    else for (const [key, entry] of Object.entries(item))
      visit(entry, path ? `${path}.${key}` : key, depth + 1);
  }
  visit(value, "", 0);
  return found;
}
