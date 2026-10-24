import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Dispatcher1Wrapper } from "undici";
import { createIssueStore } from "../domain/store.mjs";
import { createTrace } from "../trace.mjs";
import { createPublicHttp } from "./public-http.mjs";
import { createSources } from "./service.mjs";

const httpProxy = "http://visit:synthetic-capability@127.0.0.1:9001/";
const httpsProxy = "http://visit:synthetic-capability@127.0.0.1:9002/";
const noDirect = () => assert.fail("Hosted retrieval attempted direct DNS or transport.");

function mockedHosted(responses = [], overrides = {}) {
  const requests = [], proxies = [];
  let closed = 0;
  const http = createPublicHttp({
    mode: "hosted", env: { HTTP_PROXY: httpProxy, HTTPS_PROXY: httpsProxy, NO_PROXY: "*" },
    resolve: noDirect, createDispatcher: noDirect,
    createProxyDispatcher(uri) {
      proxies.push(uri);
      return { close: async () => { closed++; } };
    },
    trace: { fetch: async (...request) => { requests.push(request); return responses.shift(); } },
    ...overrides,
  });
  return { http, requests, proxies, get closed() { return closed; } };
}

test("hosted redirects select the proxy per protocol and never resolve or connect directly", async () => {
  const fixture = mockedHosted([
    new Response(null, { status: 302, headers: { location: "https://publisher.example.org/article" } }),
    new Response("Public document", { headers: { "content-type": "text/plain" } }),
  ]);
  const signal = AbortSignal.timeout(1000);
  const result = await fixture.http.read("http://source.example.org/", { signal, parentId: "source-span" });
  assert.equal(result.bytes.toString(), "Public document");
  assert.deepEqual(result.redirects, ["http://source.example.org/"]);
  assert.deepEqual(fixture.proxies, [httpProxy, httpsProxy]);
  assert.equal(fixture.closed, 2);
  for (const [, init, meta] of fixture.requests) {
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.equal(init.signal, signal);
    assert.equal(init.headers["proxy-authorization"], undefined);
    assert.equal(meta.parentId, "source-span");
  }
  for (const env of [{ https_proxy: httpsProxy }, { HTTP_PROXY: httpProxy }, { http_proxy: httpProxy }]) {
    const lower = mockedHosted([new Response("ok")], { env });
    await lower.http.read("https://source.example.org/");
    assert.deepEqual(lower.proxies, [env.https_proxy ?? httpProxy]);
  }
});

test("hosted source reads fail closed on absent or invalid proxies, including runtime-enforced hosted mode", async () => {
  for (const [mode, env, code] of [
    ["hosted", {}, "PROXY_REQUIRED"],
    ["local", { WORKSHOP_RUNTIME: "hosted", NO_PROXY: "*" }, "PROXY_REQUIRED"],
    ["hosted", { HTTPS_PROXY: "not a proxy" }, "PROXY_INVALID"],
    ["hosted", { HTTPS_PROXY: "socks5://127.0.0.1:9001" }, "PROXY_INVALID"],
    ["hosted", { HTTPS_PROXY: `${httpsProxy}?token=synthetic-secret` }, "PROXY_INVALID"],
    ["hosted", { HTTPS_PROXY: "http://visit:%zz@127.0.0.1:9001" }, "PROXY_INVALID"],
  ]) {
    const fixture = mockedHosted([], { mode, env });
    await assert.rejects(fixture.http.read("https://source.example.org/"), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /synthetic-secret|%zz/);
      return true;
    });
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.proxies.length, 0);
  }
  const missingHttp = mockedHosted([], { env: { HTTPS_PROXY: httpsProxy } });
  await assert.rejects(missingHttp.http.read("http://source.example.org/"), { code: "PROXY_REQUIRED" });
});

test("hosted transport retains URL, redirect, method, byte, and cancellation bounds", async () => {
  const unsafe = mockedHosted([new Response(null, {
    status: 302, headers: { location: "http://127.0.0.1/private" },
  })]);
  await assert.rejects(unsafe.http.read("https://source.example.org/"), { code: "UNSAFE_URL" });
  assert.equal(unsafe.requests.length, 1);
  assert.equal(unsafe.closed, 1);
  const loop = mockedHosted([new Response(null, {
    status: 302, headers: { location: "/start" },
  })]);
  await assert.rejects(loop.http.read("https://source.example.org/start"), { code: "REDIRECT_LOOP" });
  const redirects = mockedHosted(Array.from({ length: 5 }, (_, index) =>
    new Response(null, { status: 302, headers: { location: `/hop-${index}` } })));
  await assert.rejects(redirects.http.read("https://source.example.org/"), { code: "REDIRECT_LIMIT" });
  assert.equal(redirects.closed, 5);
  const blockedPost = mockedHosted();
  await assert.rejects(blockedPost.http.read("https://source.example.org/", { method: "POST" }),
    { code: "UNSUPPORTED_METHOD" });
  assert.equal(blockedPost.requests.length, 0);
  const complete = mockedHosted([new Response("too large")]);
  await assert.rejects(complete.http.read("https://source.example.org/", { maxBytes: 3 }),
    { code: "RESPONSE_TOO_LARGE" });
  assert.equal(complete.closed, 1);
  const partial = mockedHosted([new Response("bounded excerpt")]);
  const result = await partial.http.read("https://source.example.org/", { maxBytes: 7, allowPartial: true });
  assert.equal(result.bytes.toString(), "bounded");
  assert.equal(result.truncated, true);
  const cancelled = mockedHosted();
  await assert.rejects(cancelled.http.read("https://source.example.org/", {
    signal: AbortSignal.abort(),
  }), { name: "AbortError" });
  assert.equal(cancelled.requests.length, 0);
});

test("installed proxy transport sends authenticated HTTP and exact HTTPS CONNECT authority, denies fallback, and times out", async (t) => {
  const observed = [];
  const sockets = new Set();
  const proxy = createServer((request, response) => {
    observed.push({ method: request.method, target: request.url, headers: request.headers });
    if (request.url.endsWith("/stall")) return;
    response.writeHead(200, { "content-type": "text/plain", connection: "close" });
    response.end("Synthetic proxy document");
  });
  proxy.on("connect", (request, socket) => {
    observed.push({ method: request.method, target: request.url, headers: request.headers });
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  });
  const uri = `http://visit:synthetic%3Asecret@127.0.0.1:${proxy.address().port}`;
  const http = createPublicHttp({
    mode: "hosted", env: { HTTP_PROXY: uri, HTTPS_PROXY: uri, NO_PROXY: "*" },
    resolve: noDirect, createDispatcher: noDirect, trace: { fetch },
  });
  const result = await http.read("http://source.example.org/", { signal: AbortSignal.timeout(2000) });
  assert.equal(result.bytes.toString(), "Synthetic proxy document");
  await assert.rejects(http.read("https://source.example.org/", { signal: AbortSignal.timeout(2000) }),
    { code: "FETCH_FAILED" });
  assert.deepEqual(observed.map(({ method, target }) => [method, target]), [
    ["GET", "http://source.example.org/"], ["CONNECT", "source.example.org:443"],
  ]);
  assert.equal(observed[1].headers.host, observed[1].target);
  for (const request of observed) {
    assert.equal(request.headers["proxy-authorization"],
      `Basic ${Buffer.from("visit:synthetic:secret").toString("base64")}`);
    assert.equal(request.headers.authorization, undefined);
  }
  await assert.rejects(http.read("http://source.example.org/stall", {
    signal: AbortSignal.timeout(100),
  }), { name: "TimeoutError" });
  assert.equal(observed.length, 3);
});

test("hosted source service uses the proxy for HN, web/news search, every decoder request and article content checks", async (t) => {
  const variables = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "WORKSHOP_RUNTIME"];
  const previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  for (const key of variables) delete process.env[key];
  process.env.HTTPS_PROXY = httpsProxy;
  t.after(() => {
    for (const key of variables) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const trace = createTrace();
  t.after(() => trace.close());
  const requests = [];
  trace.fetch = async (url, init) => {
    assert.ok(init.dispatcher instanceof Dispatcher1Wrapper);
    assert.equal(init.redirect, "manual");
    requests.push({ url, method: init.method });
    if (url.endsWith("topstories.json")) return Response.json([1]);
    if (url.endsWith("item/1.json"))
      return Response.json({ id: 1, type: "story", title: "Synthetic HN", time: 1700000000 });
    if (url.startsWith("https://hn.algolia.com/")) return Response.json({ hits: [] });
    if (url.startsWith("https://news.google.com/rss/search"))
      return new Response("<rss version=\"2.0\"><channel><title>News</title></channel></rss>");
    if (url.startsWith("https://html.duckduckgo.com/"))
      return new Response('<div class="result"><a class="result__a" href="https://example.org/article">Article</a><div class="result__snippet">Preview</div></div>');
    if (url.startsWith("https://news.google.com/rss/articles/"))
      return new Response('<c-wiz><div jscontroller="fixture" data-n-a-sg="fixture-signature" data-n-a-ts="123"></div></c-wiz>');
    if (url === "https://news.google.com/_/DotsSplashUi/data/batchexecute")
      return new Response(`)]}'\n\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", "https://example.org/article"])]])}`);
    if (url === "https://example.org/article")
      return new Response("Synthetic article", { headers: { "content-type": "text/plain" } });
    if (url === "https://example.org/binary")
      return new Response("binary", { headers: { "content-type": "application/octet-stream" } });
    assert.fail(`Unexpected synthetic source: ${url}`);
  };
  const store = await createIssueStore({ trace });
  const sources = createSources({ store, trace, config: { mode: "hosted" } });
  assert.equal((await sources.listStories({ count: 1 })).records.length, 1);
  assert.equal((await sources.searchHn({ query: "agents" })).records.length, 0);
  assert.equal((await sources.searchGoogleNews({ query: "agents" })).records.length, 0);
  assert.equal((await sources.searchWeb({ query: "agents" })).records.length, 1);
  const article = await sources.fetchRead({ url: "https://news.google.com/rss/articles/CBMiSynthetic" });
  assert.equal(article.records[0]?.text, "Synthetic article");
  assert.deepEqual(requests.slice(-3), [
    { url: "https://news.google.com/rss/articles/CBMiSynthetic", method: "GET" },
    { url: "https://news.google.com/_/DotsSplashUi/data/batchexecute", method: "POST" },
    { url: "https://example.org/article", method: "GET" },
  ]);
  assert.equal((await sources.fetchRead({ url: "https://example.org/binary" })).losses[0].code,
    "UNSUPPORTED_CONTENT");
  delete process.env.HTTPS_PROXY;
  await assert.rejects(sources.listStories({ count: 1 }), { code: "PROXY_REQUIRED" });
  assert.equal((await sources.fetchRead({
    url: "https://news.google.com/rss/articles/CBMiSynthetic",
  })).losses[0].code, "PROXY_REQUIRED");
});
