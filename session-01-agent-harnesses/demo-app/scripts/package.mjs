/** Build the current source, then create a fresh, verified upload archive. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--output" && args[1])) {
  console.error("Usage: npm run package:workshop -- [--output /path/app.zip]");
  process.exit(1);
}
const manifest = JSON.parse(
  readFileSync(new URL("../workshop-app.json", import.meta.url)),
);
if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(manifest.slug))
  throw new Error("Choose a valid slug in workshop-app.json before packaging.");
const output = args.length
  ? resolve(args[1])
  : resolve(root, ".local/packages", `${manifest.slug}.zip`);
if (!output.endsWith(".zip")) throw new Error("The output must end with .zip.");
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT" && command === "uv")
    throw new Error("Install uv to package the source ZIP. See README.md.");
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ["scripts/check-runtime.mjs"]);
run("uv", ["run", "scripts/package.py", "build", "--output", output]);
