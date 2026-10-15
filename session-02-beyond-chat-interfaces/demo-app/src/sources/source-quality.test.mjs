import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTrace } from "../trace.mjs";
import { parseArticle } from "./parsers.mjs";
import { createSources } from "./service.mjs";
import { searchPublicWeb } from "./web-search.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const rss = (items) => `<rss version="2.0"><channel><title>Synthetic search</title>${items.map((item) =>
  `<item><title>${escapeXml(item.title)}</title><link>${escapeXml(item.url)}</link>
  <description>${escapeXml(item.snippet ?? "")}</description></item>`).join("")}</channel></rss>`;
const unrelated = {
  title: "CorelDRAW Hilfe: Installationen reparieren",
  url: "https://graphics.example.org/help/repair?query=AI%20course%20agents",
  snippet: "Hier finden Sie Hinweise zur Installation und Aktivierung.",
};

async function search(items, { query = '"Aditya Singhal" AI course agents', limit = 5 } = {}) {
  const calls = [];
  const result = await searchPublicWeb({ query, limit }, {
    async read(url) {
      calls.push(url);
      return {
        url, contentType: calls.length === 1 ? "text/html" : "application/rss+xml",
        bytes: Buffer.from(calls.length === 1 ? '<div class="no-results">No results</div>' : rss(items)),
      };
    },
  }, { signal: new AbortController().signal });
  assert.equal(calls.length, 2, "No new provider or result-page request is authorized.");
  return result;
}

test("unrelated RSS results become inspectable losses, never proof that no relevant sources exist", async () => {
  const result = await search([unrelated]);
  assert.deepEqual(result.records, []);
  assert.equal(result.losses.length, 1);
  const loss = result.losses[0];
  assert.equal(loss.code, "SEARCH_ZERO_QUERY_OVERLAP");
  assert.equal(loss.sourceId, `search-${hash(unrelated.url).slice(0, 24)}`);
  assert.equal(loss.url, unrelated.url);
  assert.equal(loss.title, unrelated.title);
  assert.equal(loss.provider, "bing-rss");
  assert.deepEqual(loss.queryTerms, ["aditya", "singhal", "ai", "course", "agent"]);
  assert.match(loss.message, /not proof/);
  assert.match(loss.message, /direct public source link/);
  assert.deepEqual(result.discovery.attempts.at(-1), {
    provider: "bing-rss", status: "filtered", count: 0, filteredCount: 1,
  });
  assert.equal(result.losses.some((entry) => entry.code === "NO_SEARCH_RESULTS"), false);
});

test("filtering unrelated duplicates does not consume the requested usable-result limit", async () => {
  const valid = { title: "Singhal workshop", url: "https://example.org/workshop", snippet: "An indexed event." };
  const result = await search([unrelated, unrelated, valid], { limit: 1 });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].url, valid.url);
  assert.equal(result.records[0].evidenceLevel, "search-snippet");
  assert.equal(result.records[0].completeness.publisherArticleRead, false);
  assert.equal(result.losses.length, 1);
  assert.equal(result.discovery.attempts.at(-1).filteredCount, 1);
});

test("the lexical guard tolerates accents, case, plural spelling, short snippets, and observed URL paths", async (t) => {
  for (const [query, item] of [
    ["Garcia workshop", { title: "García", url: "https://example.org/profile" }],
    ["AI course", { title: "AI", url: "https://example.org/notice", snippet: "Now open." }],
    ["agents", { title: "Agent", url: "https://example.org/notes" }],
    ['"Aditya Singhal" course', { title: "Public page", url: "https://example.org/%41ditya", snippet: "Details." }],
    ["site:example.org", { title: "Public page", url: "https://example.org/notes" }],
    ["what is the", { title: "A listing", url: "https://example.org/notes" }],
  ]) await t.test(query, async () => {
    const result = await search([item], { query });
    assert.equal(result.records.length, 1);
    assert.equal(result.losses.length, 0);
  });
  const excluded = await search([unrelated], { query: "agents -CorelDRAW" });
  assert.equal(excluded.records.length, 0);
  assert.deepEqual(excluded.losses[0].queryTerms, ["agent"]);
});

test("truncated search metadata stays explicitly incomplete instead of failing a zero-overlap screen", async () => {
  const result = await search([{ ...unrelated, snippet: "Unexamined text. ".repeat(150) + " AI course" }]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].truncated, true);
  assert.equal(result.records[0].completeness.completeForRequestedScope, false);
  assert.equal(result.losses[0].code, "SEARCH_TEXT_LIMIT");
  assert.equal(result.losses.some((entry) => entry.code === "SEARCH_ZERO_QUERY_OVERLAP"), false);
});

test("unsafe result URLs and search challenges retain their existing failure boundary", async () => {
  const calls = [];
  const result = await searchPublicWeb({ query: "agents", limit: 5 }, {
    async read(url) {
      calls.push(url);
      return {
        url, contentType: "text/html",
        bytes: Buffer.from(calls.length === 1 ? '<form id="challenge-form">Verify</form>' : rss([
          { title: "Agents", url: "http://127.0.0.1/private" },
        ])),
      };
    },
  }, {});
  assert.equal(calls.length, 2);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.losses.map((entry) => entry.code), ["SEARCH_PROVIDER_BLOCKED", "UNSAFE_SEARCH_RESULT"]);
});

const playlistUrl = "https://www.youtube.com/playlist?list=synthetic-source-quality";
const playlistTitle = "Workshop video series - YouTube";
const playlistHtml = `<html><head><title>${playlistTitle}</title>
  <meta name="description" content="A platform description is not a transcript."></head>
  <body><div>${playlistTitle}</div><footer><a href="/about">About</a>
  <a href="/terms">Terms</a></footer><script>throw new Error("Do not run scripts")</script></body></html>`;

test("a title-only video page is metadata with observed links, never article or transcript evidence", async () => {
  const page = await parseArticle(playlistHtml, playlistUrl, 2000);
  assert.equal(page.evidenceLevel, "metadata");
  assert.equal(page.readableArticle, false);
  assert.equal(page.extractionReason, "title-only");
  assert.equal(page.text, playlistTitle);
  assert.equal(page.canonicalUrl, playlistUrl);
  assert.ok(page.links.some((link) => link.url === "https://www.youtube.com/about"));
});

test("navigation and script shells are metadata while a short substantive page remains usable", async (t) => {
  for (const [name, html] of [
    ["navigation", '<title>Research portal</title><nav><a href="/help">Help</a><a href="/about">About</a></nav><h1>Welcome</h1>'],
    ["link list", '<title>Index</title><div><a href="/a">Article A</a><a href="/b">Article B</a></div>'],
    ["shell", '<title>Portal</title><meta name="description" content="Discovery description"><div id="root"></div>'],
  ]) await t.test(name, async () => {
    const result = await parseArticle(html, "https://example.org/", 2000);
    assert.equal(result.evidenceLevel, "metadata");
    assert.equal(result.readableArticle, false);
    if (name !== "shell") assert.ok(result.links.length > 0);
    else assert.equal(result.text, "Discovery description");
  });
  for (const html of [
    "<title>Course update</title><main><p>Registration closes Friday.</p></main>",
    "<title>Release notice</title><article><p>Version 2.1 fixes the import bug.</p></article>",
    "<title>API example</title><pre>export const version = 2;</pre>",
    "<title>Short notice</title><article><header><p>The library reopens Monday.</p></header></article>",
  ]) {
    const result = await parseArticle(html, "https://example.org/notice", 2000);
    assert.notEqual(result.evidenceLevel, "metadata");
    assert.ok(result.text.length > 0 && result.text.length < 100);
  }
});

test("classification examines the complete extraction before applying the requested excerpt limit", async () => {
  const title = "A long article heading ".repeat(12).trim();
  const html = `<title>${title}</title><article><h1>${title}</h1>
    <p>${"This paragraph provides substantive reported evidence. ".repeat(12)}</p></article>`;
  const result = await parseArticle(html, "https://example.org/article", 200);
  assert.notEqual(result.evidenceLevel, "metadata");
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 200);
});

function service(t, responses, initialSources = []) {
  const oldProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:9";
  t.after(() => {
    if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = oldProxy;
  });
  // Hosted dispatchers are created but never used: trace.fetch supplies all bytes.
  const trace = createTrace(), calls = [], records = structuredClone(initialSources);
  t.after(() => trace.close());
  trace.fetch = async (url) => {
    calls.push(url);
    assert.ok(responses.length, "No unplanned network request is permitted.");
    return responses.shift();
  };
  const store = {
    snapshot: () => ({ issue: { sources: structuredClone(records) } }),
    addSources(batch) {
      for (const record of batch) {
        const index = records.findIndex((item) => item.id === record.id);
        if (index < 0) records.push(structuredClone(record));
        else records[index] = structuredClone(record);
      }
    },
  };
  return { sources: createSources({ store, trace, config: { mode: "hosted" } }), store, calls };
}
const htmlResponse = (html) => new Response(html, { headers: { "content-type": "text/html" } });

test("fetchRead retains identity, raw-byte digest and discovery links while reporting title-only loss", async (t) => {
  const discovered = { id: "observed-video", title: "Observed playlist", url: playlistUrl, evidenceLevel: "search-snippet" };
  const app = service(t, [htmlResponse(playlistHtml)], [discovered]);
  const batch = await app.sources.fetchRead({ sourceId: discovered.id });
  assert.equal(app.calls.length, 1);
  assert.equal(batch.completeForRequestedScope, false);
  const record = batch.records[0];
  assert.equal(record.id, `web-${hash(playlistUrl).slice(0, 24)}`);
  assert.deepEqual(record.relatedSourceIds, [discovered.id]);
  assert.equal(record.originalUrl, playlistUrl);
  assert.equal(record.contentDigest, hash(playlistHtml));
  assert.equal(record.evidenceLevel, "metadata");
  assert.equal(record.completeness.readableArticle, false);
  assert.equal(record.completeness.completeForRequestedScope, false);
  assert.ok(record.links.length);
  assert.equal(batch.losses[0].code, "SOURCE_METADATA_ONLY");
  assert.match(batch.losses[0].message, /no article body or video transcript was read/);
  assert.match(batch.losses[0].message, /another public source/);
  assert.deepEqual(app.store.snapshot().issue.sources[0], discovered);
});

test("a reread corrects legacy title-as-article metadata but preserves richer dated evidence", async (t) => {
  const old = {
    id: `web-${hash(playlistUrl).slice(0, 24)}`, title: playlistTitle,
    url: playlistUrl, text: playlistTitle, retrievedAt: "2026-10-14T00:00:00Z",
    evidenceLevel: "article-text", completeness: { readableArticle: true },
  };
  const app = service(t, [htmlResponse(playlistHtml)], [old]);
  await app.sources.fetchRead({ sourceId: old.id });
  assert.equal(app.store.snapshot().issue.sources[0].evidenceLevel, "metadata");
  assert.equal(app.store.snapshot().issue.sources[0].completeness.readableArticle, false);

  const historical = { ...old, text: "Previously retrieved substantive copy with a preserved observation date." };
  const richer = service(t, [htmlResponse(playlistHtml)], [historical]);
  const fresh = await richer.sources.fetchRead({ sourceId: old.id });
  assert.equal(fresh.records[0].evidenceLevel, "metadata");
  assert.equal(richer.store.snapshot().issue.sources[0].text, historical.text);
  assert.equal(richer.store.snapshot().issue.sources[0].retrievedAt, historical.retrievedAt);
  assert.ok(richer.store.snapshot().issue.sources[0].metadataRetrievedAt);
});

test("HTTP 403 and visible challenge pages give other-source guidance without bypass attempts", async (t) => {
  const blocked = service(t, [new Response("Forbidden", { status: 403 })]);
  const denied = await blocked.sources.fetchRead({ url: playlistUrl });
  assert.equal(blocked.calls.length, 1);
  assert.deepEqual(denied.records, []);
  assert.equal(denied.losses[0].code, "HTTP_FAILED");
  assert.match(denied.losses[0].message, /403.*another public source/);
  assert.equal(denied.losses[0].url, playlistUrl);

  const challenged = service(t, [htmlResponse('<title>Just a moment...</title><form id="challenge-form">Verify you are human</form>')]);
  const challenge = await challenged.sources.fetchRead({ url: playlistUrl });
  assert.equal(challenged.calls.length, 1);
  assert.equal(challenge.records[0].evidenceLevel, "metadata");
  assert.equal(challenge.losses[0].code, "SOURCE_ACCESS_CHALLENGE");
  assert.match(challenge.losses[0].message, /CAPTCHA/);
});

test("short plaintext evidence remains a successful reading", async (t) => {
  const text = "Registration closes Friday.";
  const app = service(t, [new Response(text, { headers: { "content-type": "text/plain" } })]);
  const result = await app.sources.fetchRead({ url: "https://example.org/notice.txt" });
  assert.equal(result.records[0].text, text);
  assert.equal(result.records[0].evidenceLevel, "plaintext");
  assert.equal(result.completeForRequestedScope, true);
  assert.deepEqual(result.losses, []);
});
