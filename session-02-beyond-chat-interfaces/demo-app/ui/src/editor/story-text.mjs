import { safeHttpUrl } from "../shared/state.mjs";

const resourceKey = (url) => { const key = new URL(url.href); key.hash = ""; return key.href; };

export function observedStoryLinks(story, sources) {
  const observed = new Map();
  for (const source of sources) {
    if (!story.sourceIds?.includes(source.id)) continue;
    for (const raw of [source.url, source.canonicalUrl, source.discussionUrl, source.hnUrl]) {
      const url = safeHttpUrl(raw);
      if (url) observed.set(resourceKey(url), source);
    }
  }
  const body = String(story.body ?? "");
  const links = [];
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"\]]+/g;
  for (const match of body.matchAll(pattern)) {
    let raw = match[2] ?? match[0];
    let url = safeHttpUrl(raw);
    let source = url && observed.get(resourceKey(url));
    if (!match[2]) {
      while (!source && /[.,;:!?)]$/.test(raw)) {
        raw = raw.slice(0, -1);
        url = safeHttpUrl(raw);
        source = url && observed.get(resourceKey(url));
      }
    }
    if (!url || !source) continue;
    const publisher = [source.publisher, source.siteName].find((value) => typeof value === "string" && value.trim());
    const label = match[1] && match[1].length <= 120 && !/^https?:\/\//.test(match[1])
      ? match[1] : publisher || url.hostname;
    links.push({
      start: match.index, end: match.index + (match[2] ? match[0].length : raw.length),
      href: url.href, label,
    });
  }
  return links;
}

// Offsets always refer to the unchanged body. A link spanning sentence
// boundaries is rendered once, with the first sentence's approved style.
export function sentenceDisplayParts(sentence, links) {
  const parts = [];
  let cursor = sentence.start;
  for (const link of links) {
    if (link.end <= sentence.start || link.start >= sentence.end) continue;
    if (link.start > cursor) parts.push({ text: sentence.text.slice(cursor - sentence.start, link.start - sentence.start) });
    if (link.start >= sentence.start) parts.push({ href: link.href, text: link.label, start: link.start });
    cursor = Math.max(cursor, Math.min(sentence.end, link.end));
  }
  if (cursor < sentence.end) parts.push({ text: sentence.text.slice(cursor - sentence.start) });
  return parts;
}
