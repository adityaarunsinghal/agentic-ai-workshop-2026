import React, { useMemo, useRef, useState } from "react";
import { highlightCode } from "./code-format.mjs";
import { codeLanguageLabel, copyCode, selectCode } from "./code-display.mjs";
import "../../code.css";

export function CodeView({ text = "", language = "plaintext", label = "Code" }) {
  const node = useRef(null);
  const [wrap, setWrap] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const display = useMemo(() => highlightCode(text, language), [text, language]);
  return (
    <div className="code-view" data-wrap={wrap}>
      <div className="code-toolbar">
        <span>{codeLanguageLabel(display.language)}</span>
        <div className="code-actions">
          <button type="button" className="text-button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap lines</button>
          <button type="button" className="text-button" onClick={() => { selectCode(node.current); setCopyStatus(""); }}>Select code</button>
          <button type="button" className="quiet" onClick={async () => setCopyStatus(await copyCode(display.text, node.current))}>Copy</button>
        </div>
      </div>
      <pre tabIndex={0} aria-label={label}><code ref={node} className={`hljs language-${display.language}`}
        dangerouslySetInnerHTML={{ __html: display.html }} /></pre>
      {copyStatus && <p className="code-copy-status" role="status">{copyStatus}</p>}
    </div>
  );
}
