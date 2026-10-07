import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
async function project() {
  const directory = resolve(root, ".local/package-tests", randomUUID());
  const source = resolve(directory, "source");
  await mkdir(directory, { recursive: true });
  await mkdir(source);
  const publicSource = (path) => {
    const parts = relative(root, path).split(sep);
    return !parts.some(
      (part) =>
        [
          ".local",
          "node_modules",
          ".git",
          "tmp",
          "__pycache__",
          ".ruff_cache",
        ].includes(part) ||
        (part.startsWith(".env") && part !== ".env.example"),
    );
  };
  for (const name of await readdir(root)) {
    const path = resolve(root, name);
    if (publicSource(path))
      await cp(path, resolve(source, name), {
        recursive: true,
        filter: publicSource,
      });
  }
  return { directory, source, zip: resolve(directory, "app.zip") };
}
function packageSource(source, zip) {
  const result = spawnSync(
    "uv",
    ["run", "scripts/package.py", "build", "--output", zip],
    { cwd: source, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return result;
}
function archiveNames(zip) {
  const result = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "python",
      "-c",
      "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
      zip,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("fresh packaging removes retired source and excludes private local files", async () => {
  const { source, zip } = await project();
  await writeFile(
    resolve(source, "agent/obsolete.mjs"),
    "export const old = true;\n",
  );
  await writeFile(
    resolve(source, ".env"),
    "OPENROUTER_API_KEY=synthetic-private-value\n",
  );
  await mkdir(resolve(source, ".local"), { recursive: true });
  await writeFile(
    resolve(source, ".local/private.json"),
    '{"private":"synthetic"}\n',
  );
  let result = packageSource(source, zip);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(archiveNames(zip).includes("agent/obsolete.mjs"));
  await rename(
    resolve(source, "agent/obsolete.mjs"),
    resolve(source, ".local/obsolete.mjs"),
  );
  result = packageSource(source, zip);
  assert.equal(result.status, 0, result.stderr);
  const names = archiveNames(zip);
  assert.ok(!names.includes("agent/obsolete.mjs"));
  assert.ok(!names.includes(".env"));
  assert.ok(!names.some((name) => name.startsWith(".local/")));
  assert.ok(names.includes(".env.example"));
  assert.ok(names.includes("workshop-app.json"));
  const manifest = JSON.parse(
    await readFile(zip.replace(/\.zip$/, ".manifest.json")),
  );
  assert.equal(manifest.entries.length, names.length);
});

test("the same source produces the same archive bytes", async () => {
  const { source, zip, directory } = await project();
  const second = resolve(directory, "second.zip");
  assert.equal(packageSource(source, zip).status, 0);
  assert.equal(packageSource(source, second).status, 0);
  assert.deepEqual(await readFile(zip), await readFile(second));
});

test("packaging rejects undeclared root source, key files and filled example credentials", async () => {
  const { source, zip } = await project();
  const cases = [
    [
      "extra.md",
      "A public file that needs an inclusion decision.",
      /Undeclared root source/,
    ],
    ["agent/private.key", "synthetic credential fixture", /credential files/],
  ];
  await mkdir(resolve(source, ".local/rejected"), { recursive: true });
  for (const [name, value, expected] of cases) {
    const path = resolve(source, name);
    await writeFile(path, value);
    const result = packageSource(source, zip);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    await rename(path, resolve(source, ".local/rejected", basename(name)));
  }
  await writeFile(
    resolve(source, ".env.example"),
    "OPENROUTER_API_KEY=synthetic-value\n",
  );
  const result = packageSource(source, zip);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Leave credential values empty/);
});

test("included symlinks cannot pull a file from outside the project", async () => {
  const { source, zip, directory } = await project();
  const outside = resolve(directory, "outside.txt");
  await writeFile(outside, "synthetic outside file");
  await symlink(outside, resolve(source, "agent/linked.mjs"));
  const result = packageSource(source, zip);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linked or escaping/);
});
