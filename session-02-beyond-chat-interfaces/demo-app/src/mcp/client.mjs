// LEARNING: connectMcp uses the official client and an in-memory MCP transport.
// The agent calls this interface; server.mjs owns the tools and their effects.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Trusted application bridge. Authority travels in process-local trace context,
 * never in a client name, tool argument, or remotely supplied MCP metadata.
 * The canonical server records calls. Observation reads therefore stay silent.
 */
export async function connectMcp(server, trace) {
  if (typeof trace.withContext !== "function") {
    throw new TypeError(
      "The application MCP bridge needs process-local caller context.",
    );
  }
  const client = new Client(
    { name: "session-02-host", version: "1.0.0" },
    {
      capabilities: { experimental: { "io.modelcontextprotocol/ui": {} } },
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const span = trace.start("mcp", {
    method: "initialize",
    purpose: "Connect the canonical tool server",
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    span.finish({ result: { connected: true } });
  } catch (error) {
    span.finish({ status: "failed", error: error.message });
    await client.close();
    throw error;
  }
  const asCaller = (meta, fn) => {
    return trace.withContext(
      {
        jobId: undefined,
        requestId: undefined,
        slotId: undefined,
        ...meta,
        actor: meta.actor === "agent" ? "agent" : "app",
      },
      fn,
    );
  };
  return {
    client,
    async listTools(meta = {}) {
      return asCaller(meta, async () => {
        return (await client.listTools()).tools;
      });
    },
    callTool(name, args = {}, meta = {}) {
      return asCaller(meta, () => {
        return client.callTool({ name, arguments: args }, undefined, {
          timeout: 120000,
          ...(meta.signal ? { signal: meta.signal } : {}),
        });
      });
    },
    readResource(uri) {
      return asCaller({}, () => {
        return client.readResource({ uri });
      });
    },
    close: () => {
      return client.close();
    },
  };
}
