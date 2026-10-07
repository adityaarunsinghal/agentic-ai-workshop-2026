/**
 * Capture complete pinned Pi files, then verify source bytes and navigation.
 * capture requires an explicit local archive; normal verification is offline.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const revision = "a13d35a742c6ef8462812a28fbe1d8c8b7431c32";
const prefix = "earendil-works-pi-a13d35a";
const original = [
  "LICENSE",
  "packages/agent/src/agent.ts",
  "packages/agent/src/agent-loop.ts",
  "packages/agent/src/types.ts",
  "packages/ai/src/types.ts",
  "packages/ai/src/utils/event-stream.ts",
  "packages/ai/src/utils/transcript.ts",
  "packages/ai/src/api/openai-completions.ts",
  "packages/coding-agent/src/core/system-prompt.ts",
  "packages/coding-agent/src/core/session-manager.ts",
  "packages/coding-agent/docs/how-pi-works.md",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reference = (name) => `reference/pi-1.0.0/${name}`;
const manifestPath = path.join(root, "reference/manifest.json");

const targets = [
  [
    "agent",
    "Conversation state",
    "agent/pi-mini.mjs",
    "export class Agent",
    original[1],
    "export class Agent",
  ],
  [
    "control",
    "Control and the turn loop",
    "agent/pi-mini.mjs",
    "export async function runLoop(",
    original[2],
    "async function runLoop(",
  ],
  [
    "context",
    "Request context",
    "agent/app.mjs",
    "async function prepareBriefingContext(",
    original[2],
    "async function streamAssistantResponse(",
  ],
  [
    "authority",
    "Permission before execution",
    "agent/app.mjs",
    "async function authorizeUserPreferencesChange(",
    original[2],
    "async function prepareToolCall(",
  ],
  [
    "tools",
    "Tool execution",
    "agent/pi-mini.mjs",
    "export async function executePreparedToolCall(",
    original[2],
    "async function executePreparedToolCall(",
  ],
  [
    "stream",
    "One evolving response",
    "agent/pi-mini.mjs",
    "export function createAssistantMessageEventStream(",
    original[5],
    "export class AssistantMessageEventStream",
  ],
  [
    "provider",
    "Provider conversion",
    "agent/workshop.mjs",
    "export function providerContext(",
    original[7],
    "export function convertMessages(",
  ],
  [
    "memory",
    "Stored information and context",
    "support/user-preferences.mjs",
    "export function createUserPreferences(",
    original[9],
    "function buildSessionPath(",
  ],
  [
    "skills",
    "Reusable instructions",
    "agent/app.mjs",
    "function createTools(",
    original[8],
    "export function buildSystemPromptSections(",
  ],
  [
    "duration",
    "Cancellation and idle",
    "agent/pi-mini.mjs",
    "  waitForIdle()",
    original[1],
    "waitForIdle(): Promise<void>",
  ],
  [
    "queues",
    "Steering and follow-up",
    "agent/pi-mini.mjs",
    "  steer(message)",
    original[1],
    "steer(message: AgentMessage)",
  ],
  [
    "recovery",
    "Continue from a checkpoint",
    "agent/pi-mini.mjs",
    "  async continue(checkpointId)",
    original[1],
    "async continue(): Promise<void>",
  ],
  [
    "topology",
    "A separate reviewer",
    "agent/app.mjs",
    "async function reviewDraft(",
    original[1],
    "export class Agent",
  ],
  [
    "trigger",
    "Application scheduling",
    "agent/app.mjs",
    "function scheduleBriefing(",
    original[1],
    "async prompt(input: string, images?",
  ],
  [
    "interface",
    "Events and presentation",
    "ui/view.mjs",
    "function acceptAgentEvent(",
    original[1],
    "subscribe(listener:",
  ],
];

function locate(filename, needle) {
  const text = fs.readFileSync(path.join(root, filename), "utf8");
  const matching = text
    .split("\n")
    .flatMap((line, index) => (line.includes(needle) ? [index + 1] : []));
  if (matching.length !== 1)
    throw new Error(
      `Expected one ${needle} in ${filename}; found ${matching.length}.`,
    );
  return { path: filename, line: matching[0], sha256: digest(text) };
}

function navigation() {
  const concepts = targets.map(
    ([id, title, local, needle, upstream, originalNeedle]) => ({
      id,
      title,
      local: locate(local, needle),
      original: locate(reference(upstream), originalNeedle),
      ...(id === "memory"
        ? {
            difference:
              "The app's user-preferences are saved in a conditional object store. Pi's session manager records conversation trees.",
          }
        : {}),
      ...(id === "trigger"
        ? {
            difference:
              "One-shot scheduling belongs to this application and calls the harness when due.",
          }
        : {}),
      ...(id === "topology"
        ? {
            difference:
              "This application composes two Agent instances. The core does not create a reviewer automatically.",
          }
        : {}),
      ...(id === "recovery"
        ? {
            difference:
              "Pi-mini requires its saved checkpoint identity and retains completed tool progress. Pi continues from its current transcript. Provider retries belong to the workshop broker.",
          }
        : {}),
    }),
  );
  return {
    edition: "Pi 1.0.0",
    revision,
    repository: "https://github.com/earendil-works/pi",
    concepts,
    files: [
      ...new Set([
        ...concepts.map((item) => item.local.path),
        ...original.map(reference),
        "agent/app.mjs",
        "support/action-fields.mjs",
        "agent/pi-mini.mjs",
        "agent/workshop.mjs",
        "support/stream.mjs",
        "support/recovery.mjs",
        "support/user-preferences.mjs",
        "support/limits.mjs",
        "ui/view.mjs",
        "ui/browser.mjs",
        "ui/index.html",
        "ui/style.css",
        "workshop-app.json",
        "skills/hn-briefing.md",
      ]),
    ],
  };
}

const capture = process.argv[2] === "capture";
if (capture) {
  const option = process.argv.indexOf("--archive");
  if (option < 0 || !process.argv[option + 1])
    throw new Error(
      "capture requires --archive /absolute/path/to/pi-v1.0.0.tgz",
    );
  const archive = path.resolve(process.argv[option + 1]);
  const files = {};
  for (const name of original) {
    const bytes = execFileSync("tar", ["-xOf", archive, `${prefix}/${name}`], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const destination = path.join(root, reference(name));
    if (
      fs.existsSync(destination) &&
      digest(fs.readFileSync(destination)) !== digest(bytes)
    )
      throw new Error(`Existing original source changed: ${name}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    files[reference(name)] = { sha256: digest(bytes), bytes: bytes.length };
  }
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: "1.0.0",
        revision,
        archiveSha256: digest(fs.readFileSync(archive)),
        files,
      },
      null,
      2,
    ) + "\n",
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.revision !== revision) throw new Error("Pi revision changed.");
for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = fs.readFileSync(path.join(root, name));
  if (digest(bytes) !== expected.sha256 || bytes.length !== expected.bytes)
    throw new Error(`Original source integrity failed: ${name}`);
}
const mapped = navigation();
const mapPath = path.join(root, "source-map.json");
if (capture || process.argv.includes("--update-map"))
  fs.writeFileSync(mapPath, JSON.stringify(mapped, null, 2) + "\n");
else {
  const current = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  if (JSON.stringify(current) !== JSON.stringify(mapped))
    throw new Error(
      "Source navigation changed. Run verify:sources -- --update-map.",
    );
  for (const name of mapped.files)
    if (!fs.statSync(path.join(root, name)).isFile())
      throw new Error(`Source reader file missing: ${name}`);
}
console.info(
  `Verified ${original.length} original files and ${targets.length} concept mappings.`,
);
