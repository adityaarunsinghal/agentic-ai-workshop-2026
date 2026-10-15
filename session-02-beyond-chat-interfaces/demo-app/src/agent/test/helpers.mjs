import { randomUUID } from "node:crypto";
import { createIssueStore } from "../../domain/store.mjs";
import { createGateway } from "../gateway.mjs";
import { createResearchAgent } from "../runtime.mjs";

export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

export function offlineTrace(fetcher) {
  const entries = [], requests = [];
  return {
    entries, requests,
    record(kind, data = {}) {
      const entry = { id: randomUUID(), kind, ...structuredClone(data) };
      entries.push(entry);
      return entry;
    },
    start(kind, data) {
      const entry = this.record(kind, { ...data, status: "running" });
      return { id: entry.id, finish: (result) => Object.assign(entry, structuredClone(result)) };
    },
    async fetch(url, init, meta) {
      requests.push({ url: String(url), init, meta });
      if (!fetcher) throw new Error("Network is forbidden in this offline fixture.");
      return fetcher(url, init, meta);
    },
    context: () => ({ parentId: "fixture-user-action" }),
  };
}

const object = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const string = { type: "string" };
export const fixtureTools = [
  { name: "search_hn", description: "Search synthetic sources.", inputSchema: object({ query: string }) },
  { name: "fetch_read", description: "Read a synthetic source.", inputSchema: object({ sourceId: string }) },
  { name: "write_story", description: "Write this request's grounded draft.", inputSchema: object({
    issueId: string, slotId: string, requestId: string,
    baseContentVersion: { type: "integer" },
    headline: string, body: string, sourceIds: { type: "array", items: string },
  }) },
  { name: "hidden_app_tool", description: "App only.", inputSchema: object({}), _meta: { ui: { visibility: ["app"] } } },
];

export async function setup({ config = {}, tools = fixtureTools, onCall, onDraftComplete } = {}) {
  const trace = offlineTrace();
  const settings = { mode: "fixture", maxTurns: 10, concurrency: 1, maxQueue: 2, ...config };
  if (onDraftComplete) settings.onDraftComplete = onDraftComplete;
  const store = await createIssueStore({ trace, config: settings });
  const calls = [];
  const mcp = {
    async listTools({ actor }) {
      if (actor !== "agent") throw new Error("The caller must be an agent.");
      return structuredClone(tools);
    },
    async callTool(name, args, meta) {
      calls.push({ name, args: structuredClone(args), meta });
      await onCall?.({ name, args, meta, store });
      let data;
      if (name === "search_hn") {
        const source = {
          id: "fixture-search", title: "Synthetic source listing",
          url: "https://example.org/synthetic-source", text: "",
          evidenceLevel: "metadata", origin: "fixture",
        };
        store.addSources([source]);
        data = { records: [source] };
      } else if (name === "fetch_read") {
        const source = {
          id: "fixture-read", title: "Synthetic source text",
          url: "https://example.org/synthetic-source",
          text: "Simulated data: an editor requests a cited draft in a fixed newspaper slot.",
          evidenceLevel: "article-text", origin: "fixture",
        };
        store.addSources([source]);
        data = { records: [source] };
      } else if (name === "write_story") {
        const { state: _state, ...result } = store.completeStory(args);
        data = result;
      } else data = { observed: true };
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: { ...store.snapshot(), ...data },
      };
    },
  };
  const gateway = createGateway({ trace, config: settings });
  const runtime = createResearchAgent({ store, mcp, trace, gateway, config: settings });
  return { trace, store, calls, gateway, runtime };
}

export function storyRequest(payload) {
  const text = payload.messages.find((message) =>
    typeof message.content === "string" && message.content.startsWith("Story request:\n"),
  ).content;
  return JSON.parse(text.slice("Story request:\n".length));
}
