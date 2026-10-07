/** Exercise the exact archive in a fresh directory using public commands. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--zip")
  throw new Error("Usage: npm run verify:package -- --zip /path/app.zip");
const source = resolve(args[1]);
const destination = resolve(root, ".local/package-check", randomUUID());
mkdirSync(destination, { recursive: true });
const environment = Object.fromEntries(
  [
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "SystemRoot",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
environment.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`;
function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    env: environment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(
  "uv",
  [
    "run",
    "scripts/package.py",
    "extract",
    "--zip",
    source,
    "--destination",
    destination,
  ],
  root,
);
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli))
  throw new Error("Run this verifier through npm run verify:package.");
run(
  process.execPath,
  [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  destination,
);
run(process.execPath, [npmCli, "run", "build"], destination);
run(process.execPath, [npmCli, "test"], destination);
const receipt = {
  zip: source,
  sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
  verifiedAt: new Date().toISOString(),
  node: process.version,
  destination,
  checks: ["clean install", "source build", "behavioral tests"],
};
mkdirSync(resolve(destination, ".local"), { recursive: true });
writeFileSync(
  resolve(destination, ".local/verification.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.info(JSON.stringify(receipt, null, 2));
