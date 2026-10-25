import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = [];
for (const directory of ["src", "ui", "skills", "scripts", "reference"])
  for (const name of await readdir(directory, { recursive: true })) {
    if (!/\.(mjs|jsx|html|css|md|ts)$/.test(name)) continue;
    const path = `${directory}/${name}`;
    const bytes = await readFile(path);
    files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile("source-map.json", JSON.stringify({
  schemaVersion: "session2.sources.v1", files: files.map(file => file.path),
  inventory: files, dependencies: pkg.dependencies,
  originalReference: "Historical Pi 1.0.0; runtime uses pinned published libraries."
}, null, 2) + "\n");
console.info(`Source inventory contains ${files.length} teaching files.`);
