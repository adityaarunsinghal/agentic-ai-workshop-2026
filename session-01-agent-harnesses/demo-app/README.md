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

Select a request, then open a record to load its complete supplied context or
observation. **Details** has Teaching and Protocol views, search and pages for
older records. It loads full sanitized records only when you open them.
Select **Save to reading list** and approve or deny the change. **Explore the
harness** contains fixed control, memory, scheduling and reviewer options.

Browser refresh keeps this running preview's state. Stopping the fixture clears
its conversation and saved preferences. Press **Ctrl+C** to stop it.

### Use your workshop allowance locally

After installing dependencies, preserve any existing private configuration:

```sh
cp -n .env.example .env
```

Open **Account → Local development token** in the class app store. Choose
funding, a model and a ceiling at least as large as the displayed minimum.
Create a token and put these values in `.env` using your editor:

```text
WORKSHOP_DEVELOPMENT_URL=
WORKSHOP_DEVELOPMENT_TOKEN=
```

Use Account's gateway, ending in `/api/development`, then run:

```sh
npm run dev:development
```

Open the printed local address. The banner shows the selected funding and the
header shows the model/profile. Startup checks the connection without making
a model request; submitting a task spends the selected allowance.

A token captures the app policy at issuance. Save complete My app settings
before issuing a token if your project needs additional services or storage.
Issue a new token after changing that policy. Save the Token ID and revoke old
tokens through Account; stopping this server does not revoke them.

The broker keeps its model, payer, request limits and recovery rules. If the
token does not declare HN or matching storage, this app uses local HN access
and `.local/preferences.sqlite`. An advertised service that fails stays failed.
Tokens remain on the server. Local code runs with this computer's permissions.

### Optional: use your own OpenRouter account

Put `OPENROUTER_API_KEY` and an explicit tool-capable `OPENROUTER_MODEL` in your
private `.env`, then run:

```sh
npm run dev:local
```

This mode charges that OpenRouter account. Use a capped key. It sends requests
to OpenRouter and does not switch to workshop funding.

### State and restarting

Refresh keeps the running conversation. Restarting the server clears its
conversation and timers. Real local preferences survive in
`.local/preferences.sqlite`; `LOCAL_WORKDIR` selects another private directory.
Workshop development uses broker storage only when the matching scope is
advertised. Execution records in real local and development modes are stored
separately under `.local/execution/`. Fixture/hosted archives are temporary.
Clearing execution logs changes neither saved preferences nor spending.

Fixture output is scripted and free. Stop any local mode with **Ctrl+C**.
Node 22's experimental SQLite warning alone does not mean startup failed.

### Make an edit

1. Begin with `createTools()` and `SYSTEM_PROMPT_FOR_HN_BRIEFING_AGENT` in
   [agent/app.mjs](agent/app.mjs).
2. Change one instruction or add a small read-only tool.
3. Restart the preview after changing server code. Refresh after changing
   [the interface](ui/index.html), [browser code](ui/main.mjs) or
   [styles](ui/style.css). Rebuild browser code with `npm run build`, or set
   `LOCAL_UI_HOT_RELOAD=1` for automatic UI rebuilds in development/personal mode.
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

Execution keeps the familiar request groups with a small timeline of model,
tool and harness activity. The browser and event stream receive compact
summaries. Expanding a record loads the server's sanitized original, including
its raw event name. A selected record's **Load outcome record** opens its
correlated result. Collapsing a record discards its full browser copy.

MCP rows observe actual SDK initialization, discovery and tool calls. Local
MCP exchanges messages in memory; the live local source then fetches the HN
API. Hosted MCP uses Streamable HTTP. These are SDK operation records, not a
packet capture. Errors, approvals, cancellation, context and observations stay
reachable through Details, including Protocol view. Token deltas update the
answer instead of creating a row for each fragment.

The archive reports incomplete capture if a storage or queue bound is reached
or an I/O operation fails. Diagnostics do not stop the Agent or free a request
slot. Check status and Resume use separate application state, so hiding or
retiring timeline rows cannot change recovery authority.

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
If you rename the npm project or change dependencies, run
`npm install --package-lock-only` and retain the updated lockfile.

JSON records, approvals, saved-state details, Markdown code blocks and source
files use syntax colors. Encoded JSON and fenced code inside record strings
have optional readable views. Formatting changes only the display; original
records and model/tool inputs remain unchanged.

The browser source is `ui/main.mjs`. Build bundles its display libraries into
the ignored `ui/browser.mjs` asset at the existing browser URL. Rebuilding and
refreshing that UI keeps an active server conversation intact. Source ZIPs
include the authored files and rebuild the browser asset during installation.

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
outside source files. The ZIP excludes macOS metadata, installed dependencies, local state,
private environment files, logs and earlier archives. Include new public source
through `package-files.json`.

Upload the resulting file in My app. Keep `workshop-app.json` at the archive
root. For a replacement, keep the same slug and create a fresh archive.
The packager checks npm root metadata against the lockfile before writing.
Ordinary defaults are allowed in `.env.example`; actual credentials stay in `.env`.

### Hosted execution

`npm start` is the workshop startup path. The platform supplies the broker
configuration and visitor allowance. Local fixture, development and personal OpenRouter
modes are refused inside a hosted workshop runtime.
Keep the hosted listener on `0.0.0.0`, honor the supplied port and health path,
and make no paid inference or external tool calls during readiness.
Local preview commands deliberately bind to loopback.

Local `.env` values never select the hosted payer. Model choice and funding
come from the portal. A failed replacement leaves the earlier published app
available while you correct the new source.

### If something stops

| What you see | Next step |
| --- | --- |
| “Start this app through the workshop portal” after `npm start` | Use `dev:fixture`, `dev:development` or `dev:local` for laptop work. |
| Missing OpenRouter configuration | Fill both private environment variables before starting real mode. |
| HN or provider error | Inspect the failed request and evidence. A failed live call stays failed. |
| Source navigation error | Update the corresponding anchor in `scripts/sources.mjs`, then rebuild. |
| HN-only declaration error | Update the app's tool adapter and build declaration check together when changing its sources. |
| Preferences conflict | Reload saved preferences and review the proposed change again. |
| Request limit, insufficient funds or expired development token | Check Account and any pending reservations. Use request status/recovery when offered. A server restart does not reset the token allowance. |
| Assigned worker verification error in a hosted visit | Report the app link, time and exact error to Adi. Repackaging or adding credentials does not repair platform authentication. |

For help, include what you tried, the relevant error and a public-safe trace.
Keep keys, private documents and account credentials out of shared diagnostics.
