import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { styledSentences, sentenceCss } from "./presentation.mjs";
import { observedStoryLinks, sentenceDisplayParts } from "../ui/src/editor/story-text.mjs";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const styledCopy = (story, sources) => {
  const links = observedStoryLinks(story, sources);
  return styledSentences(story).map((sentence) => {
    const css = Object.entries(sentenceCss(sentence.style)).map(([name, value]) =>
      `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`).join(";");
    const text = sentenceDisplayParts(sentence, links).map((part) => part.href
      ? `<a href="${escape(part.href)}" rel="noopener noreferrer">${escape(part.text)}</a>`
      : escape(part.text)).join("");
    return `<span style="${css}">${text}</span>`;
  }).join("");
};

export function createExporter({ store, trace, directory = ".local/exports" }) {
  const artifacts = new Map(), cache = new Map();
  async function exportIssue({ format = "html" } = {}) {
    if (format !== "html") throw new Error("Newspaper downloads support HTML only.");
    const snapshot = store.snapshot();
    const issue = snapshot.issue;
    const ready = issue.stories.filter((story) => story.body || story.headline);
    if (!ready.length) throw new Error("Add or write a story before downloading.");
    if (ready.some((story) => story.status === "overflow"))
      throw new Error("Shorten or resize overflowing stories before downloading.");
    const digest = createHash("sha256").update(JSON.stringify({ issue, format })).digest("hex");
    if (cache.has(digest)) return cache.get(digest);
    const span = trace.start("export", {
      actor: "app", purpose: "Download final newspaper",
      payload: { format, issueId: issue.id, revision: issue.revision },
    });
    const sourceIds = [...new Set(ready.flatMap((story) => story.sourceIds))];
    const sources = sourceIds.map((id) => issue.sources.find((source) => source.id === id)).filter(Boolean);
    const sourceNumber = (ids) => ids.map((id) => sourceIds.indexOf(id) + 1).filter((id) => id > 0).join(", ");
    try {
      const articles = ready.map((story) => `<article data-lead="${story.id === issue.leadSuggestion || story.slotId === issue.leadSuggestion}" style="left:${story.frame.x}mm;top:${story.frame.y}mm;width:${story.frame.width}mm;height:${story.frame.height}mm"><h2>${escape(story.headline)}</h2><div class="copy">${styledCopy(story, issue.sources)}</div><small>Sources: ${sourceNumber(story.sourceIds)}</small></article>`).join("");
      const bytes = Buffer.from(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(issue.title)}</title><style>*{box-sizing:border-box}body{background:#eee;margin:0;font-family:Georgia,serif}.paper{position:relative;width:297mm;height:420mm;background:#fff;margin:auto;overflow:hidden}header{position:absolute;left:12mm;top:10mm;width:273mm;border-bottom:2px solid black;text-align:center}h1{margin:0;font-size:30pt}header p{font:9pt Arial,sans-serif;margin:3mm}article{position:absolute;border-top:1px solid #555;padding:2mm}h2{font-size:14pt;margin:1mm 0 3mm}.copy{font-size:10pt;line-height:1.35;white-space:pre-wrap}small{font:7pt Arial,sans-serif}footer{position:absolute;bottom:4mm;left:12mm;width:273mm;font:6.5pt Arial,sans-serif;overflow-wrap:anywhere}.paper[data-template="newspaper"] article[data-lead="true"] h2{font-size:18pt}.paper[data-template="breaking_news"] article[data-lead="true"]{border-top:1mm double #222}.paper[data-template="breaking_news"] article[data-lead="true"] h2{font-size:22pt;line-height:1.15}.paper[data-template="breaking_news"] article:not([data-lead="true"]) h2{font-size:13pt}.paper[data-template="side_by_side"] article{border-top:.75mm double #222}@page{size:A3 portrait;margin:0}@media print{body{background:white}.paper{margin:0}}</style><main class="paper" data-template="${escape(issue.layoutTemplate || "custom")}"><header><h1>${escape(issue.title)}</h1><p>${escape(issue.date)} · ${escape(issue.focus)}</p></header>${articles}<footer>${sources.map((source, index) => `[${index + 1}] ${escape(source.title)} — ${escape(source.url || source.canonicalUrl)}`).join("<br>")}</footer></main></html>`);
      const id = randomUUID(), filename = `newspaper-${issue.date}-r${issue.revision}.${format}`;
      await mkdir(directory, { recursive: true });
      const path = resolve(directory, `${id}.${format}`);
      await writeFile(path, bytes, { mode: 0o600 });
      await writeFile(`${path}.audit.json`, JSON.stringify({
        issue, modelSettings: snapshot.settings, sourceIds,
        assessments: ready.map((story) => ({ storyId: story.id, ...story.factCheck })),
      }, null, 2), { mode: 0o600 });
      const artifact = {
        id, filename, url: `/api/artifacts/${id}`, format,
        mimeType: "text/html",
        bytes: bytes.length, revision: issue.revision,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      artifacts.set(id, { ...artifact, path }); cache.set(digest, artifact);
      span.finish({ result: artifact });
      return artifact;
    } catch (error) {
      span.finish({ status: "failed", error: error.message }); throw error;
    }
  }
  return { exportIssue, getArtifact: (id) => artifacts.get(id) };
}
