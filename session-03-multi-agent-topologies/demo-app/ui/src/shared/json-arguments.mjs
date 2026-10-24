import { countColumn, EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { deleteCharBackwardStrict, history, historyKeymap, insertNewline, isolateHistory, standardKeymap } from "@codemirror/commands";
import { tags } from "@lezer/highlight";
import { prettyJson } from "./code-format.mjs";

const colors = HighlightStyle.define([
  { tag: tags.propertyName, class: "code-property" },
  { tag: tags.string, class: "code-string" },
  { tag: tags.number, class: "code-number" },
  { tag: [tags.bool, tags.null], class: "code-literal" },
  { tag: [tags.separator, tags.bracket], class: "code-punctuation" },
]);

function lineIndents(state) {
  const decorations = [];
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    const whitespace = line.text.match(/^[ \t]*/)[0];
    const indent = countColumn(whitespace, state.tabSize) + 2;
    // A whole tab-stop offset preserves the first line's rendered tab widths.
    const columns = whitespace.includes("\t")
      ? Math.ceil(indent / state.tabSize) * state.tabSize : indent;
    decorations.push(Decoration.line({
      attributes: { style: `--json-continuation-indent: ${columns}ch` },
    }).range(line.from));
  }
  return Decoration.set(decorations);
}

// Hanging indents only affect layout; the document and selections stay exact.
const wrappedIndents = StateField.define({
  create: lineIndents,
  update: (decorations, transaction) => transaction.docChanged ||
    transaction.startState.tabSize !== transaction.state.tabSize
    ? lineIndents(transaction.state) : decorations,
  provide: (field) => EditorView.decorations.from(field),
});

export function jsonArgumentsState(text, extensions = []) {
  return EditorState.create({
    doc: text,
    extensions: [
      // Keep CR/LF sequences, whitespace and incomplete input exactly as entered.
      EditorState.lineSeparator.of("\n"),
      json(), syntaxHighlighting(colors), history(),
      EditorView.lineWrapping, wrappedIndents,
      keymap.of([
        { key: "Enter", run: insertNewline, shift: insertNewline },
        { key: "Backspace", run: deleteCharBackwardStrict },
        ...historyKeymap,
        ...standardKeymap.filter((binding) => !["Enter", "Backspace"].includes(binding.key)),
      ]),
      ...extensions,
    ],
  });
}

export function formatJsonArguments(target) {
  if (target.composing || target.compositionStarted) return false;
  const original = target.state.sliceDoc();
  const formatted = prettyJson(original);
  if (formatted === original) return false;
  target.dispatch(target.state.update({
    changes: { from: 0, to: target.state.doc.length, insert: formatted },
    userEvent: "input.format", annotations: isolateHistory.of("full"),
  }));
  return true;
}
