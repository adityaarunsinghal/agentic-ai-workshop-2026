import React, { useEffect, useId, useRef } from "react";
import { Annotation, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { formatJsonArguments, jsonArgumentsState } from "./json-arguments.mjs";
import "../../code.css";

const externalText = Annotation.define();

export function JsonArguments({ value, onChange }) {
  const container = useRef(null);
  const editor = useRef(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const labelId = useId();
  useEffect(() => {
    const view = new EditorView({
      parent: container.current,
      state: jsonArgumentsState(latest.current.value, [
        EditorView.contentAttributes.of({
          role: "textbox", "aria-multiline": "true", "aria-labelledby": labelId,
          spellcheck: "false", autocorrect: "off", autocapitalize: "off",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.every((transaction) => transaction.annotation(externalText))) {
            latest.current.onChange(update.state.sliceDoc());
          }
        }),
      ]),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [labelId]);
  useEffect(() => {
    const view = editor.current;
    // Typing/IME updates already live in CodeMirror. Do not recreate the view
    // or reset its selection when React acknowledges the same text.
    if (view && view.state.sliceDoc() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [externalText.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [value]);
  return (
    <div className="json-arguments">
      <div className="json-arguments-heading">
        <label id={labelId} onClick={() => editor.current?.focus()}>Arguments</label>
        <button type="button" className="quiet" onClick={() => {
          const view = editor.current;
          if (view) { formatJsonArguments(view); view.focus(); }
        }}>Format JSON</button>
      </div>
      <div ref={container} className="json-arguments-editor" />
    </div>
  );
}
