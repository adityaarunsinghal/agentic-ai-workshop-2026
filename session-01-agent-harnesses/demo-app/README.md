## Run and change the HN agent

Ask for a reading list, inspect the requests that produced it, and approve a
saved link. Start with the free scripted preview.

### Free local preview

Use Node.js 22.19 or newer. Open a terminal in this folder, alongside
`package.json`:

```sh
npm ci
npm run dev:fixture
```

Keep the terminal running and open the printed `http://127.0.0.1:...` address.
The port is chosen automatically. Select **Try the example**, then **Ask**.
You should see source cards and the model requests under **Execution**.

The model responses and HN records are synthetic. The actual Agent, MCP client
and server, validation, approvals and interface run locally. No provider key,
workshop login or inference credit is needed.

Select a request to inspect its complete supplied context and observations.
Select **Save to reading list** and approve or deny the change. **Explore the
harness** contains fixed control, memory, scheduling and reviewer options.

Browser refresh keeps this running preview's state. Stopping the fixture clears
its conversation and saved preferences. Press **Ctrl+C** to stop it.

### Real HN and OpenRouter responses

This mode uses your own OpenRouter key and the exact model you select.
Ask Adi for local-development access by replying to a workshop email, or use
your own account. Your configured account pays for inference.

Copy `.env.example` to `.env` in this folder. Enter your key and an explicit
tool-capable OpenRouter model ID in your editor:

```text
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
```

Keep the values private. Then start:

```sh
npm run dev:local
```

Open the printed address and check the model displayed at the top before
submitting a request. Startup makes no model call. Each submitted request can
lead to several model calls and tool operations.

The local HN MCP server retrieves metadata from the official HN API. It supplies
titles and links; the application does not retrieve full articles. The model
may choose a different sequence from the scripted preview.

Local mode preserves the selected model and complete context. It makes one
provider attempt per model request and performs no automatic retry or model
fallback. After an interrupted or failed paid request, inspect your OpenRouter
activity before trying again; another attempt can incur another charge.

The application's request and output limits still apply. These limits do not
establish a dollar ceiling. Use an appropriately capped provider key.
Local code runs with your computer's permissions.

Saved preferences and reading lists live in `.local/preferences.sqlite`.
Conversation history and timers belong to the running process. Set
`LOCAL_WORKDIR` in your private environment to use a different local data
directory. Each copied project uses its own default directory.

Node 22 may print an experimental SQLite warning. The printed preview address
and the application's state determine whether startup succeeded.

### Make an edit

1. Begin with `createTools()` and `SYSTEM_PROMPT_FOR_HN_BRIEFING_AGENT` in
   [agent/app.mjs](agent/app.mjs).
2. Change one instruction or add a small read-only tool.
3. Restart the preview after changing server code. Refresh after changing
   [the interface](ui/index.html), [browser code](ui/browser.mjs) or
   [styles](ui/style.css).
4. Inspect an outgoing request to check the instructions and tool declaration.
   Use real mode to evaluate how a model responds to your change.

The scripted preview follows a fixed recipe. It can show an edited request
payload and exercise application behavior, but it cannot evaluate a new
prompt's quality or choose an arbitrary new tool.

For example, add this object to the array returned by `createTools()`:

```js
{
  name: "get_current_time",
  description: "Read the current time in UTC.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    return {
      content: [{ type: "text", text: new Date().toISOString() }],
    };
  },
}
```

The model receives the name, description and schema. The `execute` function
runs in this application when the harness permits the call. In real mode, ask
for the current time and inspect the tool result in the following request.

### Read one request through the code

| File | Start with |
| --- | --- |
| [agent/app.mjs](agent/app.mjs) | `createTools`, `prepareBriefingContext`, `authorizeUserPreferencesChange`, `prepareAgent` |
| [agent/pi-mini.mjs](agent/pi-mini.mjs) | `Agent.prompt`, `runLoop`, `streamAssistantResponse`, `executePreparedToolCall` |
| [agent/workshop.mjs](agent/workshop.mjs) | `providerContext` and the hosted broker adapter |
| [local/workshop.mjs](local/workshop.mjs) | The explicit local model transport |
| [local/hn.mjs](local/hn.mjs) | MCP discovery and source retrieval |
| [support/user-preferences.mjs](support/user-preferences.mjs) | Propose, approve and acknowledge saved changes |
| [skills/hn-briefing.md](skills/hn-briefing.md) | The complete recipe loaded on demand |

A model request returns one response. A turn includes that response and its
tool work. An Agent run can contain several turns. A conversation can contain
several runs. A workshop visit is the platform's hosting and funding lifetime;
the platform also calls that unit a run.

Pi-mini uses sequential tool execution, batch validation and explicit
checkpoints. Original Pi supports additional features, including parallel
tools, richer queues and session management. Application approvals, saved
preferences, scheduling and the reviewer are composed around the miniature.
The original Pi files in `reference/` retain their own license and hashes.

### Check your changes

```sh
npm run build
npm test
```

Build checks syntax, runtime assets and source navigation. The tests exercise
the loop, local adapters, approvals, persistence, cancellation and packaging
with synthetic data. Packaging checks require [uv](https://docs.astral.sh/uv/getting-started/installation/).

If you rename a mapped function, update its anchor in
[scripts/sources.mjs](scripts/sources.mjs). If you add public source outside the
existing directories, declare it in [package-files.json](package-files.json).
The source map is regenerated from current files during the build.

### Create a fresh upload ZIP

Install uv, choose your unique app address in My app, and put that slug in
`workshop-app.json`. From this folder:

```sh
npm run package:workshop
```

The command builds first, then writes a fresh archive under `.local/packages/`.
It prints the exact path and SHA-256. A sibling manifest lists the included
source files and exclusions. Earlier differing archives remain recoverable in
the output folder's dated trash directory.

To choose the destination:

```sh
npm run package:workshop -- --output ../my-agent.zip
```

To check the exact ZIP in a fresh directory:

```sh
npm run verify:package -- --zip ../my-agent.zip
```

Verification installs the locked dependencies, builds the extracted source and
runs the retained tests. It makes no paid model requests. This establishes local
package behavior; the platform performs its own Linux build and readiness check.

Review the printed inventory. Keep keys and private data in `.env` or `.local/`,
outside source files. The ZIP excludes installed dependencies, local state,
private environment files, logs and earlier archives. Include new public source
through `package-files.json`.

Upload the resulting file in My app. Keep `workshop-app.json` at the archive
root. For a replacement, keep the same slug and create a fresh archive.

### Hosted execution

`npm start` is the workshop startup path. The platform supplies the broker
configuration and visitor allowance. Local fixture and personal OpenRouter
modes are refused inside a hosted workshop runtime.

Local `.env` values never select the hosted payer. Model choice and funding
come from the portal. A failed replacement leaves the earlier published app
available while you correct the new source.

### If something stops

| What you see | Next step |
| --- | --- |
| “Start this app through the workshop portal” after `npm start` | Use `npm run dev:fixture` or configure `npm run dev:local` for laptop work. |
| Missing OpenRouter configuration | Fill both private environment variables before starting real mode. |
| HN or provider error | Inspect the failed request and evidence. A failed live call stays failed. |
| Source navigation error | Update the corresponding anchor in `scripts/sources.mjs`, then rebuild. |
| HN-only declaration error | Update the app's tool adapter and build declaration check together when changing its sources. |
| Preferences conflict | Reload saved preferences and review the proposed change again. |
| Request limit or local visit expiry | Keep any needed work, then restart the local process. Real saved preferences survive. |

For help, include what you tried, the relevant error and a public-safe trace.
Keep keys, private documents and account credentials out of shared diagnostics.
