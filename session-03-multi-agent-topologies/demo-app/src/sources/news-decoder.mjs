import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { decodeBytes } from "./parsers.mjs";
import { publicUrl, SourceError } from "./public-http.mjs";

const require = createRequire(import.meta.url);
let decoderSource;

/** The published decoder hardcodes fetch. Inject it in an isolated module scope. */
export async function decodeNewsUrl(value, http, options) {
  const url = publicUrl(value);
  if (url.hostname !== "news.google.com") return url.href;
  if (!/\/(?:articles|read)\/[A-Za-z0-9_-]+$/.test(url.pathname))
    throw new SourceError("NEWS_URL_UNRESOLVED", "This Google News link does not identify a decodable article.");
  decoderSource ??= (async () => {
    const path = require.resolve("google-news-url-decoder");
    return { source: await readFile(path, "utf8"), require: createRequire(path) };
  })().catch((error) => { decoderSource = undefined; throw error; });
  let loaded;
  try {
    loaded = await decoderSource;
  } catch {
    throw new SourceError("NEWS_DECODER_UNAVAILABLE", "The Google News URL decoder dependency is unavailable.");
  }
  const module = { exports: {} };
  let transportError;
  const observedFetch = async (target, init = {}) => {
    const endpoint = publicUrl(String(target));
    if (endpoint.origin !== "https://news.google.com")
      throw new SourceError("UNSAFE_DECODER_REQUEST", "The news decoder requested an unsupported endpoint.");
    const result = await http.read(endpoint.href, {
      ...options, method: init.method ?? "GET", body: init.body,
      // Do not forward the decoder's browser identity, Origin, or Referer headers.
      headers: init.method === "POST" ? { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } : {},
      kind: "source.news.decode", maxBytes: 512 * 1024,
    }).catch((error) => {
      // The decoder converts fetch errors to a status object. Preserve the
      // source transport's safe code, including missing hosted proxy settings.
      transportError = error;
      throw error;
    });
    return new Response(decodeBytes(result.bytes, result.contentType), {
      status: result.status, headers: { "content-type": result.contentType },
    });
  };
  runInNewContext(loaded.source, {
    module, exports: module.exports, require: loaded.require,
    URL, encodeURIComponent, fetch: observedFetch,
  }, { timeout: 1000, filename: "google-news-url-decoder" });
  const result = await new module.exports.GoogleDecoder().decode(url.href);
  options.signal?.throwIfAborted();
  if (transportError) throw transportError;
  if (!result.status || typeof result.decoded_url !== "string")
    throw new SourceError("NEWS_URL_UNRESOLVED", "Google News did not return a publisher article URL.");
  const decoded = publicUrl(result.decoded_url);
  if (decoded.hostname === "news.google.com")
    throw new SourceError("NEWS_URL_UNRESOLVED", "Google News returned another unresolved news link.");
  return decoded.href;
}
