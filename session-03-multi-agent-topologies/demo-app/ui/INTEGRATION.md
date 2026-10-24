## UI integration

The editor is an MCP App. React supplies the host and editor;
`src/server.mjs` composes the application. The Montserrat asset and its license
live in `ui/fonts/`.

## Build

The config exports `createUiConfig(input)` and also accepts `INPUT`:

```sh
INPUT=editor npx vite build
INPUT=host npx vite build
INPUT=sandbox npx vite build
```

Run in that order. `editor` clears `dist`; later builds preserve its output.
The two independent resource builds use `vite-plugin-singlefile`.

- `dist/editor-view.html`: self-contained MCP App, including its font.
- `dist/index.html` and `dist/assets/**`: workshop host.
- `dist/sandbox.html`: self-contained outer sandbox proxy.

Imports require React/React DOM 19.3, ext-apps 1.7.5, MCP SDK 1.31,
react-rnd 10.5.3, Radix Popover 1.3.1,
TanStack Query 5.104.2, `@uiw/react-json-view`, Vite,
`@vitejs/plugin-react`, and `vite-plugin-singlefile`.
The application root owns packages, lockfiles and build scripts.

`UI_API_ORIGIN` optionally changes the Vite development proxy from
`http://127.0.0.1:8088`. A Vite development server does not supply the production
sandbox response headers; use the application server for Apps integration checks.

## Host routes and Apps lifecycle

`Host.jsx` observes `GET /api/state` and `EventSource("/api/events")`. The
observation channel accepts full `snapshot` / `state` notifications and bounded
revisioned `patch` / `trace` updates. Gaps trigger a free state read.

Every App read/action uses `App.callServerTool({name, arguments})`. The host's
`AppBridge.oncalltool` forwards to:

```text
POST /api/mcp/tools/{name}
Content-Type: application/json
{"arguments":{...}}
```

Return the actual MCP `CallToolResult`. `structuredContent` may be the snapshot
or `{state: snapshot, ...}`. The UI uses small text results as ordinary results,
and safely supports JSON text snapshots for compatibility. Mutation retries are
disabled. The server owns authorization, validation, budgets and inference.

On arrival, the host calls **get_editor_state**, a free MCP read of the existing
issue. It uses `_meta.ui.resourceUri` when supplied and otherwise the registered
`ui://session-02/editor-view.html`. It never starts a writer on page load.

```text
GET /api/mcp/resource?uri=ui%3A%2F%2Fsession-02%2Feditor-view.html
```

Return MCP `ReadResourceResult` with `text/html;profile=mcp-app`. Content-level
`_meta.ui.csp` / `.permissions` takes precedence; a restricted empty-domain CSP
is the fallback.

The host uses official `AppBridge` / `PostMessageTransport`, waiting for proxy
readiness, sending `sendSandboxResourceReady`, awaiting App initialization, then
sending tool input/result. Handlers are installed before connecting. State
observations arrive in the App through SDK `sendToolResult` notifications.
The resource itself uses the SDK's React `useApp` hook.

The default host is `http://localhost:PORT`; its proxy is
`http://127.0.0.1:PORT/sandbox.html`. Reverse hostname pairing also works.
`iframe.referrerPolicy="origin"` supplies a verifiable embedding origin. Proxy
messages validate both source and origin. The proxy uses the official
basic-host two-frame pattern, with fixed sandbox flags and an isolation check.
The App never receives top navigation, popup or download permissions.

For a deployment beyond these local hostnames, build with both
`VITE_MCP_SANDBOX_ORIGIN` (host) and `VITE_MCP_HOST_ORIGIN` (proxy).

Serve `/sandbox.html` on the opposite hostname and enforce CSP via HTTP headers,
including inherited inline script/style and data-font permissions needed by the
single-file resource. Keep API/Origin checks in the server. The App requires no
HTTP `connect-src` access. Permit only the registered resource domains if those
are added later. The host must be allowed to frame its configured proxy.

The host awaits `bridge.teardownResource({})` before changing the teaching stage.
The App flushes completed drafts and pending writes during teardown. Failed
local edits remain visible and prevent an accidental loss of unsaved copy.

## Editor contracts

The host owns one stage selector throughout the progression. The newspaper
keeps its editing and drag/resize controls in every automatic presentation.
The slim editorial row retains live status, timing, suggested/applied styles and
pending geometry approvals. Details opens a desktop side panel or mobile drawer.
Discover sources lives in the editor menu. Story prompts and copy use plain
textareas directly inside their blocks. The redundant global Observed sources /
Add to briefing list is removed; discovery tools and per-story evidence remain.

The canvas retains zoom out/in, presets and Fit page/width. Pointer-anchored
wheel and pinch gestures change preview scale, not saved geometry. Coordinates
remain millimeters internally: page 297 × 420, x 12–285, y 44–404, minimum
rectangle 45 × 36, maximum height 350. The drag library receives the zoom scale.

Only two UI flows create blocks: clicking empty canvas space and Add story,
which chooses a random vacant position. Both call
`create_story({slotId,frame})` with a permanent client UUID. The empty draft is
saved without inference. `request_story({slotId,prompt,contentVersion})` writes
inside an existing slot. Mutations select by `slotId`; approvals use
`approvalId`. The [MCP guide](../src/mcp/README.md) owns the full contract.

Sources supports web, HN, comments, news and page reading. It does not create
newspaper blocks. Recommendations remain source cards in the briefing, rather
than a second newspaper-creation path.

Copy edits pause briefly before saving, or flush on blur. A move or resize first
flushes local copy. The server distinguishes changed dimensions from changed
position: resizing queues one bounded general-model copy adaptation, while
position changes request editorial interpretation. Rapid resizes coalesce;
different stories may research in parallel. Existing text stays visible during
adaptation, and newer manual edits retain ownership over late model results.

Lead, relationships and sentence styling follow completed model choices
automatically. Suggested geometry requires approval. There is no manual
presentation or native-model picker.
The shared presentation helper supplies allowed size/emphasis styles and exact
sentence offsets. Stored typography applies only to its matching contentVersion;
plain text remains canonical. HTML export uses the same helper.

A model may suggest tidying excessive whitespace. A nonmodal proposal offers
Rearrange or Keep my layout. Acceptance calls `apply_layout` with the measured
frames and baseRevision. The server validates the complete proposal before one
atomic change, preserving copy, locked blocks and undo. Applying a measured
layout does not request a separate rewrite for every story.

Review issue requests an explicit review. Compact status, relationship markers
and the Evidence dialog retain the input, result, timing and linked Execution
record. Noul bars appear in the Jev and Auto research stages; pending, stale or
unavailable values never appear as zero. The Jev stage's revision demonstration
is a placeholder without inference. Auto research supplies the working
experiment/evaluate/keep-or-revert controls and saved-step recovery.

Optimistic changes sit over monotonic server snapshots. Failed writes retain
their local intent; free reads recover committed changes without replaying paid
work. Newer edits supersede obsolete failed intents. Stage changes await
`AppFrame.prepare()`, flushing local edits before teardown.

## Export

`export_newspaper({format:"html"})` must freeze the edited issue. HTML is the
only supported format and the default when the argument is omitted.
Return `{artifact:{id,url,mimeType,filename,revision,...}}`.
The host resolves relative artifact URLs against its own origin before returning
them through the bridge; the App calls `app.openLink({url})`.
The host creates the download outside the sandbox using that known descriptor.
Backend HTML export, delivery, fit policy and audit files remain server-owned.

The preview/export share physical story rectangles. Preserve the same typography
and content area in the server's HTML template when making later changes;
the preview currently uses 14pt Georgia headlines and 10pt / 1.35 body copy.
UI handles and Noul bars are editor controls, not newspaper copy.

## Execution and verification

Execution can follow a selected run or show the current visible log. Clearing
the visible log, starting a new newspaper or changing stage advances its visible
boundary; archived records and inference accounting remain separate. Global
costs retain recorded charges and pending reservations. Full records load on
selection, preserving input/output, source scope, parent links and actual timing.
The host owns the single Execution dialog and its `onViewCount` badge. Editor
record links send `notifications/workshop/open-execution` over the same MCP
transport, validated by `ui/src/shared/host-actions.mjs`; no second window bridge
or count projection is used. Stage 4 keeps round/status and Keep/Revert visible
in its compact row; full research context lives in Details and Evidence.

Inspection retains formatted syntax-colored code and an expandable JSON tree.
Embedded strings can be decoded separately. Credentials and opaque provider
replay are redacted. The direct-tool JSON editor retains syntax colors and its
explicit Format JSON action.

Browser resource/initialization/open-link reports join the server archive.
Unacknowledged browser reports remain clearly local. Cached, simulated and live
requests are distinct; charged and unresolved operations come from the separate
funding journal, never a token-price estimate.

The fixture modules exercise state/intent rules and protocol boundaries without
model charges. Source-only and browser checks are separate from real model
latency and quality. Keep live review sessions apart from synthetic test state.

React owns rendering, TanStack Query owns the query cache, react-rnd handles
drag/resize, Radix supplies popovers, and the official Apps/MCP SDKs own the
bridge. Application code supplies geometry, sentence styles, local edits,
revision checks and the workshop's visible behavior.
