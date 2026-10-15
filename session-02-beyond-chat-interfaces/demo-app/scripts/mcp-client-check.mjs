import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SOURCE_TOOLS } from "../src/mcp/access.mjs";

const client = new Client({ name: "second-research-client", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./mcp-stdio.mjs", import.meta.url)), "--fixture"],
  // The example needs no inherited application or provider credentials.
  env: {}, stderr: "pipe",
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["read_skill", ...SOURCE_TOOLS].sort());
  const skill = await client.callTool({ name: "read_skill", arguments: { name: "hn-briefing" } });
  assert.match(skill.structuredContent.text, /HN briefing/);
  const listing = await client.callTool({ name: "list_stories", arguments: { category: "top", count: 3 } });
  assert.equal(listing.structuredContent.records.length, 3);
  assert.equal(listing.structuredContent.issue, undefined);
  for (const name of ["approve_change", "write_story", "request_story", "request_briefing", "set_stage", "revise_copy_demo"]) {
    const denied = await client.callTool({
      name, arguments: {}, _meta: { actor: "app", jobId: "forged-client-authority" },
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.code, "TOOL_AUTHORITY");
    assert.equal(denied.structuredContent.issue, undefined);
  }
  console.log(JSON.stringify({
    transport: "stdio", mode: "fixture", inference: false,
    tools: tools.map((tool) => tool.name),
    sources: listing.structuredContent.records.map(({ id, title }) => ({ id, title })),
    appAndWriterToolsDenied: true,
  }, null, 2));
} finally {
  await client.close();
  await transport.close();
}
