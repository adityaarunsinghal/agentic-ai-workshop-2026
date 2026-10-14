/** Keep the public URL stable while bundling display libraries beside the app. */
import { build } from "esbuild";
import { writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "ui/browser.mjs");
const result = await build({
  absWorkingDir: root, entryPoints: ["ui/main.mjs"], outfile: output,
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  minify: true, legalComments: "inline", write: false,
});
await writeFile(`${output}.next`, result.outputFiles[0].contents);
await rename(`${output}.next`, output);
console.info("Browser display bundle rebuilt at the existing /browser.mjs URL.");
