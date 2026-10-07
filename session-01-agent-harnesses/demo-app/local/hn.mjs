/**
 * The pinned MCP client and server exchange real protocol messages in process.
 * Only the live source adapter contacts the public HN API.
 */
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HarnessError } from "../agent/pi-mini.mjs";
import { requireHnRecord } from "../support/user-preferences.mjs";
import { fixtureRecords } from "./fixture.mjs";

export const hnTool = {
  name: "list_stories",
  description:
    "Read 1..12 HN story metadata records with titles and links. Full article text is unavailable.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      category: { type: "string", enum: ["top", "new", "best"] },
      count: { type: "integer", minimum: 1, maximum: 12 },
    },
    required: ["category", "count"],
    additionalProperties: false,
  },
};
const validArguments = new Ajv({ strict: false }).compile(hnTool.inputSchema);

/** Reject an oversized body instead of accepting a shortened source. */
async function sourceJson(fetcher, path, signal) {
  const response = await fetcher(
    `https://hacker-news.firebaseio.com/v0/${path}`,
    { redirect: "error", signal },
  );
  if (!response.ok) throw new Error(`HN returned HTTP ${response.status}.`);
  if (!response.body) throw new Error("HN returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 512 * 1024)
        throw new Error("The complete HN response exceeds 512 KiB.");
      chunks.push(next.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readHnStories(args, fetcher, signal) {
  if (!validArguments(args))
    throw new HarnessError(
      "HN_ARGUMENTS",
      "Use a category and count from 1 to 12.",
    );
  const ids = await sourceJson(fetcher, `${args.category}stories.json`, signal);
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("HN returned an invalid story list.");
  const selected = ids.slice(0, args.count);
  const records = [];
  const losses = [];
  for (const id of selected) {
    signal?.throwIfAborted();
    try {
      const raw = await sourceJson(fetcher, `item/${id}.json`, signal);
      if (raw === null || raw.deleted || raw.dead)
        throw new Error("Story is unavailable.");
      if (
        raw.id !== id ||
        raw.type !== "story" ||
        typeof raw.title !== "string" ||
        !Number.isSafeInteger(raw.time) ||
        raw.time <= 0 ||
        (raw.url !== undefined && typeof raw.url !== "string")
      )
        throw new Error("Story metadata is invalid.");
      const source = requireHnRecord({
        id: `hn-${id}`,
        kind: "hn",
        upstreamId: String(id),
        title: raw.title,
        canonicalUrl: raw.url ?? `https://news.ycombinator.com/item?id=${id}`,
        retrievedAt: new Date().toISOString(),
        publishedAt: new Date(raw.time * 1000).toISOString(),
        evidenceLevel: "metadata",
        completeness: { completeForRequestedScope: true },
        contentDigest: createHash("sha256")
          .update(JSON.stringify(raw))
          .digest("hex"),
        origin: "live",
      });
      records.push(source);
    } catch (error) {
      signal?.throwIfAborted();
      losses.push({ upstreamId: String(id), reason: String(error.message) });
    }
  }
  if (selected.length < args.count)
    losses.push({ reason: "HN returned fewer story IDs than requested." });
  return { records, losses };
}

export function createLocalHn({ fixture, fetcher = fetch }) {
  const server = new Server(
    { name: fixture ? "fixture-hn" : "local-hn", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const client = new Client({ name: "local-hn-client", version: "1.0.0" });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [hnTool],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (
      request.params.name !== "list_stories" ||
      !validArguments(request.params.arguments)
    )
      throw new Error("Use list_stories with its advertised arguments.");
    const args = request.params.arguments;
    const result = fixture
      ? {
          records: structuredClone(fixtureRecords.slice(0, args.count)),
          losses:
            args.count > fixtureRecords.length
              ? [{ reason: "The fixture contains three synthetic stories." }]
              : [],
        }
      : await readHnStories(
          args,
          fetcher,
          AbortSignal.any([extra.signal, AbortSignal.timeout(30000)]),
        );
    const batch = {
      schemaVersion: "newspaper.sources.v1",
      records: result.records,
      completeForRequestedScope: result.losses.length === 0,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(batch) }],
      structuredContent: batch,
      _meta: { "newspaper.sources": { fixture, losses: result.losses } },
    };
  });
  let connected;
  async function discover(signal) {
    connected ??= (async () => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    })();
    await connected;
    const catalog = await client.listTools({}, { signal, timeout: 5000 });
    return catalog.tools.find((tool) => tool.name === "list_stories");
  }
  return {
    discover,
    async listStories(args, signal) {
      await discover(signal);
      return client.callTool(
        { name: "list_stories", arguments: args },
        undefined,
        { signal, timeout: 30000 },
      );
    },
    async close() {
      await connected?.catch(() => {});
      await client.close();
      await server.close();
    },
  };
}
