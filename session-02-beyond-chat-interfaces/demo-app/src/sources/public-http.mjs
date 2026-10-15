import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) privateAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
]) privateAddresses.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  if (family === 6)
    return globalV6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6");
  return false;
}

/** Citations and fetches share this check; the active transport validates DNS. */
export function publicUrl(value) {
  let url;
  try {
    if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\\]/u.test(value))
      throw new Error();
    url = new URL(value);
  } catch {
    throw new SourceError("INVALID_URL", "Use an absolute public HTTP or HTTPS URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) ||
    !hostname || hostname === "localhost" ||
    /\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/i.test(hostname) ||
    (!isIP(hostname) && !hostname.includes(".")) ||
    (isIP(hostname) && !isPublicAddress(hostname)) ||
    [...url.searchParams.keys()].some((key) =>
      /^(?:access_token|token|api[-_]?key|authorization|password|credential|signature|sig|x-amz-(?:credential|signature|security-token))$/i.test(key))
  ) throw new SourceError("UNSAFE_URL", "Only public web URLs on standard HTTP ports are supported.");
  url.hash = "";
  return url;
}

export function canonicalUrl(value) {
  const url = publicUrl(value);
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase()))
      url.searchParams.delete(key);
  return url.href;
}

async function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function resolvePublic(url, { signal, resolve = lookup } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(hostname);
  let addresses;
  try {
    addresses = family
      ? [{ address: hostname, family }]
      : await abortable(resolve(hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SourceError) throw error;
    throw new SourceError("DNS_FAILED", "The public source hostname could not be resolved.");
  }
  if (
    !Array.isArray(addresses) || !addresses.length || addresses.length > 64 ||
    addresses.some((entry) => !isPublicAddress(entry.address))
  ) throw new SourceError("UNSAFE_ADDRESS", "The source hostname resolves to an unsupported address.");
  return addresses;
}

async function dispatcherFor(addresses) {
  // Pin the validated addresses: a second DNS lookup must not enable rebinding.
  const { Agent, Dispatcher1Wrapper } = await import("undici");
  // Node 22's built-in fetch uses the legacy dispatcher handler API.
  return new Dispatcher1Wrapper(new Agent({
    connections: 1,
    connect: {
      lookup(_hostname, options, callback) {
        const candidates = addresses.filter((entry) => !options.family || entry.family === options.family);
        if (!candidates.length) return callback(new Error("No validated address for this family."));
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      },
    },
  }));
}

function hostedProxyUrl(url, env) {
  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const value = url.protocol === "https:"
    ? env.HTTPS_PROXY || env.https_proxy || httpProxy : httpProxy;
  if (!value)
    throw new SourceError("PROXY_REQUIRED", "Hosted source retrieval requires the platform HTTP_PROXY/HTTPS_PROXY configuration.");
  try {
    const proxy = new URL(value);
    if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" ||
      proxy.search || proxy.hash || /[\u0000-\u0020\\]/u.test(value))
      throw new Error();
    // Validate encoded credentials here so constructor errors cannot expose them.
    decodeURIComponent(proxy.username);
    decodeURIComponent(proxy.password);
    return proxy.href;
  } catch {
    throw new SourceError("PROXY_INVALID", "Hosted source retrieval requires a valid platform HTTP(S) proxy URL.");
  }
}

async function proxyDispatcherFor(uri) {
  const { ProxyAgent, Pool, Dispatcher1Wrapper } = await import("undici");
  return new Dispatcher1Wrapper(new ProxyAgent({
    uri, connections: 1,
    // Undici 8 omits the default port from CONNECT's Host header. The
    // platform proxy requires it to match the complete CONNECT authority.
    clientFactory: (origin, options) => new Pool(origin, { ...options, connections: 1 })
      .compose((dispatch) => (request, handler) => dispatch({
        ...request, headers: { ...request.headers, host: request.path },
      }, handler)),
  }));
}

async function readBytes(response, maxBytes, allowPartial) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxBytes && !allowPartial) {
    await response.body?.cancel();
    throw new SourceError("RESPONSE_TOO_LARGE", "The complete source exceeds the retrieval byte limit.");
  }
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - size;
      if (next.value.byteLength > remaining) {
        if (!allowPartial)
          throw new SourceError("RESPONSE_TOO_LARGE", "The complete source exceeds the retrieval byte limit.");
        chunks.push(next.value.subarray(0, remaining));
        size += remaining;
        truncated = true;
        break;
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, size), truncated };
}

/** Every HTTP hop, including a decoder's requests, uses the parent's trace fetch. */
export function createPublicHttp({
  trace, mode, env = process.env, resolve, createDispatcher = dispatcherFor,
  createProxyDispatcher = proxyDispatcherFor,
}) {
  const hosted = mode === "hosted" || env.WORKSHOP_RUNTIME === "hosted";
  return {
    async read(value, options = {}) {
      const {
        signal = AbortSignal.timeout(15000), parentId, requestId, kind = "source.http",
        maxBytes = 512 * 1024, allowPartial = false,
        method = "GET", body, headers = {},
      } = options;
      let url = publicUrl(value);
      const redirects = [];
      // POST is reserved for the decoder's fixed public Google News endpoint.
      if (
        method !== "GET" &&
        !(method === "POST" && url.href === "https://news.google.com/_/DotsSplashUi/data/batchexecute")
      ) throw new SourceError("UNSUPPORTED_METHOD", "This source reader only retrieves public documents.");
      for (let hop = 0; hop <= 4; hop++) {
        signal?.throwIfAborted();
        // Hosted DNS and address pinning belong to the approved platform proxy.
        // Use an explicit dispatcher: NO_PROXY must never bypass source policy.
        const dispatcher = hosted
          ? await createProxyDispatcher(hostedProxyUrl(url, env))
          : await createDispatcher(await resolvePublic(url, { signal, resolve }));
        const inherited = trace.context?.() ?? {};
        let response;
        try {
          response = await trace.fetch(url.href, {
            method, body, headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.5", ...headers },
            redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer",
            signal, dispatcher,
          }, { ...inherited, kind, maxBytes,
            parentId: parentId ?? inherited.parentId, requestId: requestId ?? inherited.requestId,
            mcpRequestId: options.mcpRequestId ?? inherited.mcpRequestId,
            jobId: options.jobId ?? inherited.jobId, slotId: options.slotId ?? inherited.slotId,
            issueId: options.issueId ?? inherited.issueId, issueRevision: options.issueRevision ?? inherited.issueRevision });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel().catch(() => {});
            if (!location || hop === 4 || method !== "GET")
              throw new SourceError("REDIRECT_LIMIT", "The source could not be resolved within the redirect limit.");
            const next = publicUrl(new URL(location, url).href);
            if (redirects.includes(next.href) || next.href === url.href)
              throw new SourceError("REDIRECT_LOOP", "The source returned a redirect loop.");
            redirects.push(url.href);
            url = next;
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new SourceError("HTTP_FAILED", `The public source returned HTTP ${response.status}.`);
          }
          const contentType = response.headers.get("content-type") ?? "";
          const content = await readBytes(response, maxBytes, allowPartial);
          return { ...content, url: url.href, redirects, contentType, status: response.status };
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof SourceError) throw error;
          throw new SourceError("FETCH_FAILED", "The public source request failed.");
        } finally {
          await dispatcher.close();
        }
      }
      throw new SourceError("REDIRECT_LIMIT", "The source exceeded the redirect limit.");
    },
  };
}
