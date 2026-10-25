import { isDeepStrictEqual } from "node:util";

export class ModelJsonError extends Error {
  constructor(reason) {
    super("The model response needs JSON format recovery.");
    this.name = "ModelJsonError";
    this.code = "JSON_RESPONSE";
    this.reason = reason;
  }
}

/** Only lexical string controls are repaired; missing syntax is never invented. */
function parseObject(text) {
  let value, repaired = text, controls = false;
  try { value = JSON.parse(text); }
  catch {
    let quoted = false, escaped = false;
    repaired = "";
    for (const character of text) {
      if (quoted && !escaped && character.charCodeAt(0) < 32) {
        repaired += JSON.stringify(character).slice(1, -1);
        controls = true;
        continue;
      }
      repaired += character;
      if (escaped) escaped = false;
      else if (quoted && character === "\\") escaped = true;
      else if (character === "\"") quoted = !quoted;
    }
    try { value = JSON.parse(repaired); }
    catch { throw new ModelJsonError("malformed_json"); }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ModelJsonError("not_object");
  return { value, controls };
}

function objectEnd(text, start) {
  const stack = [];
  let quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const open = stack.pop();
      if ((character === "}" && open !== "{") || (character === "]" && open !== "["))
        throw new ModelJsonError("malformed_json");
      if (!stack.length) return index + 1;
    }
  }
  return null;
}

// This accepts formatting chatter, not substantive qualifications of an answer.
const formatWords = new Set(["actually", "final", "only", "return", "raw", "json", "object", "no", "extra", "anything", "single"]);
function formattingSeparator(text) {
  if (!text.trim()) return true;
  return text.trim().length <= 256 && /^[\sA-Za-z()!:.\-`]+$/u.test(text) &&
    (text.toLowerCase().match(/[a-z]+/gu) ?? []).every((word) => formatWords.has(word));
}

/**
 * Display and wire captures stay untouched. A recovered object must still pass
 * its caller's task schema and evidence checks before any effect is applied.
 */
export function parseModelJsonObject(raw) {
  if (typeof raw !== "string") throw new ModelJsonError("not_text");
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new ModelJsonError("response_too_large");
  let text = raw.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/iu.exec(text);
  if (fenced) text = fenced[1].trim();
  try {
    const parsed = parseObject(text);
    return {
      value: parsed.value,
      recovery: fenced || parsed.controls ? {
        kind: "json_format", markdownFence: Boolean(fenced), stringControlsEscaped: parsed.controls,
      } : null,
    };
  } catch (error) {
    if (error.reason === "not_object") throw error;
  }
  if (!text.startsWith("{")) throw new ModelJsonError("malformed_json");
  let offset = 0, first, firstText, copies = 0, controls = false, partial = false;
  while (offset < text.length) {
    const start = text.indexOf("{", offset);
    if (start < 0) {
      if (!formattingSeparator(text.slice(offset))) throw new ModelJsonError("non_json_suffix");
      break;
    }
    if (!formattingSeparator(text.slice(offset, start))) throw new ModelJsonError("non_json_suffix");
    const end = objectEnd(text, start);
    if (end === null) {
      // Multiple complete copies establish repetition; an arbitrary partial
      // second answer remains ambiguous and requires a model format repair.
      if (copies < 2 || !firstText.startsWith(text.slice(start)))
        throw new ModelJsonError("incomplete_json");
      partial = true;
      break;
    }
    const candidateText = text.slice(start, end);
    const candidate = parseObject(candidateText);
    if (copies && !isDeepStrictEqual(first, candidate.value))
      throw new ModelJsonError("conflicting_objects");
    if (!copies) { first = candidate.value; firstText = candidateText; }
    controls ||= candidate.controls;
    copies++;
    offset = end;
  }
  if (!copies) throw new ModelJsonError("malformed_json");
  return {
    value: first,
    recovery: {
      kind: copies > 1 ? "identical_json_repetitions" : "json_format",
      completeCopies: copies, discardedPartialCopy: partial,
      markdownFence: Boolean(fenced), stringControlsEscaped: controls,
    },
  };
}
