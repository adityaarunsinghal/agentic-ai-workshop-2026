/** Opt-in local UI updates. The inference process and its state stay alive. */
import { watch } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const endpoint = "/__workshop_ui_reload";
const client = `(() => {
  const version = document.currentScript.dataset.version;
  let checking = false, dispatched = false;
  async function check() {
    if (checking || dispatched || document.hidden) return;
    checking = true;
    try {
      const response = await fetch("${endpoint}", {
        cache: "no-store", signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return;
      const current = await response.json();
      if (current.version === version) return;
      const active = document.activeElement;
      if (active?.matches("input, textarea, select") || active?.isContentEditable) return;
      dispatched = true;
      const event = new CustomEvent("workshop:ui-update", { cancelable: true });
      if (window.dispatchEvent(event)) window.location.reload();
    } catch {
      // Keep the current UI during a build failure or temporary disconnection.
    } finally { checking = false; }
  }
  const timer = setInterval(check, 1500);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
})();`;

export function createUiReload({ root, script, ignore = [] }) {
  let version = randomUUID(), timer, child, dirty = false, closed = false;
  function schedule() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(build, 250);
  }
  function build() {
    if (closed || child || !dirty) return;
    dirty = false;
    let output = "", settled = false;
    child = spawn(process.execPath, [script], {
      cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk) => { output = (output + chunk).slice(-24000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    function finish(error) {
      if (settled) return;
      settled = true;
      child = null;
      if (closed) return;
      if (error) console.error(`UI rebuild failed; keeping the current page.\n${output || error.message}`);
      else if (!dirty) {
        version = randomUUID();
        console.info("UI rebuilt. Open browsers will reload when editing is idle.");
      }
      if (dirty) schedule();
    }
    child.once("error", finish);
    child.once("exit", (code) => finish(code === 0 ? null : new Error(`Build exited ${code}`)));
  }
  const watcher = watch(join(root, "ui"), { recursive: true }, (_event, filename) => {
    const name = String(filename ?? "").replaceAll("\\", "/");
    if (!name || ignore.includes(name) || /(?:^|\/)\.[^/]+$|(?:~|\.swp|\.next)$/.test(name)) return;
    schedule();
  });
  watcher.on("error", (error) => console.error(`UI watcher: ${error.message}`));
  console.info("Automatic UI rebuild and browser reload enabled.");
  schedule();
  return {
    inject(html) {
      return String(html).replace("</head>",
        `<script src="${endpoint}.js" data-version="${version}" defer></script></head>`);
    },
    response(path) {
      if (path === endpoint) return {
        type: "application/json", body: JSON.stringify({ version }),
      };
      if (path === `${endpoint}.js`) return {
        type: "text/javascript; charset=utf-8", body: client,
      };
      return null;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      child?.kill("SIGTERM");
    },
  };
}
