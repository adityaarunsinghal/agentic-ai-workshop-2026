import { createPublicHttp } from "../src/sources/public-http.mjs";

// Native builds already authorize the npm registry for dependency installation.
// Exercise the app's actual HTTPS adapter with that same proxy and Node binary,
// before publication, without invoking a model or any visitor storage.
const http = createPublicHttp({ mode: "hosted", trace: { fetch: globalThis.fetch } });
const response = await http.read("https://registry.npmjs.org/-/ping", {
  signal: AbortSignal.timeout(15000), maxBytes: 16384,
});
if (response.status !== 200)
  throw new Error("The hosted source HTTPS transport did not become ready.");
console.info(`Hosted source HTTPS transport passed on Node ${process.versions.node}. No model calls.`);
