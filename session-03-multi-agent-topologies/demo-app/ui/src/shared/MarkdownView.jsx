import React, { useMemo, useState } from "react";
import { renderMarkdown } from "./markdown-display.mjs";
import { copyCode, selectCode } from "./code-display.mjs";
import { safeHttpUrl } from "./state.mjs";
import { CodeView } from "./CodeView.jsx";

export function MarkdownView({ text = "", onOpenLink, className = "", showSource = true }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  function followLink(event) {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const url = safeHttpUrl(anchor.getAttribute("href"));
    if (!url) { event.preventDefault(); return; }
    if (onOpenLink) {
      event.preventDefault();
      void Promise.resolve(onOpenLink(url.href)).catch(() => {});
    }
  }
  async function click(event) {
    const button = event.target.closest?.("button[data-code-copy], button[data-code-select]");
    if (!button || !event.currentTarget.contains(button)) { followLink(event); return; }
    event.preventDefault();
    const code = button.closest(".markdown-code")?.querySelector("pre code");
    if (!code) return;
    if (button.hasAttribute("data-code-copy")) setCopyStatus(await copyCode(code.textContent, code));
    else { selectCode(code); setCopyStatus(""); }
  }
  return (
    <div className={`markdown-view ${className}`}>
      <div className="markdown-body" onClick={click} onAuxClick={(event) => {
        if (event.button === 1) followLink(event);
      }} dangerouslySetInnerHTML={{ __html: html }} />
      {copyStatus && <p className="code-copy-status" role="status">{copyStatus}</p>}
      {showSource && <details className="markdown-source" onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
        <summary>Markdown source</summary>
        {sourceOpen && <CodeView text={text} language="markdown" label="Original Markdown source" />}
      </details>}
    </div>
  );
}
