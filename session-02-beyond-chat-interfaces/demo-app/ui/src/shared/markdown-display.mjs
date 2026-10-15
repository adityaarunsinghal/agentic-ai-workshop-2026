import MarkdownIt from "markdown-it";
import { detectLanguage, highlightCode } from "./code-format.mjs";
import { codeLanguageLabel } from "./code-display.mjs";
import { safeHttpUrl } from "./state.mjs";

const markdown = new MarkdownIt({
  html: false, linkify: true, typographer: false, breaks: false,
});

// Markdown has no script/HTML capability, and images remain text. Only explicit
// HTTP links are navigable; the React view delegates them to the host openLink.
markdown.validateLink = (href) => Boolean(safeHttpUrl(href));
markdown.renderer.rules.image = (tokens, index) =>
  `<span class="markdown-image-alt">[Image: ${markdown.utils.escapeHtml(tokens[index].content || "image")}]</span>`;
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

function codeBlock(text, hint = "") {
  const language = detectLanguage(hint);
  const display = highlightCode(text, language, { formatJson: language === "json" });
  const label = markdown.utils.escapeHtml(codeLanguageLabel(language));
  return `<div class="code-view markdown-code"><div class="code-toolbar"><span>${label}${display.formatted ? " · formatted" : ""}</span>` +
    `<div class="code-actions"><button type="button" class="text-button" data-code-select>Select code</button>` +
    `<button type="button" class="quiet" data-code-copy>Copy</button></div></div>` +
    `<pre tabindex="0" aria-label="${label} code"><code class="hljs language-${language}">${display.html}</code></pre></div>\n`;
}

markdown.renderer.rules.fence = (tokens, index) =>
  codeBlock(tokens[index].content, tokens[index].info.trim().split(/\s+/)[0]);
markdown.renderer.rules.code_block = (tokens, index) => codeBlock(tokens[index].content);

export function renderMarkdown(text) {
  return markdown.render(String(text ?? ""));
}
