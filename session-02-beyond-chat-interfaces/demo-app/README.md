## Session 2 Beyond the Chat Interface

Build a newspaper through MCP tools and MCP Apps. Search the web, HN and Google News,
read source evidence, place stories, and ask a bounded agent to write in an
empty region. Choice decisions suggest editorial relationships; Noul bars
estimate whether additional factual verification is needed.

The newspaper is one fixed A3 page. Moving a pending slot preserves its identity.
Manual edits and locks survive late writer results. Download exports the current
issue, with its citations, as standalone HTML.

## Run locally

Use Node.js 22.19 or newer and npm. Packaging also requires uv.
From this folder:

```sh
npm ci
npm run build
cp -n .env.example .env
```

Set `OPENROUTER_API_KEY` privately in `.env`. Research starts with Luna
(`openai/gpt-6-luna`); `OPENROUTER_MODEL` can select another tool-capable model.
Then start:

```sh
npm run dev:local
```

Open the localhost address printed by the server. The key stays on the server.
The chosen OpenRouter account pays for main-model and editorial requests.
`SESSION2_MAX_COST_USD` defaults to $1 and bounds recorded charges plus pending
reservations. For gateway-connected sessions, the selected portal ceiling and
remaining allowance also apply. Actual requests, responses, usage and any
reported costs appear in Execution.
The app's local request timeout is six minutes, configurable through
`SESSION2_MODEL_TIMEOUT_MS`. Hosted requests also have the platform's shorter
90-second deadline. A timeout retains uncertain charges and never replays an
accepted request automatically. Execution loads a small timeline and fetches full
sanitized details when you open a record. Earlier records in the current visible
log remain available through paging and search. Clearing that view does not
delete its archive or reset an allowance.
Execution archives stay beside the saved issue across local server restarts.
Reported charges and unresolved reservations have a separate durable journal.
The usage strip separates recorded cost, pending reservations and both ceilings.
**Check pending charges** makes free status reads without sending another model
request. A broker receipt proving a rejected request cost nothing clears its hold.

Independent model requests can run in parallel, subject to their task, spending
and provider limits. Auto research has its own two-story limit.
A temporary, proven zero-cost rate refusal waits with a visible countdown and
up to four retries. Stop cancels the wait.
Permanent visit limits and unknown outcomes do not retry. Manual editing and
saved copy remain available while AI work waits or stops.

Generative requests default to an output ceiling of 32,768 tokens, configurable
through `SESSION2_MAX_OUTPUT_TOKENS`. The effective ceiling can be lower when the
gateway advertises a smaller model limit. Execution records the actual requests.

Inspectors show syntax-colored, collapsed JSON trees. Complete JSON objects and
arrays stored inside strings can expand as nested trees labeled
`# parsed JSON string`.
The direct-tool arguments editor has syntax colors and an explicit Format JSON
action. Display formatting preserves original records and request data; it adds
no validation rules, inference calls or automatic repairs.

For an explicit free scripted preview:

```sh
npm run dev:fixture
```

Fixture data and model responses are synthetic. Fixture mode makes no external
source/model calls and is rejected in a hosted workshop runtime.

## Workshop development token

In the class app store, create an Account local-development token and put its
private value in `WORKSHOP_DEVELOPMENT_TOKEN`. Set the gateway shown by the store
in `WORKSHOP_DEVELOPMENT_URL`, then use:

```sh
npm run dev:development
```

Development/hosted inference uses the scoped workshop gateway. Native Choice/Noul
requires the gateway's decisions capability. Model selection, funding and limits
remain gateway authority; an unavailable native route is shown as unavailable.
Local provider credentials never select a hosted payer.

## Use the editor

The newspaper is the main workspace. Edit directly in its blocks.
**••• → Discover sources** opens research; **Review issue** requests another editorial review. The teaching
stage stays in the host toolbar. There is no separate story editing panel.
The **•••** menu includes **Start new newspaper**. It clears the current paper
and pending work and starts a new visible Execution log while retaining the connection,
preferences and visit spending. It does not reset the inference allowance.

A new local issue starts in **MCP briefing**. Ask for an HN briefing first, without
reserving newspaper space. Its familiar skills, source IDs, recommendations and
approval rules connect to the Session 1 example. Change the teaching stage to
open the same sources in the editor.

1. Click empty newspaper space, or choose **Add story** for a randomly placed
   vacant block. Both create a saved empty draft without inference.
2. Type a request in the block and submit. The agent searches and reads through
   MCP and writes cited copy into that existing slot. Web, HN, comments and news
   research remain available through Discover sources and the direct tool console.
3. Move or resize blocks with their handles. Resizing automatically adapts
   existing copy through a bounded general-model run using its existing
   evidence. Rapid resizes coalesce, and separate stories can research in parallel.
   Manual edits made during generation remain authoritative.
   Use +/− to zoom, pinch on a trackpad or touchscreen, or hold Ctrl while scrolling.
   The percentage menu offers presets and Fit width; Fit page shows the whole newspaper.
4. Editorial choices automatically change lead emphasis, relationships and sentence
   styling. **Model Chosen Newspaper Style** proposes a Front Page, Breaking News,
   or Side by Side paper template. Callouts point to affected blocks;
   **Approve** applies the proposed geometry, while **Decline** keeps your layout.
   Bold, italic, underline and sentence sizes apply without a geometry approval.
   Unchanged copy keeps its typography across moves, resizes and evidence-only
   updates. Copy, audience, focus or typography-policy changes can require new
   styling decisions. Factual assessments follow copy and evidence changes.
   Locked stories retain their placement and styling.
   Click Fact-check needed bars for evidence. Each
   percentage is a model estimate given the displayed treatment and evidence,
   rather than a verification certificate. Evidence and raw decisions are
   available from the selected story and Execution.
5. Resolve any overflow and choose Download final newspaper to save an HTML file.
   Export preserves the fixed page and current copy; it does not generate a fresh edition.

The menu's **Masthead & focus** also configures the audience. Execution uses
colored, collapsed JSON trees, counts the selected view, and supports newest or
oldest first ordering. Its list updates automatically. Each model exchange pairs
one request with its response; review totals aggregate those exchanges.
**Clear visible log** asks for confirmation. **Start new newspaper** and stage
changes also start a fresh visible log. Archived records and spending are retained
in their separate stores.

An agent run has at most ten conversational turns and can finish earlier. If it
uses its last allowed turn, tools are disabled. Copy-fitting calls are tool-free
and can occur before the turn limit. Direct editor decisions have a separate
bounded allowance and do not secretly start a new agent run.

General web search uses public search pages with a bounded alternate provider.
An empty HN or news query does not establish that a claim is unverifiable.
The writer follows observed links to primary pages and keeps its research
focused on the actual commission, rather than reusing unrelated prior articles.
Source dates accompany evidence; old announcements must be described as history.
Oversized generated copy gets up to two shortening attempts within its run
allowance. The browser also checks the rendered copy and can request up to two
correction passes for an overflow episode, preserving the box and typography.
Copy that still needs fitting remains available with **Retry fitting**; enlarging
the box or editing the copy are also options.
Google RSS means Google News RSS, covering news/articles. HN search uses Algolia.
The reader extracts public static HTML/plain text, reporting inaccessible pages
and bounded excerpts explicitly. It does not invent article text from titles.
An invalid editorial answer can be retried explicitly with **Retry review**.
Earlier attempts and their costs remain in Execution. Saved results from a
previous hosted visit remain inspectable, but that visit's full runtime archive
is not available in a new visit.

## Trace the implementation

Curated modules begin with a purpose note. Search for `LEARNING:` to find their
main reading sections. Main behavior comes before supporting helpers where
initialization permits. Expanded blocks make branches explicit; comments explain
why a boundary or check exists. Follow helpers when you need the validation,
transport or storage details.

From this application directory:

```sh
grep -RIn 'LEARNING:' src ui/src
```

Start with this path:

1. [src/server.mjs](src/server.mjs): `createApplication()` composes the shared
   store, sources, gateway, MCP server, agent and browser routes.
2. [src/stages.mjs](src/stages.mjs): capabilities added by each teaching stage.
3. [src/mcp/server.mjs](src/mcp/server.mjs): registered tools, caller authority
   and the Interactive Editor View resource.
4. [src/agent/runtime.mjs](src/agent/runtime.mjs): follow a request from
   `requestStory()` or `requestBriefing()` into `run()` and its tool calls.
5. [src/agent/gateway.mjs](src/agent/gateway.mjs): model requests, native
   decisions, limits, usage and captured input/output.
6. [ui/src/host/AppFrame.jsx](ui/src/host/AppFrame.jsx) →
   [ui/src/editor/useEditor.jsx](ui/src/editor/useEditor.jsx): the MCP App bridge
   and the editor's path from user action to acknowledged state.
7. [src/editorial.mjs](src/editorial.mjs): select questions, call the model and
   apply choices to the matching newspaper state.
8. [src/auto-research.mjs](src/auto-research.mjs): audit, research, experiment,
   evaluate and keep/revert, including saved-step recovery.
9. [src/trace.mjs](src/trace.mjs) →
   [ui/src/shared/Execution.jsx](ui/src/shared/Execution.jsx): capture observable
   work and inspect its requests, responses and effects.

Use this feature map for the supporting reading:

| Feature | Files |
| --- | --- |
| Tool contracts and transport | [schemas](src/mcp/schemas.mjs), [access rules](src/mcp/access.mjs), [client](src/mcp/client.mjs) |
| Research context and evidence | [briefing](src/agent/briefing.mjs), [story](src/agent/story.mjs), [source service](src/sources/service.mjs) |
| Canonical state and persistence | [store](src/domain/store.mjs): issue, slot identity, edits, approvals and saved checkpoints |
| Host and first-stage experience | [Host](ui/src/host/Host.jsx), [ToolsStage](ui/src/host/ToolsStage.jsx) |
| Newspaper interaction | [Editor](ui/src/editor/Editor.jsx), [StoryCard](ui/src/editor/StoryCard.jsx) |
| Incremental editorial decisions | [scope/cache](src/editorial-scope.mjs), [sentence presentation](src/presentation.mjs), [layout operations](src/layout-operations.mjs) |
| Research evaluation and controls | [evaluation](src/auto-research-evaluation.mjs), [AutoResearch UI](ui/src/editor/AutoResearch.jsx) |

Further implementation details include the segmented archive in
[src/execution-log.mjs](src/execution-log.mjs), rendered-fit policy in
[src/agent/rendered-fit.mjs](src/agent/rendered-fit.mjs), and HTML export in
[src/exporter.mjs](src/exporter.mjs).

The build regenerates `source-map.json`, a file inventory containing hashes, byte
counts and dependency versions. It is separate from a browser debugging source
map. `/api/sources` lists inspectable backend modules, and
`/api/source?path=src/server.mjs` returns that module's current text.

The original Pi 1.0.0 reference remains historical comparison material. The
runtime uses pinned published SDKs; its wrapper code exposes the boundaries
students are learning. Source and library versions are recorded in the lockfile.

## Teaching stages

**MCP briefing** runs an ordinary briefing through the canonical server. It also
lets you call the research tools directly. It needs no page geometry or
generated article.

**Interactive Editor View** opens the MCP HTML resource. The broker's actual
selected model, or your configured local model, makes editorial choices.
Loading shows real elapsed time. Typography and assessments apply immediately.
Block geometry waits for approval, and Execution retains the input, questions,
output and effect.

**Jev + editor** moves the same paper-template, relationship and sentence-style
choices to native decisions. Sizes and bold/italic/underline combinations come
from predefined choices, with no generated CSS. It additionally shows Noul
estimates of the need for factual verification. General-model writing and
resize adaptation stay separate. Recorded timings identify input/question
sets, actual requests and cached answers.

**Auto research** adds the experiment → evaluate → keep/revert loop. Select a
story and choose **Research & strengthen**, or open its evidence and choose
**Revise copy to become defensible**. The general model freezes the original
claims and reader questions, searches through MCP, reads source bodies, and
proposes a revision. An independent call evaluates both versions against the
same evidence and frozen criteria. The harness keeps a revision only when
support improves without omitted claims, lost reader goals or unsupported
additions. Discarded experiments never replace the newspaper copy.

An invalid structured response or unusable evaluation can receive one model
repair for that step. If it remains unresolved and requests remain, the loop
pauses with **Resume saved step**. Resume preserves the saved evidence, criteria
and remaining request allowance. Repair requests and their actual input/output
remain visible in Execution.

Execution shows each round's source reads, candidate, matched claim verdicts,
information goals and Keep/Revert reason. The complete JSON and quotations are
available on demand. The loop permits up to three rounds, eighteen source
reads and the current ten-request maximum. It shares the visit's existing
inference allowance and stops when that allowance is unavailable. Two stories
may run in parallel. Stop, manual copy edits, resizing, stage changes and a new
newspaper invalidate late results. Kept copy is saved; restarting never resumes
paid research automatically.

This is evidence-based revision, not a guarantee that a story is true or
unretractable. Sources and model judges can be wrong. A Noul estimate may
motivate the research; it never serves as factual proof or the Keep rule.
Stage 3 retains its zero-effect preview button so the addition of Stage 4 is
visible in the progression.

### Inspect the server from another client

```sh
npm run check:mcp
```

This launches the shared research-only server factory over stdio, discovers
tools and reads synthetic HN evidence. It verifies that application and writer
actions remain unavailable to an external research client. See
[the MCP guide](src/mcp/README.md) for the entry point and authority boundary.

### Saved local files

`editor-state.json` retains the issue. `editor-state.json.execution/` contains
segmented execution records and shared payload objects.
`editor-state.json.inference.json` retains charged and unresolved operations
independently of diagnostics. The earlier `editor-state.json.execution.json`
file is preserved as a migration checkpoint.
Keep these files private under `.local/`.

For an isolated local comparison, set `SESSION2_STATE_FILE` and
`SESSION2_EXPORTS_DIRECTORY` to a separate private work directory. Hosted export
storage retains its runtime-owned location.

Set `LOCAL_UI_HOT_RELOAD=1` when starting local or development mode to rebuild
authored UI changes and reload the browser after a successful build. The agent
process stays alive. Hosted mode does not enable this watcher.

Diagnostic capture has bounded memory and disk use. A capture problem is shown
in Execution and does not interrupt editing or grant a fresh allowance. If
funding accounting cannot be persisted, new inference stops while editing
remains available.

## Package

Set the same app slug in My app and `workshop-app.json`, then run:

```sh
npm run package:workshop -- --output ../session-02-editor-view.zip
npm run verify:package -- --zip ../session-02-editor-view.zip
```

Packages contain source, assets, lockfile and licenses. Keys, local state,
dependencies, captured data and private planning are excluded. Browser refresh
reads existing state; restarting a local process reloads its acknowledged local
issue file. Hosted issues and download artifacts remain available for the running
visit and use its writable temporary directory.

This is a complete teaching-source package: regression tests and their fixtures
stay available through `npm test`, and `reference/` retains the licensed Pi
source used for comparison. That historical source is not imported by the
running application. `source-map.json` is regenerated when you build.
