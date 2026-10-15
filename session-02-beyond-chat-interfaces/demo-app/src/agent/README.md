## Research runtime and inference gateway

The server composes `createGateway({trace, config})` and
`createResearchAgent({store, mcp, trace, gateway, config})`. These modules use
published `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` **1.2.0**,
plus the application's **p-queue 10.0.0** dependency. Node **22.19+** is required.
Credentials belong in server configuration.

### Gateway interface

`decide({state, questions, model?, signal?, parentId?, jobId?, requestId?})`
returns the native response with `operationId`, the pinned `model`, and reported
`usage` (or `null`). Choice retains its selected criterion and any native
probabilities/confidence. Noul retains `noul` directly and has no confidence
field. Only `typesafe/jev-1.13` and `perplexity/pplx-decider-v1.1-27b` are
accepted. Questions are a named object of native `choice`/`noul` questions with
instructions and criteria; Noul criteria define `true` and `false`.
The response may identify a valid dated snapshot within the requested family,
such as `typesafe/jev-1.13-20260917`. `decisionSnapshots[model]` can require an
exact resolved snapshot. The response records its actual model and the
`requestedModel`; a different model family is rejected.

Local Decisions use OpenRouter `/api/alpha/decisions`. Development and hosted
Decisions use the broker `/v1/llm/decisions` route. Chat uses the Pi
OpenAI completions adapter, with its explicit model/base URL, headers, API key,
payload observer, response observer, provider-event observer, and fetch hooks.
The standalone default chat model is `openai/gpt-6-luna`. Workshop mode has no
provisional model: state reports null while bootstrap resolves the selection,
and jobs wait for the selected model.
Model requests have a six-minute
app timeout by default; the hosted broker enforces its own 90-second deadline.

`completeText({messages, purpose?, model?, jsonOnly?, signal?, parentId?,
requestId?, jobId?, requestKind?, notify?})` makes one tool-free main-model call. It accepts Pi
messages; simple system/user messages can omit timestamps. It returns
`{text, json?, model, operationId, usage, simulated}`. `jsonOnly: true`
requests and validates a JSON object. Stage 2 can use `result.text` or
`result.json` for ordinary editorial choices. The synthetic Stage 2 fixture
returns choice labels without generating Noul answers or probabilities.

Stage 4's `createAutoResearch` composes accounted calls into an explicit outer
loop. It pins the broker-selected general model, freezes an original audit,
and uses the canonical MCP source tools under a source-only job capability.
Each round proposes a candidate and obtains an independent paired evaluation.
The deterministic gate validates evidence quotations and information retention
before a synchronous content-version check commits the candidate. Model calls
share the editorial/auto-research counter and existing budget; the run also
enforces its total request cap. Read the outer loop in `../auto-research.mjs`
and the evaluator in `../auto-research-evaluation.mjs`.

`createConversation({model?, maxTurns?, jobId?, requestId?, parentId?, signal?})`
is the runtime's Pi integration. Its `model`, `streamFn`, `maxTurns`, `turns`,
`requests`, `operationIds`, and `usage` belong to that request's entire lifetime.
Retain the same conversation across Pi continuations. The last allowed turn
removes tools from the actual SDK payload and sets `tool_choice: "none"`.
An extra dispatch is refused. SDK retries are explicitly zero; an empty response
is a visible failure. `turns` counts reserved conversational attempts, while
`requests` counts actual transport attempts, including simulated ones.
Call `await gateway.ready()` before requesting a workshop job or constructing
a broker conversation. The server starts this free read in the background so
the shell and local reads remain available; model actions await it before
enqueue. Bootstrap has its own five-second timeout, with an optional
`bootstrapTimeoutMs` override capped at fifteen seconds. `conversation.close()` releases an unused
final-answer allowance; it does not release unsettled provider charges.

`operation(id, {signal?})` reads an operation admitted by this gateway. Broker
lookup uses `/v1/llm/operations/:id` and checks operation/model/profile identity.
It never resends inference. Its GET omits POST-only attempt-limit headers.
Pending operations receive bounded free recovery reads on gateway readiness;
`recover()` explicitly checks up to ten pending operations.

Independent requests share the gateway's accounting and the selected broker's
limits. Auto research separately permits two active stories. Only a
structured 429 with a matching terminal broker receipt proving zero cost permits
a new admission: at most four retries with exponential delays and Retry-After.
Each retry has a fresh operation ID while retaining the same conversation turn,
model, payload and cancellation signal. Permanent limits block further dispatch
for the visit. Partial responses and uncertain outcomes are not replayed.

### Runtime interface

`requestStory({slotId, prompt})` synchronously returns a queued job descriptor.
The caller reserves the slot through the canonical domain/MCP layer first.
`cancelStory(jobId)` returns a boolean and invalidates only that request's slot
lease. `waitForIdle()` drains the story queue. `close()` cancels and drains jobs;
call it before closing MCP and flushing the store.

The runtime consumes the application's store directly:

- `snapshot()` returns the issue, sources, jobs, preferences and settings.
- `startJob({slotId,prompt})` is synchronous and returns `{id,slotId,
  baseContentVersion,...}`; the slot's `requestId` must equal `id`.
- `updateJob(id,patch)` publishes progress. Patches include `status`, `phase`,
  `turn`, request counts, operation IDs, usage and outcomes. Generation uses
  `running/generating`; source tools distinguish searching from reading.
  `partialText` holds the last 480 characters, with `partialTextCharacters`
  and `partialTextTruncated`. Complete message events remain in Execution.
- `completeStory({slotId,requestId,baseContentVersion,headline,body,sourceIds})`
  returns `{applied,alternate?,...}` and owns version-safe insertion.
- `update(mutator,event)` calls `mutator(issue,state)`.

Geometry is never changed by a research completion. Copy edits become an
alternate draft; deletion, cancellation and replacement invalidate late writes.
Failures preserve the prompt, observed evidence, a visibly incomplete outcome
and any usable candidate. A final prose/JSON draft must cite known observed IDs
and at least one supplied source with substantive text.
Literal control characters inside JSON strings can be escaped before strict
parsing and the same evidence validation. Other malformed structured responses
remain incomplete; raw serialization is retained in Execution, never as a
story or its research note.

`mcp.listTools({actor:"agent"})` returns declarations or a `tools/list` result.
`mcp.callTool(name,args,{actor,parentId,jobId,turn,signal})` returns the original
`CallToolResult`. App-only declarations are filtered. No tools are constructed
outside discovery. The adapter presents compact MCP content to Pi and retains
the original result in server details; full UI/audit snapshots stay out of
provider context. The MCP service must enforce job/slot authority, locks,
permissions, source identities, budgets and cancellation.

The runtime has no fixed local concurrency limit by default; funding and broker
admission still apply. When `config.concurrency` sets a finite job limit,
`config.maxQueue` defaults to eight waiting jobs. Other defaults are four MCP
calls per turn, 24 initial contextual sources and at most ten conversational
turns. Settings may reduce the turn limit. A fit rewrite uses the original allowance.
`config.measureStoryBudget(frame)` can return `{maxWords,maxCharacters?,
estimated?}` from the application's layout measurement. Otherwise the runtime uses
the domain's `storyWordBudget`, explicitly as an estimate. Overflow keeps the
entire draft and records a fit/overflow outcome.

`config.onDraftComplete({slotId,jobId,requestId,parentId})` is invoked once after
an applied completion and its final job update. The application owns editorial
review, stage behavior, cache/debounce and funding. Coordinate this hook with
the canonical MCP writer's review trigger to avoid duplicate reviews and
assessments of an intermediate revision. Alternate drafts do not trigger review
of the retained manual copy.

### Configuration and tracing

Supported modes are `fixture`, `local`, `development`, and `hosted`. Local mode
requires `apiKey`; broker modes require `brokerUrl` and `token`.
`ready()` reads `/v1/bootstrap` once and resolves the main selection and pricing
profile. The server's `onSelection` calls `store.applyInferenceSelection` to
update settings and connection selection atomically without editing the issue.
`completeText` and native Decisions also await readiness.
Optional `decisionProfileId` or
`decisionProfiles[model]` can bind separate decision pricing profiles.
Broker requests carry operation ID, expected profile, contract version and an
attempt limit of one. The broker owns funding reservations, final-answer
allowance, actual usage settlement and cached operation recovery. Unreported
cost remains unknown; SDK catalog cost estimates are not a billing ledger.

`maxInferenceCostUsd` defaults to **1 USD** and is shared across main-model,
generic editorial and native Decisions calls. Each dispatch reserves allowance
and only reported USD cost or a bound terminal broker receipt settles it.
Unknown charges retain their reservation. Optional verified `inferenceCostBounds[model]` or
`maxRequestCostUsd` permit smaller reservations; without a known bound a call
reserves the whole remaining allowance. Further inference is refused while that
allowance is unsettled. `gateway.budget` and trace events expose these amounts.
Known request bounds reserve an active story's final response separately.
While an active story has no known price bound, editorial inference waits.
The broker/provider must enforce the supplied price bounds and funding ceiling
at billing time: an application cannot undo a provider charge above an unknown
price bound. A reported overrun blocks subsequent inference and fails visibly.

Trace requires `start(kind,data) -> {id,finish}`, `record(kind,data)`, and
`fetch(url,init,meta)`. The existing `context()` supplies parent correlation.
SDK-dispatched payloads, provider events, usage, lifecycle events and MCP calls
are observable. Replay fields are redacted in agent inspector events while Pi
retains them in its server transcript. The application trace must also redact
credentials and opaque replay inside raw SSE captured by `trace.fetch`; a
`serverOnly` marker alone is insufficient when rendering trace entries.

Fixture mode encodes synthetic provider responses for Pi's real stream parser
and supplies explicitly simulated source data. It makes no gateway HTTP calls.
The MCP/source services must also run in fixture mode. `fixtureChat` and
`fixtureDecide` are optional offline script hooks for regression fixtures.

### Reuse and validation

| Former commodity implementation | Replacement |
| --- | --- |
| `agent/pi-mini.mjs` conversational scheduling, events and tool execution | Pi Agent Core `Agent`, preparation/tool/turn hooks and lifecycle subscription |
| `support/stream.mjs` and hand-written provider/transcript parsing | Pi AI OpenAI completions adapter and event stream |
| Legacy local/workshop stream dispatch | Gateway policy, billing identity and tracing hooks around Pi AI |
| Application work scheduler | p-queue |

The production runtime imports no legacy miniature engine or provider parser.
Custom code covers slot authority, provenance, editorial inference contracts,
admission limits, fit targets and observability.

Offline regression fixtures are in `src/agent/test/`. They cover turn limits across Pi
continuation, final inference failure, queue admission/cancellation, stable
geometry, manual edits, deletion/replacement, source-ID validation, native
Decisions and the Stage 2 editorial path.

Run the focused agent checks from the application directory:

```sh
node --test src/agent/test/*.test.mjs
```

These fixtures use simulated transports and no paid/live providers or browser.
