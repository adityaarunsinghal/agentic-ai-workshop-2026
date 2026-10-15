import assert from "node:assert/strict";
import test from "node:test";
import { createIssueStore } from "../domain/store.mjs";
import { createTrace } from "../trace.mjs";
import { decodeNewsUrl } from "./news-decoder.mjs";
import { parseArticle, parseNewsFeed } from "./parsers.mjs";
import { createPublicHttp, isPublicAddress, publicUrl, resolvePublic } from "./public-http.mjs";
import { createSources } from "./service.mjs";
import { parseDuckDuckGoResults, searchPublicWeb } from "./web-search.mjs";

test("all fixture source methods run without HTTP and preserve evidence scopes", async () => {
  const trace = createTrace();
  let httpCalls = 0;
  trace.fetch = async () => { httpCalls++; throw new Error("External requests are forbidden."); };
  const store = await createIssueStore({ trace });
  const sources = createSources({ store, trace, config: { mode: "fixture" } });
  const listing = await sources.listStories();
  assert.equal(listing.records.length, 5);
  assert.ok(listing.records.every((source) => source.origin === "fixture" && source.evidenceLevel === "metadata"));
  const id = listing.records[0].id;
  const detail = await sources.getStory({ id });
  assert.equal(detail.records[0].evidenceLevel, "hn-post");
  const relisted = await sources.listStories({ count: 1 });
  assert.equal(relisted.records[0].text, "");
  assert.equal(store.snapshot().issue.sources.find((source) => source.id === id).text, detail.records[0].text);
  assert.equal((await sources.getComments({ id, limit: 2 })).records.length, 2);
  assert.equal((await sources.searchHn({ query: "tools" })).fixture, true);
  assert.equal((await sources.searchGoogleNews({ query: "tools" })).records[0].evidenceLevel, "feed-summary");
  const web = await sources.searchWeb({ query: "workshop", limit: 2 });
  assert.equal(web.records.length, 2);
  assert.ok(web.records.every((source) => source.evidenceLevel === "search-snippet"));
  const webRead = await sources.fetchRead({ sourceId: web.records[0].id, maxLinks: 2 });
  assert.equal(webRead.records[0].evidenceLevel, "article-text");
  assert.equal(webRead.records[0].links.length, 2);
  assert.ok(webRead.records[0].links.every((link) => link.url && link.title));
  assert.equal((await sources.listStories({ category: "job", count: 1 })).records[0].category, "job");
  const reading = await sources.fetchRead({ sourceId: id, maxChars: 200 });
  assert.ok(reading.records[0].text.length <= 200);
  assert.equal(reading.completeForRequestedScope, false);
  assert.ok(reading.losses.some((entry) => entry.code === "TEXT_LIMIT"));
  assert.equal(store.snapshot().issue.sources.find((source) => source.id === id).text, detail.records[0].text);
  const simulated = {
    id: "fixture-reserved-source", title: "A simulated research record", origin: "fixture",
    url: "https://example.invalid/simulated-research", text: "Synthetic source content.",
    evidenceLevel: "simulated",
  };
  store.addSources([simulated]);
  assert.equal((await sources.fetchRead({
    sourceId: simulated.id, url: simulated.url,
  })).records[0].text, simulated.text);
  const missing = await sources.fetchRead({ url: "https://example.org/not-in-fixture" });
  assert.equal(missing.records.length, 0);
  assert.equal(missing.losses[0].code, "FIXTURE_URL_UNAVAILABLE");
  assert.equal(httpCalls, 0);
  await assert.rejects(sources.listStories({ count: 13 }));
  await assert.rejects(sources.listStories({ limit: 3 }));
  await assert.rejects(sources.listStories({ category: "jobs" }));
});

test("general web discovery returns observed snippets, checks result URLs and bounds one alternate provider", async () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fevent">A public event</a>
    <div class="result__snippet">A search preview only.</div></div>
    <div class="result"><a class="result__a" href="http://127.0.0.1/private">Unsafe</a></div>`;
  const parsed = await parseDuckDuckGoResults(html, "https://html.duckduckgo.com/html/?q=event",
    { query: "event", limit: 5 });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].url, "https://example.org/event");
  assert.equal(parsed.records[0].evidenceLevel, "search-snippet");
  assert.equal(parsed.records[0].completeness.publisherArticleRead, false);
  assert.equal(parsed.losses[0].code, "UNSAFE_SEARCH_RESULT");
  const calls = [];
  const result = await searchPublicWeb({ query: "event", limit: 1 }, {
    async read(url, options) {
      calls.push({ url, options });
      if (calls.length === 1) throw new Error("Synthetic provider unavailable");
      return { url, contentType: "application/rss+xml", bytes: Buffer.from(`<rss version="2.0"><channel>
        <title>Search</title><item><title>Event</title><link>https://example.org/event</link>
        <description>Search snippet</description></item></channel></rss>`) };
    },
  }, { signal: new AbortController().signal });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).hostname, "html.duckduckgo.com");
  assert.equal(new URL(calls[1].url).hostname, "www.bing.com");
  assert.ok(calls.every(({ options }) => options.maxBytes === 512 * 1024));
  assert.deepEqual(result.discovery.attempts.map((attempt) => attempt.status), ["unavailable", "results"]);
  assert.equal(result.records[0].evidenceLevel, "search-snippet");
});

test("readable pages expose bounded public links; JavaScript shells remain metadata only", async () => {
  const text = "An observed workshop page with supporting text. ".repeat(15);
  const html = `<html><head><title>Research homepage</title></head><body><article><p>${text}</p></article>
    <a href="https://external.example.org/paper">Paper</a>
    <a href="/course?utm_source=home">Course</a><a href="/course">Duplicate course</a>
    <a href="/event">Event</a><a href="http://127.0.0.1/private">Unsafe</a>
    <a href="https://user:secret@example.org/private">Credentialed</a>
    <a href="javascript:alert(1)">Script</a><a href="#section">Same page</a></body></html>`;
  const parsed = await parseArticle(html, "https://example.org/", 2000, 2);
  assert.deepEqual(parsed.links, [
    { title: "Course", url: "https://example.org/course?utm_source=home" },
    { title: "Event", url: "https://example.org/event" },
  ]);
  assert.equal(parsed.linksTruncated, true);
  const shell = await parseArticle(`<html><head><title>Public homepage</title>
    <meta name="description" content="Self-described biography"></head>
    <body><div id="root"></div><script>throw new Error("Do not execute")</script></body></html>`,
  "https://example.org/", 2000, 12);
  assert.equal(shell.evidenceLevel, "metadata");
  assert.equal(shell.readableArticle, false);
  assert.equal(shell.text, "Self-described biography");
  assert.deepEqual(shell.links, []);
});

test("URL and DNS validation rejects private, mapped, credentialed, and mixed destinations", async () => {
  for (const url of [
    "file:///etc/passwd", "http://localhost/", "http://2130706433/", "http://10.1.2.3/",
    "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://service.internal/",
    "https://user:password@example.org/", "https://example.org:8080/",
    "https://example.org/?access_token=synthetic-secret",
  ]) assert.throws(() => publicUrl(url), undefined, url);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2002:0808:0808::1"), false);
  await assert.rejects(resolvePublic(publicUrl("https://example.org/"), {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
  }), { code: "UNSAFE_ADDRESS" });
});

function mockedHttp(responses) {
  const requests = [];
  const pins = [];
  let closed = 0;
  const http = createPublicHttp({
    trace: { fetch: async (...request) => { requests.push(request); return responses.shift(); } },
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    createDispatcher: async (addresses) => {
      pins.push(addresses);
      return { close: async () => { closed++; } };
    },
  });
  return { http, requests, pins, get closed() { return closed; } };
}

test("each redirect is checked before fetch and each connection gets the validated addresses", async () => {
  const blocked = mockedHttp([new Response(null, {
    status: 302, headers: { location: "http://127.0.0.1/private" },
  })]);
  await assert.rejects(blocked.http.read("https://example.org/start"), { code: "UNSAFE_URL" });
  assert.equal(blocked.requests.length, 1);
  assert.equal(blocked.closed, 1);
  const allowed = mockedHttp([
    new Response(null, { status: 302, headers: { location: "https://publisher.example.org/article" } }),
    new Response("A synthetic public document.", { headers: { "content-type": "text/plain" } }),
  ]);
  const result = await allowed.http.read("https://example.org/start");
  assert.equal(result.url, "https://publisher.example.org/article");
  assert.deepEqual(result.redirects, ["https://example.org/start"]);
  assert.equal(allowed.requests.length, 2);
  assert.equal(allowed.requests[0][1].redirect, "manual");
  assert.deepEqual(allowed.pins, Array(2).fill([{ address: "8.8.8.8", family: 4 }]));
  assert.equal(allowed.closed, 2);
});

test("the byte limit keeps explicit excerpts and rejects incomplete structured sources", async () => {
  const partial = mockedHttp([new Response("synthetic document", { headers: { "content-type": "text/plain" } })]);
  const result = await partial.http.read("https://example.org/", { maxBytes: 9, allowPartial: true });
  assert.equal(result.bytes.toString(), "synthetic");
  assert.equal(result.truncated, true);
  const complete = mockedHttp([new Response('{"synthetic":true}')]);
  await assert.rejects(complete.http.read("https://example.org/", { maxBytes: 5 }), { code: "RESPONSE_TOO_LARGE" });
});

test("library parsing uses supplied HTML/RSS and cannot load page scripts or subresources", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Parsing attempted an external request."); };
  try {
    const paragraph = "This synthetic workshop article describes a fictional source review. ".repeat(8);
    const html = `<html><head><title>Synthetic article</title>
      <link rel="canonical" href="http://127.0.0.1/private"></head>
      <body><article><h1>Synthetic article</h1><p>${paragraph}</p><p>${paragraph}</p></article>
      <script>throw new Error("Page script ran")</script><img src="https://example.org/external.png"></body></html>`;
    const article = await parseArticle(html, "https://example.org/article", 200);
    assert.equal(article.canonicalUrl, "https://example.org/article");
    assert.ok(article.text.includes("synthetic workshop"));
    assert.equal(article.truncated, true);
    assert.ok(article.text.length <= 200);
    const feed = await parseNewsFeed(`<rss version="2.0"><channel><title>Synthetic news</title>
      <link>https://example.org/</link><description>Fixture</description><item>
      <title>Synthetic event</title><link>https://example.org/article</link>
      <description>Feed summary only</description><source url="https://example.org/">Fictional News</source>
      </item></channel></rss>`);
    assert.equal(feed.items[0].title, "Synthetic event");
    assert.equal(feed.items[0].source._, "Fictional News");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the published news decoder uses only its injected, bounded HTTP adapter", async () => {
  const requests = [];
  const http = { read: async (url, options) => {
    requests.push({ url, options });
    const body = requests.length === 1
      ? '<c-wiz><div jscontroller="fixture" data-n-a-sg="fixture-signature" data-n-a-ts="123"></div></c-wiz>'
      : `)]}'\n\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", "https://example.org/article"])]])}`;
    return { bytes: Buffer.from(body), contentType: "text/plain", status: 200 };
  } };
  const url = await decodeNewsUrl("https://news.google.com/rss/articles/CBMiSynthetic", http, {
    signal: AbortSignal.timeout(1000), requestId: "synthetic-request",
  });
  assert.equal(url, "https://example.org/article");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.kind, "source.news.decode");
  assert.equal(requests[1].options.maxBytes, 512 * 1024);
  assert.equal(requests[1].options.headers.authorization, undefined);
});
