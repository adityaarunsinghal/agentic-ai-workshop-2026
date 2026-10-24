// LEARNING: Apply a writing role's revision as a list of anchored edits, not a whole
// rewritten body. DeepSeek V4.1 Flash front-loads server-retained reasoning in
// proportion to how much it writes, so asking a reviser for the full revised body made
// it reason past the 78 s per-call deadline (see fact-check.mjs CALL_DEADLINE_MS and the
// live-run result.json files, where single's revise call and graph's reviser call both
// aborted on the wall). A reviser instead returns a few {find, replace} edits that touch
// only the flagged sentences; code applies them to the current body here. The model
// writes a fragment, not a page, so its reasoning stays small and the call settles.
//
// This is a deterministic, auditable transform: each edit either matches the current
// body exactly once and is applied, or it does not match and is rejected and recorded.
// The caller turns the applied result into the same candidate shape parseCandidate
// validates, so a kept revision still clears the identical Keep gate.

// Apply the edits to the current headline+body. Returns the new text plus a per-edit
// ledger (applied vs rejected with a reason) so Execution can show exactly what each
// arrangement changed and what it tried that did not match. An edit's `find` must name a
// span that occurs exactly once in the current field; zero occurrences or more than one
// is a rejection, because a reviser that cannot point at a unique span has not made a
// safe, reviewable change.
//
// A reviser quotes the flagged sentence back from its own context, so its `find` is
// usually verbatim but sometimes differs from the stored copy only in cosmetic ways the
// model does not preserve: collapsed or widened runs of whitespace, and straight vs.
// curly quotes and apostrophes. We first try an exact match; if that misses, we locate
// the span by comparing both sides under the same whitespace-and-quote normalization and,
// when exactly one normalized match exists, splice the replacement into the real span of
// the current copy. The applied/rejected ledger is unchanged, so Execution still shows a
// single uniquely-anchored change and the rest of the copy stays byte-for-byte.
export function applyRevisionEdits({ headline, body, edits }) {
  const list = Array.isArray(edits) ? edits : [];
  const applied = [];
  const rejected = [];
  let nextHeadline = String(headline ?? "");
  let nextBody = String(body ?? "");

  for (const edit of list) {
    const field = edit.field === "headline" ? "headline" : "body";
    const find = typeof edit.find === "string" ? edit.find : "";
    const replace = typeof edit.replace === "string" ? edit.replace : "";
    const current = field === "headline" ? nextHeadline : nextBody;

    if (!find) {
      rejected.push({ ...normalizeEdit(edit), reason: "An edit must name the exact text to find." });
      continue;
    }
    const match = locateUnique(current, find);
    if (match.count === 0) {
      rejected.push({ ...normalizeEdit(edit), reason: "The text to find does not appear in the current copy." });
      continue;
    }
    if (match.count > 1) {
      rejected.push({
        ...normalizeEdit(edit),
        reason: "The text to find appears more than once; an edit must name a unique span.",
      });
      continue;
    }
    const updated = current.slice(0, match.start) + replace + current.slice(match.end);
    if (field === "headline") {
      nextHeadline = updated;
    } else {
      nextBody = updated;
    }
    applied.push(normalizeEdit(edit));
  }

  return { headline: nextHeadline, body: nextBody, applied, rejected };
}

function normalizeEdit(edit) {
  return {
    field: edit?.field === "headline" ? "headline" : "body",
    find: typeof edit?.find === "string" ? edit.find : "",
    replace: typeof edit?.replace === "string" ? edit.replace : "",
    reason: typeof edit?.reason === "string" ? edit.reason : "",
  };
}

// Locate the single span the edit targets. We first try an exact substring match; when
// that misses, we compare both sides under the same whitespace-and-quote normalization a
// reviser routinely varies (collapsed or widened whitespace, straight vs. curly quotes
// and apostrophes) and map a unique normalized match back to its exact span in the
// original text. Returns {count, start, end}: count is how many spans matched (0, 1 or
// >1), and start/end bound the real span to splice when count === 1. A normalized match
// is used only when the exact search found nothing, so a verbatim find is never widened.
function locateUnique(haystack, needle) {
  if (!needle) {
    return { count: 0, start: -1, end: -1 };
  }
  const exact = spanOf(haystack, needle, (value) => value);
  if (exact.count > 0) {
    return exact;
  }
  return spanOf(haystack, needle, canonicalize);
}

// Count the spans of `needle` inside `haystack` under a comparison map, and when exactly
// one span matches, return its boundaries in the ORIGINAL haystack. The map is applied
// per character so an index in the mapped string maps back to a character boundary in the
// original; a map that changes a character's length would break that correspondence, so
// canonicalize only substitutes single characters and never collapses or drops them. A
// whitespace run is normalized by matching any run, not by deleting characters, so the
// index alignment holds.
function spanOf(haystack, needle, mapChar) {
  const canonNeedle = [...needle].map(mapChar).join("");
  if (!canonNeedle) {
    return { count: 0, start: -1, end: -1 };
  }
  // Build the canonical haystack and a per-character index back to the original string.
  const canonChars = [];
  const originalIndex = [];
  let i = 0;
  for (const ch of haystack) {
    canonChars.push(mapChar(ch));
    originalIndex.push(i);
    i += ch.length;
  }
  originalIndex.push(haystack.length);
  const canonHay = canonChars.join("");
  // Whitespace-insensitive scan: a run of whitespace in the needle matches a run of
  // whitespace in the haystack of any length, so a reviser that collapsed "  " to " "
  // (or vice versa) still anchors. Everything else matches character for character.
  const pattern = canonNeedle
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  const regex = new RegExp(pattern, "gu");
  let count = 0;
  let start = -1;
  let end = -1;
  for (const match of canonHay.matchAll(regex)) {
    count++;
    if (count === 1) {
      start = originalIndex[match.index];
      end = originalIndex[match.index + match[0].length];
    }
    if (count > 1) {
      break;
    }
  }
  return { count, start, end };
}

// Fold the cosmetic variations a reviser introduces when quoting a sentence back: unify
// curly quotes and apostrophes with their straight forms. One character in, one out, so
// index alignment with the original string is preserved (see spanOf).
function canonicalize(ch) {
  if (ch === "\u2018" || ch === "\u2019" || ch === "\u201b" || ch === "\u2032") {
    return "'";
  }
  if (ch === "\u201c" || ch === "\u201d" || ch === "\u201f" || ch === "\u2033") {
    return '"';
  }
  return ch;
}
