import { createHash } from "node:crypto";
import { boundedText, decodeBytes, htmlText, parseNewsFeed } from "./parsers.mjs";
import { canonicalUrl, publicUrl, SourceError } from "./public-http.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const searchStopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "is", "it", "of", "on", "or", "the", "this", "to", "was", "what", "when",
  "where", "who", "with", "www", "http", "https", "com", "org", "net",
]);
const terms = (value) => new Set((String(value ?? "").normalize("NFKD").toLowerCase()
  .replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter((term) => term.length > 1 && !searchStopWords.has(term))
  // Singular/plural spelling is a lexical variation, not a relevance score.
  .map((term) => term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term));

function zeroQueryOverlap(record, queryTerms) {
  if (!queryTerms.size || record.truncated) return false;
  const url = new URL(record.url);
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Keep the observed path. */ }
  // Search parameters may echo the query even on an unrelated result.
  const observed = terms(`${record.title} ${record.text} ${url.hostname} ${path}`);
  return ![...queryTerms].some((term) => observed.has(term));
}

function searchRecord({ title, url, snippet, provider, query }) {
  const checked = publicUrl(url).href;
  const canonical = canonicalUrl(checked);
  const text = boundedText(snippet, 1600);
  return {
    id: `search-${hash(canonical).slice(0, 24)}`, kind: "web-search",
    title: boundedText(title, 600).text || new URL(checked).hostname,
    url: checked, canonicalUrl: canonical, ...text,
    evidenceLevel: "search-snippet", provider, query,
    retrievedAt: new Date().toISOString(), publishedAt: null, origin: "live",
    contentDigest: hash(JSON.stringify({ title, url: checked, snippet, provider, query })),
    completeness: { completeForRequestedScope: !text.truncated, publisherArticleRead: false },
  };
}

/** Only result links are decoded. No page script or linked resource is loaded. */
export async function parseDuckDuckGoResults(html, searchUrl, { query, limit }) {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const dom = new JSDOM(html, { url: searchUrl, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    if (document.querySelector("#challenge-form, .anomaly-modal, #anomaly-modal"))
      throw new SourceError("SEARCH_PROVIDER_BLOCKED", "The public search provider requested a browser challenge.");
    const results = [...document.querySelectorAll(".result")].slice(0, 40);
    if (!results.length && !document.querySelector(".no-results, .no-results__message"))
      throw new SourceError("SEARCH_FORMAT_UNAVAILABLE", "The public search page did not contain recognizable results.");
    const records = [], losses = [], seen = new Set();
    for (const result of results) {
      const anchor = result.querySelector(".result__a");
      if (!anchor) continue;
      try {
        let target = new URL(anchor.getAttribute("href"), searchUrl);
        if (["duckduckgo.com", "html.duckduckgo.com"].includes(target.hostname) && target.pathname === "/l/")
          target = new URL(target.searchParams.get("uddg"));
        const record = searchRecord({
          title: anchor.textContent.trim(), url: target.href,
          snippet: result.querySelector(".result__snippet")?.textContent.trim() ?? "",
          provider: "duckduckgo-html", query,
        });
        if (!seen.has(record.canonicalUrl)) {
          seen.add(record.canonicalUrl);
          records.push(record);
        }
      } catch {
        losses.push({ code: "UNSAFE_SEARCH_RESULT", message: "A search result had no usable public URL." });
      }
      if (records.length === limit) break;
    }
    return { records, losses };
  } finally { dom.window.close(); }
}

async function bingResults(xml, { query, limit }) {
  const feed = await parseNewsFeed(xml);
  const records = [], losses = [], seen = new Set();
  const queryTerms = terms(query
    .replace(/\b(?:site|filetype|inurl|intitle|before|after):(?:"[^"]*"|\S+)/giu, " ")
    .replace(/(?:^|\s)-(?:"[^"]*"|\S+)/gu, " "));
  for (const item of (feed.items ?? []).slice(0, 40)) {
    try {
      const snippet = await htmlText(item.content ?? item.contentSnippet ?? "", 1600);
      const record = searchRecord({
        title: item.title, url: item.link,
        snippet: snippet.text,
        provider: "bing-rss", query,
      });
      record.truncated ||= snippet.truncated || boundedText(item.title, 600).truncated;
      record.completeness.completeForRequestedScope = !record.truncated;
      if (!seen.has(record.canonicalUrl)) {
        seen.add(record.canonicalUrl);
        if (record.truncated) losses.push({
          code: "SEARCH_TEXT_LIMIT", provider: record.provider, sourceId: record.id, url: record.url,
          message: "The RSS title or snippet was shortened to its limit. A missing query term in this excerpt cannot establish that the result is unrelated.",
        });
        if (zeroQueryOverlap(record, queryTerms)) {
          losses.push({
            code: "SEARCH_ZERO_QUERY_OVERLAP", provider: record.provider,
            sourceId: record.id, url: record.url, title: record.title,
            queryTerms: [...queryTerms],
            message: "This RSS result shares no query terms with its title, snippet, or URL path and was omitted by a lexical screen. This is not proof that relevant sources do not exist. Try an observed name variant or a direct public source link.",
          });
        } else records.push(record);
      }
    } catch {
      losses.push({ code: "UNSAFE_SEARCH_RESULT", message: "A search result had no usable public URL." });
    }
    if (records.length === limit) break;
  }
  return { records, losses };
}

/** One free public search, with at most one named alternate. Both use guarded HTTP. */
export async function searchPublicWeb(args, http, context) {
  const primary = new URL("https://html.duckduckgo.com/html/");
  primary.searchParams.set("q", args.query);
  const alternate = new URL("https://www.bing.com/search");
  alternate.search = new URLSearchParams({ q: args.query, format: "rss" }).toString();
  const providers = [
    { id: "duckduckgo-html", url: primary.href, parse: (text, url) => parseDuckDuckGoResults(text, url, args) },
    { id: "bing-rss", url: alternate.href, parse: (text) => bingResults(text, args) },
  ];
  const attempts = [], losses = [];
  for (const provider of providers) {
    context.signal?.throwIfAborted();
    try {
      const response = await http.read(provider.url, {
        ...context, kind: "source.web.search", maxBytes: 512 * 1024,
        signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(6000)]),
      });
      const result = await provider.parse(decodeBytes(response.bytes, response.contentType), response.url);
      const filteredCount = result.losses.filter((entry) => entry.code === "SEARCH_ZERO_QUERY_OVERLAP").length;
      attempts.push({
        provider: provider.id, status: result.records.length ? "results" : filteredCount ? "filtered" : "empty",
        count: result.records.length, ...(filteredCount ? { filteredCount } : {}),
      });
      losses.push(...result.losses);
      if (result.records.length)
        return { records: result.records, losses, discovery: { query: args.query, attempts } };
    } catch (error) {
      context.signal?.throwIfAborted();
      const code = error instanceof SourceError ? error.code : "SEARCH_PROVIDER_UNAVAILABLE";
      attempts.push({ provider: provider.id, status: "unavailable", code });
      losses.push({
        code, provider: provider.id,
        message: error instanceof SourceError ? error.message : "The public search provider could not be read within its bounds.",
      });
    }
  }
  if (!losses.length)
    losses.push({ code: "NO_SEARCH_RESULTS", message: "The bounded public searches returned no results. Try a broader query or an observed name variant." });
  return { records: [], losses, discovery: { query: args.query, attempts } };
}
