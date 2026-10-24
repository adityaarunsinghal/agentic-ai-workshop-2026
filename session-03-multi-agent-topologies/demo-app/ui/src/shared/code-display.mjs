import { detectLanguage, embeddedCode } from "./code-format.mjs";
import { sanitizeForInspection } from "./state.mjs";

export function codeLanguageLabel(language) {
  const selected = detectLanguage(language);
  return ({
    plaintext: "Text", json: "JSON", javascript: "JavaScript", typescript: "TypeScript",
    python: "Python", xml: "HTML / XML", css: "CSS", bash: "Shell", yaml: "YAML",
    sql: "SQL", markdown: "Markdown", diff: "Diff", go: "Go", rust: "Rust", java: "Java", cpp: "C / C++",
  })[selected] ?? selected;
}

export const JSON_TREE_LIMITS = Object.freeze({
  depth: 24, decodedLayers: 5, nodes: 20000, attempts: 256, characters: 2 * 1024 * 1024,
});

// Preserve the sanitized original separately. Only the derived display tree
// decodes complete object/array strings; metadata never becomes a JSON field.
export function inspectionDisplay(value) {
  const clean = sanitizeForInspection(value);
  const parsedValues = new WeakSet();
  let nodes = 0, attempts = 0, characters = 0;
  function display(item, depth = 0, decodedLayers = 0) {
    if (depth > JSON_TREE_LIMITS.depth || ++nodes > JSON_TREE_LIMITS.nodes) return item;
    if (typeof item === "string") {
      if (decodedLayers >= JSON_TREE_LIMITS.decodedLayers || attempts >= JSON_TREE_LIMITS.attempts ||
          characters + item.length > JSON_TREE_LIMITS.characters) return item;
      const text = item.trim();
      if (!((text.startsWith("{") && text.endsWith("}")) ||
          (text.startsWith("[") && text.endsWith("]")))) return item;
      attempts++;
      characters += item.length;
      try {
        const parsed = JSON.parse(text);
        let remaining = JSON_TREE_LIMITS.nodes - nodes;
        const bounded = (entry, level) => {
          if (--remaining < 0 || level > JSON_TREE_LIMITS.depth) return false;
          return entry === null || typeof entry !== "object" ||
            Object.values(entry).every((child) => bounded(child, level + 1));
        };
        if (!bounded(parsed, depth + 1)) return item;
        // A decoded object has the same redaction rules as ordinary objects,
        // including secrets which were previously inside an encoded string.
        const tree = display(sanitizeForInspection(parsed), depth + 1, decodedLayers + 1);
        parsedValues.add(tree);
        return tree;
      } catch { return item; } // No repairs, partial parsing or code evaluation.
    }
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map((entry) => display(entry, depth + 1, decodedLayers));
    // Assignment into {} would treat "__proto__" specially. It is data here.
    return Object.fromEntries(Object.entries(item)
      .map(([key, entry]) => [key, display(entry, depth + 1, decodedLayers)]));
  }
  const shown = display(clean);
  const tree = typeof shown === "object" && shown !== null ? shown : { value: shown };
  return { clean, tree, parsedValues };
}

export function inspectionCodeFields(clean) {
  return embeddedCode(clean, { maxEntries: 12, maxDepth: 10 });
}

export function selectCode(element) {
  if (!element) return false;
  const document = element.ownerDocument;
  const selection = document.getSelection();
  if (!selection) return false;
  element.closest("pre")?.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export async function copyCode(text, element) {
  const clipboard = element?.ownerDocument.defaultView?.navigator.clipboard;
  if (clipboard?.writeText) {
    try { await clipboard.writeText(text); return "Copied"; }
    catch { /* A sandbox can deny clipboard permission; native selection remains available. */ }
  }
  selectCode(element);
  return "Code selected. Press Ctrl/Cmd+C to copy.";
}
