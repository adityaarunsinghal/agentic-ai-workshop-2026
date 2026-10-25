// LEARNING: Turn recorded typography choices into styled sentences without changing the original copy.
// Start: styledSentences(), then sentenceCss().
// Next: layout-operations.mjs for the separate human approval flow for geometry.

// ============================================================================
// MAIN BEHAVIOR - read this section first
// ============================================================================

/** Old style decisions never apply to a newer version of a story's copy. */
export function styledSentences(story) {
  const body = String(story.body ?? "");
  const current =
    story.typography?.contentVersion === story.contentVersion &&
    sentenceOffsetsMatch(body, story.typography?.sentences);
  const styles = current ? (story.typography.styles ?? {}) : {};
  const output = [];
  let end = 0;
  const whitespace = (to) => {
    if (to > end) {
      output.push({
        id: `whitespace_${end}`,
        start: end,
        end: to,
        text: body.slice(end, to),
        style: null,
      });
    }
  };
  for (const sentence of storySentences(story)) {
    whitespace(sentence.start);
    output.push({
      ...sentence,
      style: Object.hasOwn(SENTENCE_STYLES, styles[sentence.id])
        ? SENTENCE_STYLES[styles[sentence.id]]
        : SENTENCE_STYLES.medium_regular,
    });
    end = sentence.end;
  }
  whitespace(body.length);
  return output;
}

export function storySentences(story) {
  const body = String(story.body ?? "");
  const recorded =
    story.typography?.contentVersion === story.contentVersion &&
    story.typography?.sentences;
  return sentenceOffsetsMatch(body, recorded)
    ? recorded
        .map(({ id, start, end }) => {
          return { id, text: body.slice(start, end), start, end };
        })
        .filter((part) => {
          return part.text.trim();
        })
    : sentenceSegments(body);
}

export function sentenceCss(style) {
  if (!style) {
    return {};
  }
  return {
    fontSize: { small: "0.8em", medium: "1em", large: "1.45em" }[style.size] ?? "1em",
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    textDecoration: style.underline ? "underline" : "none",
  };
}

// ============================================================================
// SUPPORTING HELPERS - policies, validation, and bookkeeping
// ============================================================================

/** Shared, deterministic text boundaries and the styles editorial models may choose. */
const emphasis = {
  regular: { bold: false, italic: false, underline: false },
  bold: { bold: true, italic: false, underline: false },
  italic: { bold: false, italic: true, underline: false },
  underline: { bold: false, italic: false, underline: true },
  bold_italic: { bold: true, italic: true, underline: false },
  bold_underline: { bold: true, italic: false, underline: true },
  italic_underline: { bold: false, italic: true, underline: true },
  bold_italic_underline: { bold: true, italic: true, underline: true },
};
export const SENTENCE_STYLES = Object.freeze(
  Object.fromEntries(
    ["small", "medium", "large"].flatMap((size) => {
      return Object.entries(emphasis).map(([name, marks]) => {
        return [`${size}_${name}`, Object.freeze({ size, ...marks })];
      });
    }),
  ),
);
export const SENTENCE_STYLE_CRITERIA = Object.freeze(
  Object.fromEntries(
    Object.entries(SENTENCE_STYLES).map(([name, style]) => {
      return [
        name,
        `${style.size} text; ${
          [
            style.bold && "bold",
            style.italic && "italic",
            style.underline && "underlined",
          ]
            .filter(Boolean)
            .join(", ") || "regular emphasis"
        }.`,
      ];
    }),
  ),
);
const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;

/** Omit blank questions, retaining the original segmentation IDs and offsets. */
export function sentenceSegments(value) {
  const text = String(value ?? "");
  const segments = segmenter
    ? [...segmenter.segment(text)].map((part) => {
        return part.segment;
      })
    : (text.match(/[^.!?]+(?:[.!?]+(?:\s+|$)|$)|[.!?]+(?:\s+|$)/g) ??
      (text ? [text] : []));
  let offset = 0;
  return segments
    .map((part, index) => {
      const result = {
        id: `s${index}`,
        text: part,
        start: offset,
        end: offset + part.length,
      };
      offset += part.length;
      return result;
    })
    .filter((part) => {
      return part.text.trim();
    });
}

/** Any omitted ranges must be whitespace, never unrecorded substantive copy. */
export function sentenceOffsetsMatch(body, recorded) {
  let end = 0,
    previousId = -1;
  return (
    Array.isArray(recorded) &&
    recorded.every((part) => {
      const index = /^s(\d+)$/u.exec(part?.id ?? "");
      if (
        !index ||
        !Number.isSafeInteger(Number(index[1])) ||
        Number(index[1]) <= previousId ||
        !Number.isSafeInteger(part.start) ||
        !Number.isSafeInteger(part.end) ||
        part.start < end ||
        part.end <= part.start ||
        part.end > body.length ||
        body.slice(end, part.start).trim()
      ) {
        return false;
      }
      previousId = Number(index[1]);
      end = part.end;
      return true;
    }) &&
    !body.slice(end).trim()
  );
}
