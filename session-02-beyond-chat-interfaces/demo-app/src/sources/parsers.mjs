import { canonicalUrl, publicUrl, SourceError } from "./public-http.mjs";

export function boundedText(value, maxChars) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

export function decodeBytes(bytes, contentType = "") {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    throw new SourceError("UNSUPPORTED_ENCODING", "The source declares an unsupported text encoding.");
  }
}

export async function htmlText(html, maxChars = 6000) {
  const { convert } = await import("html-to-text");
  const text = convert(String(html ?? ""), {
    wordwrap: false,
    limits: { maxInputLength: 1024 * 1024 },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
    ],
  });
  return boundedText(text, maxChars);
}

export async function parseNewsFeed(xml) {
  const { default: Parser } = await import("rss-parser");
  const parser = new Parser({ customFields: { item: [["source", "source", { keepArray: true }]] } });
  const feed = await parser.parseString(xml);
  for (const item of feed.items ?? [])
    if (Array.isArray(item.source)) item.source = item.source[0];
  return feed;
}

function outboundLinks(document, url, maximum) {
  const current = canonicalUrl(url), origin = new URL(current).origin;
  const anchors = document.querySelectorAll("a[href]");
  const candidates = [], seen = new Set();
  // The HTML byte limit also applies; this separate cap bounds link inspection.
  for (const anchor of [...anchors].slice(0, 512)) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href || href.startsWith("#")) continue;
    try {
      const target = publicUrl(new URL(href, url).href).href;
      const canonical = canonicalUrl(target);
      if (canonical === current || seen.has(canonical)) continue;
      seen.add(canonical);
      candidates.push({
        url: target,
        title: boundedText((anchor.textContent || anchor.getAttribute("aria-label") || target).replace(/\s+/g, " "), 200).text,
      });
    } catch { /* Unsafe, credentialed and non-web links are not advertised. */ }
  }
  candidates.sort((a, b) => Number(new URL(b.url).origin === origin) - Number(new URL(a.url).origin === origin));
  return {
    links: candidates.slice(0, maximum),
    linksTruncated: maximum > 0 && (candidates.length > maximum || anchors.length > 512),
  };
}

const comparableText = (text) => String(text ?? "").normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function metadataReason(document, text, titles) {
  const normalized = comparableText(text);
  if (document.querySelector("#challenge-form, #challenge-running, #cf-challenge-running") ||
      /^(just a moment|access denied|verify (?:that )?you are (?:a )?human|attention required cloudflare)$/u
        .test(comparableText(document.title)))
    return "access-challenge";
  if (!normalized) return "metadata-only";
  const names = titles.map(comparableText).filter(Boolean);
  if (names.includes(normalized)) return "title-only";
  const body = document.body?.cloneNode(true);
  // Links remain available separately. A page containing only headings and
  // navigation is discovery metadata even if Readability returned an object.
  for (const node of body?.querySelectorAll(
    "script, style, noscript, nav, header, footer, aside, form, button, a, h1, h2, h3, h4, h5, h6, " +
    "[hidden], [aria-hidden='true'], [role='navigation'], [role='banner'], [role='contentinfo']",
  ) ?? []) {
    if (node.tagName === "HEADER" && node.closest("article, main, [role='main']")) continue;
    node.remove();
  }
  const remainder = comparableText(body?.textContent);
  if (!remainder || names.includes(remainder)) return "navigation-only";
  return null;
}

export async function parseArticle(html, url, maxChars, maxLinks = 12) {
  const [{ JSDOM, VirtualConsole }, { Readability }] = await Promise.all([
    import("jsdom"), import("@mozilla/readability"),
  ]);
  // No scripts, subresource loader, or forwarded virtual console.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const links = outboundLinks(document, url, Math.max(0, Math.min(24, maxLinks)));
    const declaredCanonical = document.querySelector('link[rel~="canonical"]')?.getAttribute("href");
    let canonical = canonicalUrl(url);
    if (declaredCanonical) {
      try {
        const candidate = publicUrl(new URL(declaredCanonical, url).href);
        if (candidate.origin === new URL(url).origin) canonical = canonicalUrl(candidate.href);
      } catch { /* An untrusted canonical declaration cannot change source identity. */ }
    }
    const fallbackTitle = boundedText(document.title, 600).text;
    const article = new Readability(document.cloneNode(true), { charThreshold: 100 }).parse();
    // Classify before the caller's excerpt limit: a short requested excerpt
    // must not make a real article look like a title-only page.
    const fullExcerpt = await htmlText(article?.content ?? document.body?.innerHTML ?? "", 1024 * 1024);
    const excerpt = boundedText(fullExcerpt.text, maxChars);
    excerpt.truncated ||= fullExcerpt.truncated;
    const extractionReason = metadataReason(document, fullExcerpt.text, [
      article?.title, fallbackTitle, document.querySelector("h1")?.textContent,
    ]);
    const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute("content");
    return {
      ...(!fullExcerpt.text ? boundedText(description, maxChars) : excerpt),
      ...links, canonicalUrl: canonical,
      title: boundedText(article?.title || fallbackTitle || new URL(url).hostname, 600).text,
      author: boundedText(article?.byline, 200).text || null,
      publishedAt: article?.publishedTime && Number.isFinite(Date.parse(article.publishedTime))
        ? new Date(article.publishedTime).toISOString() : null,
      evidenceLevel: extractionReason ? "metadata" : article ? "article-text" : "page-excerpt",
      readableArticle: !extractionReason && Boolean(article),
      ...(extractionReason ? { extractionReason } : {}),
    };
  } finally {
    dom.window.close();
  }
}
