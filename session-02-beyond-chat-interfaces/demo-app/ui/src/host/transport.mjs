import { CallToolResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  EDITOR_RESOURCE, exportDescriptor, isObject, mergeSnapshots,
  normalizeSnapshot, safeHttpUrl, sanitizeForInspection,
} from "../shared/state.mjs";
import { compactRecord, executionPage, executionParams, executionRecord } from "../shared/execution.mjs";
import { HOSTED_SANDBOX_PATH } from "./frame-transport.mjs";

const browserKinds = new Set([
  "mcp.resource", "mcp.app.initialize", "app.context", "app.message",
  "app.log", "app.open-link", "export.download",
]);

async function requestJson(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  let value;
  try { value = await response.json(); }
  catch { throw new Error(`The workshop returned an unreadable response (${response.status}).`); }
  if (!response.ok) throw Object.assign(
    new Error(typeof value?.error === "string" ? value.error : `Workshop request failed (${response.status}).`),
    { status: response.status,
      ...(typeof value?.code === "string" ? { code: value.code } : {}),
      ...(isObject(value?.persistence) ? { persistence: value.persistence } : {}) },
  );
  return value;
}

export async function getState(signal) {
  const result = await requestJson("/api/state", { signal });
  const state = normalizeSnapshot(result);
  if (!state) throw new Error("The workshop has not returned an editor issue.");
  return state;
}

export async function retryPersistence(signal) {
  const result = await requestJson("/api/persistence/retry", { method: "POST", signal });
  const state = normalizeSnapshot(result);
  if (!state?.persistence) throw new Error("The workshop did not confirm the save status.");
  return state;
}

export async function listExecution(options = {}, signal) {
  const params = new URLSearchParams(executionParams(options));
  return executionPage(await requestJson(`/api/execution?${params}`, { signal }));
}

export async function getExecutionRecord(id, signal, { includeExchange = false } = {}) {
  return executionRecord(await requestJson(`/api/execution/${encodeURIComponent(id)}${includeExchange ? "?includeExchange=true" : ""}`, { signal }));
}

export async function postBrowserRecord(entry) {
  if (!browserKinds.has(entry?.kind) || typeof entry.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.id)) {
    throw new Error("This browser report has an unsupported kind or event UUID.");
  }
  // Actor, provenance and accounting come from the server. Send only the
  // observation, including the canonical parent supplied by the MCP result.
  const body = JSON.stringify(sanitizeForInspection({
    id: entry.id, kind: entry.kind, status: entry.status, startedAt: entry.startedAt,
    ...(typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
    payload: entry.payload ?? null, result: entry.result ?? null,
  }));
  if (new TextEncoder().encode(body).length > 64 * 1024)
    throw new Error("This browser report exceeds the 64 KiB archive limit.");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 8000);
  try {
    const value = await requestJson("/api/execution/browser", {
      method: "POST", headers: { "content-type": "application/json" },
      body, redirect: "error", signal: abort.signal,
    });
    const record = value?.record;
    if (!isObject(record) || record.id !== `browser:${entry.id}` || record.kind !== entry.kind ||
        record.actor !== "host" || record.reportedBy !== "browser") {
      throw new Error("The archive did not acknowledge this browser report.");
    }
    return compactRecord(record);
  } finally { clearTimeout(timeout); }
}

export async function postTool(name, argumentsValue = {}, signal) {
  const result = await requestJson(`/api/mcp/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ arguments: argumentsValue }),
    signal,
  });
  return CallToolResultSchema.parse(result);
}

export async function readResource(uri, signal) {
  const result = await requestJson(`/api/mcp/resource?uri=${encodeURIComponent(uri)}`, { signal });
  return ReadResourceResultSchema.parse(result);
}

export function appResource(result, uri = EDITOR_RESOURCE) {
  const content = result.contents?.find((item) => item.uri === uri) ?? result.contents?.[0];
  if (!content || content.mimeType !== RESOURCE_MIME_TYPE) {
    throw new Error("The editor resource must use text/html;profile=mcp-app.");
  }
  const html = typeof content.text === "string" ? content.text
    : typeof content.blob === "string"
      ? new TextDecoder().decode(Uint8Array.from(atob(content.blob), (character) => character.charCodeAt(0)))
      : null;
  if (!html) throw new Error("The Interactive Editor View resource contains no HTML.");
  const ui = content._meta?.ui ?? content.meta?.ui ?? result._meta?.ui ?? {};
  return {
    html,
    csp: ui.csp ?? { connectDomains: [], resourceDomains: [] },
    permissions: ui.permissions,
  };
}

export function sandboxUrl(hostOrigin, configuredOrigin = "") {
  const host = new URL(hostOrigin);
  // Hosted visits already have a unique runtime origin. Ingress owns this
  // opaque document; no build-time per-visit origin or app CSP is trusted.
  if (/^r-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\./.test(host.hostname) && host.protocol === "https:") {
    return new URL(HOSTED_SANDBOX_PATH, host);
  }
  const sandbox = configuredOrigin ? new URL("/sandbox.html", configuredOrigin) : new URL("/sandbox.html", host);
  if (!configuredOrigin) {
    if (host.hostname === "localhost") sandbox.hostname = "127.0.0.1";
    else if (host.hostname === "127.0.0.1") sandbox.hostname = "localhost";
    else throw new Error("This host needs a separate VITE_MCP_SANDBOX_ORIGIN.");
  }
  if (sandbox.origin === host.origin || !["http:", "https:"].includes(sandbox.protocol)) {
    throw new Error("The MCP App sandbox must have a different HTTP origin from the workshop host.");
  }
  sandbox.searchParams.set("hostOrigin", host.origin);
  return sandbox;
}

export function snapshotNotification(snapshot) {
  return { content: [], structuredContent: { state: snapshot }, _meta: { ui: { resourceUri: EDITOR_RESOURCE } } };
}

export function resourceUri(result) {
  return result?._meta?.ui?.resourceUri ??
    result?._meta?.["ui/resourceUri"] ??
    result?.structuredContent?._meta?.ui?.resourceUri ?? EDITOR_RESOURCE;
}

export function absoluteArtifact(result, hostOrigin) {
  const artifact = exportDescriptor(result);
  if (!artifact) return { result, artifact: null };
  const url = safeHttpUrl(artifact.url, hostOrigin);
  if (!url || url.origin !== new URL(hostOrigin).origin) {
    throw new Error("The newspaper artifact must be delivered by this workshop host.");
  }
  const descriptor = { ...artifact, url: url.href };
  return {
    artifact: descriptor,
    result: { ...result, structuredContent: { ...result.structuredContent, artifact: descriptor } },
  };
}

// EventSource is the host's observation channel. The App receives these updates
// through the SDK's tool-result notification, never by fetching the host API.
export function stateFromEvent(previous, data, kind = "message") {
  const complete = normalizeSnapshot(data);
  if (complete) return { state: mergeSnapshots(previous, complete), gap: false };
  if (!previous || !isObject(data)) return { state: previous, gap: true };
  const incomingRevision = data.streamRevision ?? data.revision;
  const previousRevision = previous.streamRevision ?? previous.revision;
  if (Number.isSafeInteger(incomingRevision) && Number.isSafeInteger(previousRevision)) {
    if (incomingRevision <= previousRevision) return { state: previous, gap: false };
    if (incomingRevision > previousRevision + 1) return { state: previous, gap: true };
  }
  let next = previous;
  if (isObject(data.patch)) {
    next = {
      ...previous, ...data.patch,
      issue: data.patch.issue ? { ...previous.issue, ...data.patch.issue } : previous.issue,
    };
  } else if (kind === "trace" && isObject(data.entry)) {
    next = { ...previous, trace: [...previous.trace.filter((entry) => entry.id !== data.entry.id), data.entry] };
  } else if (Array.isArray(data.jobs)) next = { ...previous, jobs: data.jobs };
  else return { state: previous, gap: true };
  if (Number.isSafeInteger(data.streamRevision)) next = { ...next, streamRevision: data.streamRevision };
  else if (Number.isSafeInteger(data.revision)) next = { ...next, revision: data.revision };
  return { state: mergeSnapshots(previous, normalizeSnapshot(next)), gap: false };
}
