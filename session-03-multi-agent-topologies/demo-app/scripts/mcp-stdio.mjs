import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createIssueStore } from "../src/domain/store.mjs";
import { createMcpServer } from "../src/mcp/server.mjs";
import { createSources } from "../src/sources/service.mjs";
import { createTrace } from "../src/trace.mjs";

// A second MCP client gets a fresh, fixture-only source service. No user file,
// gateway, writer, approval tool, editor resource, or inference key is attached.
if (process.argv.slice(2).some((arg) => arg !== "--fixture"))
  throw new Error("This teaching server accepts only --fixture.");
const config = { mode: "fixture" };
const trace = createTrace();
trace.fetch = async () => { throw new Error("Network is disabled in this research fixture."); };
const store = await createIssueStore({ trace, config });
const sources = createSources({ store, trace, config });
const server = createMcpServer({ store, trace, sources, config }, { researchOnly: true });
await server.connect(new StdioServerTransport());
