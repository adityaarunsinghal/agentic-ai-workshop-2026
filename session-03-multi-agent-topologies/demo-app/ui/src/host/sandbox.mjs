/**
 * Modified adaptation of ext-apps 1.7.5 examples/basic-host/src/sandbox.ts:
 * opposite local hostnames, explicit embedding-origin validation, and fixed
 * sandbox flags. Protocol and permission handling use the official SDK.
 * Upstream attribution/license: ui/licenses/mcp-apps-LICENSE.txt.
 */
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";

if (window.self === window.top) throw new Error("The MCP sandbox proxy must be embedded by its host.");

const own = new URL(window.location.href);
const referrer = document.referrer ? new URL(document.referrer) : null;
const supplied = own.searchParams.get("hostOrigin");
const host = referrer ?? (supplied ? new URL(supplied) : null);
if (!host || !["http:", "https:"].includes(host.protocol)) throw new Error("No valid MCP host origin.");
if (referrer && supplied && referrer.origin !== new URL(supplied).origin) {
  throw new Error("The referrer and expected MCP host origin disagree.");
}
const oppositeLocalHosts =
  ((host.hostname === "localhost" && own.hostname === "127.0.0.1") ||
    (host.hostname === "127.0.0.1" && own.hostname === "localhost")) &&
  host.port === own.port && host.protocol === own.protocol;
const configuredHost = import.meta.env.VITE_MCP_HOST_ORIGIN;
const approvedDeployment = configuredHost && host.origin === new URL(configuredHost).origin;
if (host.origin === own.origin || (!oppositeLocalHosts && !approvedDeployment)) {
  throw new Error("This origin is not allowed to embed the MCP sandbox.");
}

// This access must throw. A readable top document would defeat the separate
// origin requirement even if a caller accidentally changed the iframe flags.
let isolated = false;
try { void window.top.document; }
catch (error) { isolated = error.name === "SecurityError"; }
if (!isolated) throw new Error("The MCP App sandbox is not isolated from its host.");

const inner = document.createElement("iframe");
inner.title = "Multi-agent fact-checker MCP App";
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
document.body.appendChild(inner);

window.addEventListener("message", (event) => {
  if (event.source === window.parent) {
    if (event.origin !== host.origin) return;
    if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
      const { html, permissions } = event.data.params ?? {};
      const allow = buildAllowAttribute(permissions);
      if (allow) inner.setAttribute("allow", allow);
      else inner.removeAttribute("allow");
      if (typeof html === "string") {
        // The inner document inherits the proxy's server-enforced CSP.
        const document = inner.contentDocument;
        if (document) {
          document.open();
          document.write(html);
          document.close();
        } else inner.srcdoc = html;
      }
    } else if (typeof event.data?.method !== "string" || !event.data.method.startsWith("ui/notifications/sandbox-")) {
      inner.contentWindow?.postMessage(event.data, own.origin);
    }
  } else if (event.source === inner.contentWindow && event.origin === own.origin &&
      (typeof event.data?.method !== "string" || !event.data.method.startsWith("ui/notifications/sandbox-"))) {
    window.parent.postMessage(event.data, host.origin);
  }
});
window.parent.postMessage({
  jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {},
}, host.origin);
