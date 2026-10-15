## One factory, two clients

The application imports `connectMcp` from `src/mcp/client.mjs`. Its in-memory
transport carries the trusted caller in process-local context. The server
filters discovery and checks every call against the current stage and admitted
task. Client names, MCP request metadata and visibility annotations grant no
authority. A raw client can use only source research tools.
The three-line `src/mcp-connection.mjs` re-export preserves the earlier import
path; all implementation and caller-authority handling lives in `src/mcp/client.mjs`.

`request_briefing({prompt})` returns `{job}` immediately. It needs no geometry.
`state.briefings` contains `{id, jobId, issueId, prompt, status, phase, turn,
maxTurns, answer, partialText, cards, createdAt, updatedAt}`. Each card preserves
the original source record and adds `sourceId` and `note`. Cards arrive when
`propose_briefing` succeeds; the final answer arrives when the task completes.
Standalone app recommendations in the tools stage have `jobId: null`.

`propose_briefing` only publishes recommendations. It never creates newspaper
stories, including in the editor stage. Collected sources remain in the pool
for writer context. Existing saved source-card stories remain ordinary saved
content and are not removed.

The UI's empty-space click and Add story flows both call app-only
`create_story({slotId,frame})`. `slotId` is a client UUID and becomes the
permanent `id` and `slotId`. The result is `{slotId,created}` plus the normal
app snapshot. A new story is empty with status `draft`; no inference runs.
Repeating the UUID returns the existing story without resetting copy, placement,
locks or its active job.

`new_newspaper({})` clears the paper, source pool, drafts and pending approvals,
and stops outstanding research, resize and editorial work. It advances
`documentVersion` so old source results cannot repopulate the cleared paper.
The visit identity, preferences, execution archive and funding ledger remain;
this action does not grant a new inference allowance. Undo can restore the
previous paper without restarting its cancelled jobs.

`request_story({slotId,prompt,contentVersion?})` explicitly starts writing in
that existing slot. It cannot create from a frame. Move, edit, delete, lock and
cancel also select by `slotId` only. Cancellation resolves the slot's current
writer request on the server. `approve_change` uses `approvalId`; `write_story`
uses `slotId`, `requestId`, required `baseContentVersion`, headline, body and
observed sourceIds. The server derives issue ownership from the admitted task.
Manual edits invalidate typography when its saved contentVersion no longer
matches the copy, preserving the copy itself.

`move_story` commits the frame first. Any actual width or height change calls
`ctx.agent.resizeStory({slotId})` and returns its response as `resize`, with
`resized:true`. This includes empty slots and pending writers: the scheduler
owns skipping, waiting and coalescing. It receives `movedStoryId`, previousFrame,
frame and `reason:"story_resized"` in trace context. The completion hook owns
editorial review. A position-only move returns `resized:false` and requests
`reviewLater("story_moved", story.id)` without a resize request.

The app can offer a measured layout and ask the visitor to Rearrange or Keep.
Only acceptance calls `apply_layout({baseRevision,frames:[{slotId,frame}]})`,
with optional `issueId`. Before changing state, the store validates the current
revision, unique existing slots, content-area bounds, unchanged locked blocks,
and nonoverlap across the entire resulting page. Acceptance creates one issue
revision and undo entry, preserves body/headline/contentVersion/jobs and
typography, clears `settings.layoutCleanup`, and completes the geometry
operation. Cleanup starts neither another editorial review nor a resize writer.
The result includes `geometryComplete:true` plus the app snapshot.

A different approved `template` may adapt changed block sizes. Its writers
join one final review, constrained to that accepted template, followed by at
most one cleanup. The parent routes `onDraftComplete` through
`editorial.reviewDraft`; the template coordinator waits for writer completion.
An ordinary draft still receives its normal review.

When state contains `layoutOperation`, approval sends
`approval:{intentId,reviewRequestId,documentVersion,kind}` with kind `template`
or `tidy`. The server checks that intent against the current review and CAS
revision. Cleanup cannot escalate to template adaptation, including through a
same-template direct call. Explicit Review issue opens a fresh intent;
meaningful frame, copy and evidence changes invalidate the old basis. A new
receipt ID or progress revision alone does not reopen a completed operation.
Clients omit the approval object when connected to an older backend that has
not supplied this metadata.

The rendered editor reserves a constant overflow-warning row. Showing its
text changes neither available copy space nor the measured target height.

Selecting editor or final through `set_stage` automatically requests a review
when body copy exists. The parent review adapter owns caching and in-flight
deduplication; changing stages does not rewrite copy.

`list_stories` takes `{category,count}`, defaulting to five with a maximum of
twelve; the job category is `job`. Comments and Google News remain available.
`search_web({query,limit?})` discovers public web results through DuckDuckGo HTML,
with at most one Bing RSS alternate. It needs no API secret. Each provider has
a six-second request bound, within the source task's overall timeout. Provider
attempts are returned in `discovery`; results have evidenceLevel `search-snippet`.
`fetch_read({url?,sourceId?,maxChars?,maxLinks?})` reads supporting text and
returns bounded observed `links` on each record. The default is twelve links,
maximum twenty-four; links alone do not establish their destination's contents.
Both providers and every subsequent page read use the existing public URL,
DNS, redirect and byte checks.

The stages are `tools`, `editor`, `final`, and `research`. Tools starts with HN briefing.
Editor uses MCP Apps and the selected general model for editorial decisions.
Final retains its saved ID and uses the narrow decision model. Its UI exposes
the `revise_copy_demo` teaching placeholder, which starts no task and changes no
issue content. Research retains native editorial decisions and adds
`request_auto_research` and `cancel_auto_research`. The bounded loop researches,
evaluates and keeps or reverts revisions; a compatible saved step can resume
within its original request allowance.

`list_execution({view, cursor, limit, query, taskId})` returns
`structuredContent: {executionPage}`. `get_execution_record({id,includeExchange?})` returns
`structuredContent: {executionRecord}`. Only `includeExchange:true` requests
paired model I/O; omission and false preserve the raw record. Both reads require app authority, skip trace
recording, and omit the state snapshot. Views are `teaching` and `protocol`.
Normal snapshots contain at most 50
recent teaching summaries and `execution: trace.summary()`. `streamRevision`
advances on notifications; `issue.revision` tracks domain edits.
`store.updateActivity(patch)` publishes and persists non-domain fields without
altering the issue revision or undo history.

## Another client

From the app directory:

```sh
node scripts/mcp-client-check.mjs
```

The check launches `node scripts/mcp-stdio.mjs --fixture`, then discovers tools,
reads the skill, lists three synthetic HN records and checks denied app/writer
calls. Another MCP client can launch the same command over stdio. Each process
has isolated memory, no saved issue file, no gateway and no network access.
Only the shared factory's source research tools are registered. Protocol
messages use stdout; the check prints its own result after those exchanges.

The source fixtures retain Session 2's existing IDs and retrieval behavior.
Its briefing follows Session 1's tool names and metadata limits. Neither
fixture is live HN reporting.

Implementation reference checked October 14, 2026: the app's pinned
`@modelcontextprotocol/sdk` 1.31.0 and `@modelcontextprotocol/ext-apps` 1.7.5
sources under `node_modules`, including the in-memory transport, stdio
transports and public request-handler API. The native Pi hooks remain in
`src/agent/runtime.mjs`; its SDK pins and historical source identity are
unchanged.
