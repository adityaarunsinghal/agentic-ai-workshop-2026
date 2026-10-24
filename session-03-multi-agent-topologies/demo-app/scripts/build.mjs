import { build } from "vite";
import { readdir, mkdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
for (const directory of ["src", "scripts"])
  for (const file of await readdir(directory, { recursive: true }))
    if (file.endsWith(".mjs"))
      execFileSync(process.execPath, ["--check", resolve(directory, file)]);
await mkdir("dist", { recursive: true });
for (const input of ["editor", "host", "sandbox"]) {
  process.env.INPUT = input;
  await build({ configFile: resolve("vite.config.mjs") });
}
await import("./sources.mjs");
console.info("Session 3 runtime and MCP App bundles built without model calls.");
