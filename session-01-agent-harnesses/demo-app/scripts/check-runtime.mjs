/** Build/readiness check: parse source and validate the manifest without IO to services. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const directory of ["agent", "support", "ui", "scripts"]) {
  const folder = path.join(root, directory);
  for (const name of fs
    .readdirSync(folder, { recursive: true })
    .filter((name) => name.endsWith(".mjs")))
    execFileSync(process.execPath, ["--check", path.join(folder, name)], {
      stdio: "pipe",
    });
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "workshop-app.json"), "utf8"),
);
// Generate the line map from committed source; original reference bytes stay fixed.
execFileSync(
  process.execPath,
  [path.join(root, "scripts/sources.mjs"), "--update-map"],
  { stdio: "inherit" },
);
if (
  manifest.schemaVersion !== "workshop.app.v1" ||
  JSON.stringify(manifest.network.classServices) !== '["hn"]' ||
  manifest.network.publicWeb ||
  manifest.network.publicHttpsDomains.length
)
  throw new Error("The source declaration must remain HN-only.");
for (const name of [
  "ui/index.html",
  "ui/browser.mjs",
  "ui/style.css",
  "ui/fonts/montserrat.woff2",
  "ui/fonts/OFL.txt",
  "source-map.json",
  "skills/hn-briefing.md",
])
  if (!fs.statSync(path.join(root, name)).isFile())
    throw new Error(`Runtime asset missing: ${name}`);
execFileSync(process.execPath, [path.join(root, "scripts/sources.mjs")], {
  stdio: "inherit",
});
console.info("Runtime source and assets passed the non-spending build check.");
