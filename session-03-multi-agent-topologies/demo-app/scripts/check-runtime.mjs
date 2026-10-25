import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(new URL("../workshop-app.json", import.meta.url), "utf8"));
if (manifest.schemaVersion !== "workshop.app.v1" || !manifest.runtime.languages.includes("node22"))
  throw new Error("Keep the portable workshop Node contract.");
if (process.argv.includes("--check-hosted-transport"))
  await import("./check-source-transport.mjs");
await import("./build.mjs");
await import("./sources.mjs");
console.info("Runtime, MCP App resources and source inventory are ready without model calls.");
