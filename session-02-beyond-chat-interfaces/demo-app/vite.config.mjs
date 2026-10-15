import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(directory, "ui");
const outDir = resolve(directory, "dist");

// Run editor, host, sandbox in that order. Only the first build clears dist.
// Exporting the factory also lets the parent's build script call Vite directly.
export function createUiConfig(input = process.env.INPUT || "host") {
  const entries = { editor: "editor-view.html", host: "index.html", sandbox: "sandbox.html" };
  if (!entries[input]) throw new Error("INPUT must be editor, host, or sandbox.");
  const singlefile = input !== "host";
  return {
    root,
    base: "./",
    publicDir: false,
    plugins: [react(), ...(singlefile ? [viteSingleFile()] : [])],
    server: {
      host: "0.0.0.0",
      proxy: { "/api": process.env.UI_API_ORIGIN || "http://127.0.0.1:8088" },
    },
    build: {
      outDir,
      emptyOutDir: input === "editor",
      target: "es2022",
      ...(singlefile ? { assetsInlineLimit: Infinity } : {}),
      rollupOptions: { input: resolve(root, entries[input]) },
    },
  };
}

export default defineConfig(() => createUiConfig());
