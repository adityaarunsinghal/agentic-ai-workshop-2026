// LEARNING: createMcpServer turns application functions into discoverable tools.
// Read request_briefing, request_story and write_story; schemas.mjs defines their inputs.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { sourceSchemas } from "../sources/schemas.mjs";
import { emptyInput, toolSchemas } from "./schemas.mjs";
import { readSkill } from "./skills.mjs";
import { allowsTool, OBSERVATION_TOOLS } from "./access.mjs";
import { recommendationCards } from "../agent/briefing.mjs";
import { stageProfile } from "../stages.mjs";
import { sameFrame, sameFrameSize } from "../../ui/src/shared/geometry.mjs";
import { layoutBasis } from "../layout-operations.mjs";

export const EDITOR_RESOURCE_URI = "ui://session-02/editor-view.html";
const editorHtml = new URL("../../dist/editor-view.html", import.meta.url);
const digest = (value) => {
  return createHash("sha256").update(value).digest("hex");
};

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Register one canonical catalog; transport/session ownership stays with the parent. */
export function createMcpServer(ctx, { researchOnly = false } = {}) {
  // MAIN BEHAVIOR: one catalog serves the host and agent with different authority.
  if (!ctx?.store?.snapshot || !ctx.trace?.start || !ctx.trace?.record) {
    throw new TypeError("MCP requires the canonical session store and trace.");
  }
  const server = new McpServer({ name: "session-02-newspaper", version: "1.0.0" });
  const snapshot = () => {
    return ctx.store.snapshot();
  };
  const inContext = (data, fn) => {
    return ctx.trace.withContext ? ctx.trace.withContext(data, fn) : fn();
  };

  const success = (data = {}, { observation = false } = {}) => {
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      // The UI receives a snapshot; the model adapter consumes the small text result.
      structuredContent: {
        ...(!observation && !researchOnly && authority().actor === "app"
          ? snapshot()
          : {}),
        ...data,
      },
    };
  };
  const failure = (error, options) => {
    return { ...success(errorData(error, ctx), options), isError: true };
  };

  // Decorate the public request-handler API so discovery and validation failures
  // are traced too, without reaching into the SDK's private handler registry.
  const installHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => {
    return installHandler(schema, async (request, extra) => {
      if (
        !["tools/list", "tools/call", "resources/list", "resources/read"].includes(
          request.method,
        )
      ) {
        return handler(request, extra);
      }
      const state = snapshot();
      const inherited = { ...ctx.trace.context?.() };
      const caller = authority(state),
        job = caller.job;
      if (job) {
        inherited.requestId ??= job.requestId ?? job.id;
        inherited.slotId ??= job.slotId;
      }
      inherited.issueId ??= state.issue.id;
      inherited.issueRevision ??= state.issue.revision;
      const observation =
        request.method === "tools/call" &&
        OBSERVATION_TOOLS.includes(request.params?.name);
      const span = observation
        ? null
        : ctx.trace.start("mcp", {
            ...inherited,
            method: request.method,
            params: traceParams(request.params),
            mcpRequestId: extra.requestId,
            issueId: state.issue.id,
            issueRevision: state.issue.revision,
            client: server.server.getClientVersion()?.name ?? "mcp-client",
          });
      try {
        let result = await inContext(
          {
            ...inherited,
            parentId: span?.id ?? inherited.parentId,
            mcpRequestId: extra.requestId,
          },
          () => {
            if (
              request.method === "tools/call" &&
              !allowsTool(request.params.name, caller)
            ) {
              return failure(
                new ToolError(
                  "TOOL_AUTHORITY",
                  "This tool is unavailable to this caller, task, or teaching stage.",
                ),
                { observation },
              );
            }
            if (
              request.method === "resources/read" &&
              (researchOnly ||
                caller.actor !== "app" ||
                !stageProfile(caller.stage).apps)
            ) {
              throw new ToolError(
                "RESOURCE_AUTHORITY",
                "The editor resource requires the application's editor stage.",
              );
            }
            return handler(request, extra);
          },
        );
        if (request.method === "tools/list") {
          result = {
            ...result,
            tools: result.tools
              .filter((tool) => {
                return allowsTool(tool.name, caller);
              })
              .map((tool) => {
                if (
                  stageProfile(caller.stage).apps &&
                  caller.actor === "app" &&
                  !researchOnly
                ) {
                  return tool;
                }
                const ui = tool._meta?.ui;
                if (!ui) {
                  return tool;
                }
                const { resourceUri: _resource, ...visibility } = ui;
                return { ...tool, _meta: { ...tool._meta, ui: visibility } };
              }),
          };
        }
        if (
          request.method === "resources/list" &&
          (researchOnly || caller.actor !== "app" || !stageProfile(caller.stage).apps)
        ) {
          result = { ...result, resources: [] };
        }
        if (
          request.method === "tools/call" &&
          result.isError &&
          !result.structuredContent
        ) {
          result = {
            ...result,
            structuredContent: {
              error: result.content?.[0]?.text ?? "Invalid tool arguments.",
            },
          };
        }
        const details =
          request.method === "tools/call"
            ? {
                isError: result.isError === true,
                content: result.content,
              }
            : request.method === "resources/read"
              ? {
                  contents: result.contents.map((item) => {
                    return {
                      uri: item.uri,
                      mimeType: item.mimeType,
                      bytes: Buffer.byteLength(item.text ?? item.blob ?? ""),
                      digest: digest(item.text ?? item.blob ?? ""),
                    };
                  }),
                }
              : result;
        span?.finish({
          status: result.isError ? "failed" : "complete",
          result: details,
        });
        if (
          span &&
          span.generation === ctx.trace.generation &&
          caller.actor === "app" &&
          !researchOnly
        ) {
          result._meta = { ...result._meta, executionRecordId: span.id };
        }
        if (
          request.method === "tools/call" &&
          !observation &&
          caller.actor === "app" &&
          !researchOnly
        ) {
          result.structuredContent = { ...result.structuredContent, ...snapshot() };
        }
        return result;
      } catch (error) {
        span?.finish({
          status: extra.signal.aborted ? "cancelled" : "failed",
          ...errorData(error, ctx),
        });
        throw error;
      }
    });
  };

  if (!researchOnly) {
    registerAppResource(
      server,
      "Interactive Editor View",
      EDITOR_RESOURCE_URI,
      {
        description: "The session's fixed-page newspaper editor.",
        _meta: {
          ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        },
      },
      async () => {
        let text;
        try {
          text = await readFile(editorHtml, "utf8");
        } catch {
          throw new ToolError(
            "EDITOR_NOT_BUILT",
            "Build dist/editor-view.html before opening the Interactive Editor View.",
          );
        }
        return {
          contents: [{ uri: EDITOR_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text }],
        };
      },
    );
  }

  tool(
    "read_skill",
    "Read the HN briefing or cited story research recipe.",
    async ({ name }) => {
      return { name, text: await readSkill(name) };
    },
    { readOnly: true, presentation: false },
  );
  tool(
    "inspect_user_preferences",
    "Read the session's saved topic and reading list.",
    () => {
      return { preferences: snapshot().preferences };
    },
    { readOnly: true, presentation: false },
  );

  for (const [name, method, description] of [
    [
      "list_stories",
      "listStories",
      "Read up to twelve HN metadata records from top, new, best, Ask, Show, or job feeds; default five.",
    ],
    [
      "get_story",
      "getStory",
      "Read an HN story's metadata and any public HN post text; linked publisher text needs fetch_read.",
    ],
    [
      "get_comments",
      "getComments",
      "Read a bounded HN comment sample, preserving omissions; comments are attributed opinions.",
    ],
    [
      "search_hn",
      "searchHn",
      "Search HN stories, Ask, or Show through Algolia; default five results, maximum twelve. Use list_stories for the job feed.",
    ],
    [
      "search_google_news",
      "searchGoogleNews",
      "Search news articles through Google News RSS; feed summaries are not publisher article text.",
    ],
    [
      "search_web",
      "searchWeb",
      "Discover public web pages beyond HN and news, including homepages, research, courses and events. Results are search snippets; use fetch_read for supporting evidence.",
    ],
    [
      "fetch_read",
      "fetchRead",
      "Read a bounded public HTML/plaintext excerpt and observed outbound links from a URL or source ID. Follow relevant links with another fetch_read; redirects, URLs and evidence remain bounded.",
    ],
  ]) {
    tool(
      name,
      description,
      async (args, extra) => {
        if (!ctx.sources?.[method]) {
          throw new ToolError(
            "SOURCES_UNAVAILABLE",
            "The source service is not ready.",
          );
        }
        const context = ctx.trace.context?.() ?? {};
        const batch = await ctx.sources[method](args, {
          ...context,
          signal: extra.signal,
          mcpRequestId: extra.requestId,
        });
        const job = authority().job;
        if (job) {
          ctx.store.updateJob(job.id, {
            sourceIds: [
              ...new Set([
                ...(job.sourceIds ?? []),
                ...(batch.records ?? []).map((source) => {
                  return source.id;
                }),
              ]),
            ],
          });
        }
        return batch;
      },
      { schema: sourceSchemas[method], readOnly: true },
    );
  }

  tool(
    "propose_briefing",
    "Recommend observed source cards for a briefing without creating or changing newspaper stories.",
    (args) => {
      const state = ownedIssue(args);
      if (
        args.recommendations &&
        args.sourceIds &&
        (args.recommendations.length !== args.sourceIds.length ||
          args.recommendations.some((item) => {
            return !args.sourceIds.includes(item.sourceId);
          }))
      ) {
        throw new ToolError(
          "AMBIGUOUS_BRIEFING",
          "recommendations and sourceIds identify different sources. Supply recommendations alone, or make both lists identify the same sources.",
        );
      }
      const recommendations =
        args.recommendations ??
        args.sourceIds?.map((sourceId) => {
          return { sourceId, note: "" };
        });
      if (
        !recommendations?.length ||
        new Set(
          recommendations.map((item) => {
            return item.sourceId;
          }),
        ).size !== recommendations.length
      ) {
        throw new ToolError(
          "INVALID_BRIEFING",
          "Choose one to twelve distinct observed sources.",
        );
      }
      const sources = observed(
        recommendations.map((item) => {
          return item.sourceId;
        }),
        state,
      );
      const caller = authority(state);
      const cards = recommendationCards(
        recommendations,
        new Map(
          sources.map((source) => {
            return [source.id, source];
          }),
        ),
        state,
      );
      const briefing = ctx.store.proposeBriefing({
        jobId: caller.job?.id ?? null,
        cards,
      });
      return {
        briefingId: briefing.id,
        jobId: briefing.jobId,
        cards,
        displayed: cards.map((card) => {
          return card.id;
        }),
      };
    },
  );
  tool(
    "save_reading_list",
    "Propose saving observed links; application approval is required.",
    (args) => {
      observed(args.sourceIds);
      const { state: _state, ...result } = ctx.store.saveLinks(args.sourceIds);
      return result;
    },
  );
  tool(
    "remember_preferences",
    "Propose saving an explicit topic preference; application approval is required.",
    ({ topic }) => {
      const { state: _state, ...result } = ctx.store.remember(topic);
      return result;
    },
  );

  tool(
    "request_briefing",
    "Queue a research briefing for this explicit prompt using the available web, HN and news tools. No newspaper slot is required.",
    ({ prompt }) => {
      if (!ctx.agent?.requestBriefing) {
        throw new ToolError("AGENT_UNAVAILABLE", "The briefing agent is not ready.");
      }
      return { job: ctx.agent.requestBriefing({ prompt }) };
    },
    { appOnly: true },
  );
  tool(
    "cancel_briefing",
    "Cancel a queued or active briefing in this session.",
    ({ jobId }) => {
      if (
        !snapshot().jobs.some((job) => {
          return job.id === jobId && job.type === "briefing";
        })
      ) {
        throw new ToolError(
          "UNKNOWN_JOB",
          "This briefing job does not belong to the current session.",
        );
      }
      if (!ctx.agent?.cancelBriefing) {
        throw new ToolError("AGENT_UNAVAILABLE", "The briefing agent is not ready.");
      }
      return { jobId, cancelled: ctx.agent.cancelBriefing(jobId) };
    },
    { appOnly: true },
  );
  tool(
    "list_execution",
    "Read a bounded page of Execution summaries without recording this observation.",
    async (args) => {
      if (!ctx.trace.list) {
        throw new ToolError(
          "EXECUTION_UNAVAILABLE",
          "The Execution archive is not available.",
        );
      }
      return { executionPage: await ctx.trace.list(args) };
    },
    { appOnly: true, readOnly: true },
  );
  tool(
    "get_execution_record",
    "Read one complete Execution record without recording this observation.",
    async ({ id, includeExchange }) => {
      if (!ctx.trace.get) {
        throw new ToolError(
          "EXECUTION_UNAVAILABLE",
          "The Execution archive is not available.",
        );
      }
      const executionRecord = await (includeExchange === true
        ? ctx.trace.getExchange(id)
        : ctx.trace.get(id));
      if (!executionRecord) {
        throw new ToolError(
          "UNKNOWN_EXECUTION",
          "That Execution record is not in this session.",
        );
      }
      return { executionRecord };
    },
    { appOnly: true, readOnly: true },
  );
  tool(
    "clear_execution",
    "Clear visible execution history while preserving the newspaper, active jobs and funding.",
    async () => {
      await ctx.trace.clear();
      return { cleared: true };
    },
    { appOnly: true },
  );
  tool(
    "revise_copy_demo",
    "Show the optional revision teaching placeholder. It performs no revision or inference.",
    () => {
      const message = "Auto-revisions would have started";
      ctx.trace.record("teaching.placeholder", {
        actor: "app",
        action: "revise_copy_demo",
        label: "Teaching placeholder",
        message,
      });
      return { message };
    },
    { appOnly: true, readOnly: true },
  );
  tool(
    "request_auto_research",
    "Research one existing story through bounded experiment, evaluation and keep/revert cycles. Resume its saved interrupted step when compatible, preserving evidence and the original request allowance. Preserve information goals and human edits.",
    (args) => {
      if (!ctx.autoResearch) {
        throw new ToolError("AGENT_UNAVAILABLE", "Auto research is not ready.");
      }
      return ctx.autoResearch.request(args);
    },
    { appOnly: true },
  );
  tool(
    "cancel_auto_research",
    "Stop this auto-research loop and preserve its already-kept copy.",
    ({ runId }) => {
      if (
        !snapshot().autoResearchRuns?.some((run) => {
          return run.id === runId;
        })
      ) {
        throw new ToolError(
          "UNKNOWN_JOB",
          "This research run does not belong to the current newspaper.",
        );
      }
      return { runId, cancelled: ctx.autoResearch.cancel(runId) };
    },
    { appOnly: true },
  );

  tool(
    "get_editor_state",
    "Read the canonical current Interactive Editor View state.",
    () => {
      return {
        issueId: snapshot().issue.id,
        issueRevision: snapshot().issue.revision,
        uiCapabilities: {
          renderedCopyFit: typeof ctx.agent?.reportRenderedFit === "function",
        },
      };
    },
    { appOnly: true, readOnly: true },
  );
  tool(
    "report_story_fit",
    "Report measured overflow for this exact copy and frame. Fit existing copy in a bounded episode; do not research or change typography.",
    (args) => {
      ownedIssue(args);
      if (!ctx.agent?.reportRenderedFit) {
        throw new ToolError(
          "AGENT_UNAVAILABLE",
          "Rendered copy fitting is not available in this server.",
        );
      }
      return ctx.agent.reportRenderedFit(args);
    },
    { appOnly: true },
  );
  tool(
    "new_newspaper",
    "Start a blank newspaper, stop its pending work and clear execution history. Keep the connection, preferences and spending ledger.",
    async () => {
      ctx.editorial?.cancel?.("A new newspaper replaced this editorial review.");
      await ctx.autoResearch?.cancelAll("A new newspaper replaced this research loop.");
      ctx.store.newNewspaper();
      await ctx.agent?.cancelAll?.();
      await ctx.trace.clear();
      return { started: true, documentVersion: snapshot().documentVersion };
    },
    { appOnly: true },
  );
  tool(
    "create_story",
    "Persist an empty draft at the client's permanent slot UUID without inference. Repeating the UUID preserves its existing story and job.",
    ({ slotId, frame }) => {
      const existing = snapshot().issue.stories.find((story) => {
        return story.slotId === slotId;
      });
      if (existing) {
        return { slotId: existing.slotId, created: false };
      }
      checkFrame(frame);
      const story = ctx.store.reserveStory({ slotId, frame });
      return { slotId: story.slotId, created: true };
    },
    { appOnly: true },
  );
  tool(
    "apply_layout",
    "Apply a layout only after the human approves it, atomically at its issue revision. Preserve locks. An approved template can schedule copy adaptation for blocks whose size changes.",
    async (args) => {
      const previousIssue = snapshot().issue;
      const intent = ctx.editorial?.layout?.validate(args);
      const templateChanged =
        args.template !== undefined && args.template !== previousIssue.layoutTemplate;
      for (const change of args.frames) {
        const story = previousIssue.stories.find((item) => {
          return item.slotId === change.slotId;
        });
        if (story?.pinned && !sameFrame(story.frame, change.frame)) {
          throw new ToolError(
            "STORY_PINNED",
            "A layout cannot move or resize a pinned story.",
          );
        }
      }
      const before = new Map(
        previousIssue.stories.map((story) => {
          return [story.slotId, story.frame];
        }),
      );
      const state = ctx.store.applyLayout(args);
      const changed = state.issue.stories.some((story) => {
        return !sameFrame(before.get(story.slotId), story.frame);
      });
      // A same-template direct call is geometry cleanup, never permission to
      // rewrite copy or start another model review.
      if (!templateChanged) {
        if (changed && intent) {
          ctx.editorial.layout.cleanup(intent);
        }
        return {
          applied: true,
          unchanged: !changed,
          issueRevision: state.issue.revision,
          slotIds: args.frames.map((entry) => {
            return entry.slotId;
          }),
          geometryComplete: true,
        };
      }
      const resized = state.issue.stories.filter((story) => {
        const previous = before.get(story.slotId);
        return previous && !story.locked && !sameFrameSize(previous, story.frame);
      });
      const operationId = intent
        ? ctx.editorial.layout.beginTemplate(
            intent,
            resized.map((story) => {
              return story.slotId;
            }),
          )
        : null;
      const adaptedSlotIds = [];
      try {
        for (const story of resized) {
          if (ctx.agent?.resizeStory) {
            const resize = await inContext(
              {
                ...ctx.trace.context?.(),
                movedStoryId: story.id,
                previousFrame: before.get(story.slotId),
                frame: story.frame,
                reason: "approved_template",
              },
              () => {
                return ctx.agent.resizeStory({ slotId: story.slotId });
              },
            );
            if (resize?.scheduled) {
              adaptedSlotIds.push(story.slotId);
            }
          }
        }
      } catch (error) {
        if (operationId) {
          ctx.editorial.layout.invalidate(operationId, error.message);
        }
        throw error;
      }
      if (operationId) {
        const span = ctx.trace.start("layout.completion", {
          operationId,
          template: args.template,
          adaptedSlotIds,
        });
        void ctx.editorial.layout
          .finishTemplate(operationId, async () => {
            if (adaptedSlotIds.length) {
              if (!ctx.agent?.waitForIdle) {
                throw new ToolError(
                  "AGENT_UNAVAILABLE",
                  "The template is saved, but writer completion cannot be confirmed. Choose Review issue when the stories finish.",
                );
              }
              await ctx.agent.waitForIdle();
            }
          })
          .then(
            () => {
              return span.finish({ status: "complete" });
            },
            (error) => {
              return span.finish({ status: "failed", ...errorData(error, ctx) });
            },
          );
      } else if (changed && !(adaptedSlotIds.length && ctx.config?.onDraftComplete)) {
        reviewLater("layout_applied");
      }
      return {
        applied: true,
        unchanged: state.issue.revision === previousIssue.revision,
        issueRevision: state.issue.revision,
        slotIds: args.frames.map((entry) => {
          return entry.slotId;
        }),
        ...(args.template
          ? {
              template: args.template,
              adaptedSlotIds,
              ...(!ctx.agent?.resizeStory && resized.length
                ? { warning: "Layout saved; automatic copy adaptation is unavailable." }
                : {}),
            }
          : {}),
      };
    },
    { appOnly: true },
  );
  tool(
    "move_story",
    "Save a bounded move. Size changes go to the existing writer's resize scheduler; position-only moves receive an editorial review.",
    async (args) => {
      const story = storyFor(args, { unlocked: true });
      const previousFrame = story.frame;
      checkFrame(args.frame);
      ctx.store.moveStory(story.slotId, args.frame);
      const moved = storyFor(args);
      if (sameFrame(previousFrame, moved.frame)) {
        return {
          movedStoryId: story.id,
          slotId: story.slotId,
          resized: false,
          unchanged: true,
        };
      }
      const resized = !sameFrameSize(previousFrame, moved.frame);
      if (resized) {
        if (!ctx.agent?.resizeStory) {
          throw new ToolError(
            "AGENT_UNAVAILABLE",
            "The new placement is saved, but the resize scheduler is not ready.",
          );
        }
        const resize = await inContext(
          {
            ...ctx.trace.context?.(),
            movedStoryId: story.id,
            previousFrame,
            frame: moved.frame,
            reason: "story_resized",
          },
          () => {
            return ctx.agent.resizeStory({ slotId: story.slotId });
          },
        );
        return { movedStoryId: story.id, slotId: story.slotId, resized: true, resize };
      }
      if (
        (moved.headline || moved.body) &&
        (previousFrame.x !== moved.frame.x || previousFrame.y !== moved.frame.y)
      ) {
        reviewLater("story_moved", story.id);
      }
      return { movedStoryId: story.id, slotId: story.slotId, resized: false };
    },
    { appOnly: true },
  );
  tool(
    "edit_story",
    "Apply the editor's copy, section, or prompt changes.",
    (args) => {
      const story = storyFor(args, { unlocked: true });
      if (!Object.keys(args.patch).length) {
        throw new ToolError(
          "EMPTY_EDIT",
          "Supply at least one copy or section change.",
        );
      }
      ctx.store.editStory(story.slotId, args.patch);
      if (
        ["headline", "body", "section"].some((key) => {
          return args.patch[key] !== undefined && args.patch[key] !== story[key];
        })
      ) {
        reviewLater("story_edited");
      }
      return { editedStoryId: story.id };
    },
    { appOnly: true },
  );
  tool(
    "delete_story",
    "Delete a story slot without allowing late work to recreate it.",
    (args) => {
      const story = storyFor(args, { unlocked: true });
      ctx.store.deleteStory(story.slotId);
      reviewLater("story_deleted");
      return { deletedStoryId: story.id };
    },
    { appOnly: true },
  );
  tool(
    "lock_story",
    "Set an explicit story lock respected by editorial and writer operations.",
    (args) => {
      const story = storyFor(args);
      ctx.store.lockStory(story.slotId, args.locked);
      return { storyId: story.id, locked: args.locked };
    },
    { appOnly: true },
  );
  tool(
    "set_focus",
    "Set the issue's editorial focus and invalidate affected assessments.",
    (args) => {
      ownedIssue(args);
      ctx.store.setFocus(args.focus);
      reviewLater("focus_changed");
      return { focus: args.focus };
    },
    { appOnly: true },
  );
  tool(
    "set_title",
    "Set the newspaper masthead.",
    (args) => {
      ownedIssue(args);
      ctx.store.setTitle(args.title);
      return { title: args.title };
    },
    { appOnly: true },
  );
  tool(
    "set_audience",
    "Save the newspaper's intended readers for subsequent writing and editorial decisions without starting inference.",
    ({ audience }) => {
      ctx.store.setAudience(audience);
      return { audience };
    },
    { appOnly: true },
  );
  for (const name of ["undo", "redo"]) {
    tool(
      name,
      `${name === "undo" ? "Undo" : "Redo"} the latest issue edit.`,
      () => {
        ctx.store[name]();
        reviewLater(name);
        return { action: name };
      },
      { appOnly: true },
    );
  }

  tool(
    "request_story",
    "Generate copy for an existing slot only after the user's explicit prompt. Create the empty slot with create_story first.",
    async (args) => {
      if (!ctx.agent?.requestStory) {
        throw new ToolError("AGENT_UNAVAILABLE", "The story writer is not ready.");
      }
      const slot = storyFor(args, { unlocked: true });
      if (
        args.contentVersion !== undefined &&
        args.contentVersion !== slot.contentVersion
      ) {
        throw new ToolError(
          "STALE_CONTENT",
          "The story copy changed after this request was prepared.",
        );
      }
      if (slot.prompt !== args.prompt) {
        ctx.store.update(
          (issue) => {
            issue.stories.find((story) => {
              return story.slotId === slot.slotId;
            }).prompt = args.prompt;
          },
          {
            actor: "app",
            action: "story_prompt_changed",
            history: false,
            data: { slotId: slot.slotId, prompt: args.prompt },
          },
        );
      }
      const job = await ctx.agent.requestStory({
        slotId: slot.slotId,
        prompt: args.prompt,
      });
      return { job, slotId: slot.slotId };
    },
    { appOnly: true },
  );
  tool(
    "cancel_story",
    "Cancel the current queued or active writer for this story slot.",
    async ({ slotId }) => {
      const story = storyFor({ slotId });
      const job = snapshot().jobs.find((entry) => {
        return entry.id === story.requestId && entry.slotId === slotId;
      });
      if (!job) {
        return { slotId, cancelled: false };
      }
      if (!ctx.agent?.cancelStory) {
        throw new ToolError("AGENT_UNAVAILABLE", "The story writer is not ready.");
      }
      const cancelled = await ctx.agent.cancelStory(job.id);
      return { slotId, jobId: job.id, cancelled: cancelled !== false };
    },
    { appOnly: true },
  );
  tool(
    "editorialize_board",
    "Explicitly review the board through the current stage's editorial adapter. Set retry only for an explicit retry of a failed review.",
    async ({ reason, retry }) => {
      if (snapshot().settings.stage === "tools") {
        return {
          reviewed: false,
          reason: "Dedicated editorial review is disabled in the tools stage.",
        };
      }
      if (!ctx.editorial?.review) {
        throw new ToolError(
          "EDITORIAL_UNAVAILABLE",
          "The editorial service is not ready.",
        );
      }
      const result = await ctx.editorial.review({ reason, retry, explicit: true });
      return { reviewed: true, review: reviewSummary(result) };
    },
    { appOnly: true },
  );
  tool(
    "set_decision_model",
    "Select one of the approved decision models.",
    ({ model }) => {
      ctx.store.setDecisionModel(model);
      return { decisionModel: model };
    },
    { appOnly: true },
  );
  tool(
    "set_stage",
    "Change teaching stage and clear its execution history, preserving the newspaper and funding.",
    async ({ stage }) => {
      if (snapshot().settings.stage === stage) {
        return { stage };
      }
      ctx.editorial?.cancel?.("Teaching stage changed.");
      await ctx.autoResearch?.cancelAll(
        "Teaching stage changed. Kept copy is preserved.",
      );
      ctx.store.setStage(stage);
      await ctx.trace.clear();
      const state = snapshot();
      if (
        state.settings.stage === stage &&
        stage !== "tools" &&
        state.issue.stories.some((story) => {
          return story.body?.trim();
        })
      ) {
        inContext({ ...ctx.trace.context?.(), parentId: null }, () => {
          return reviewLater(
            "stage_changed",
            state.editorial?.movedStoryId ?? undefined,
          );
        });
      }
      return { stage };
    },
    { appOnly: true },
  );
  tool(
    "export_newspaper",
    "Download the exact edited issue as HTML.",
    async ({ format }) => {
      if (!ctx.exporter?.exportIssue) {
        throw new ToolError(
          "EXPORT_UNAVAILABLE",
          "The newspaper exporter is not ready.",
        );
      }
      return { artifact: await ctx.exporter.exportIssue({ format }) };
    },
    { appOnly: true },
  );
  tool(
    "approve_change",
    "Accept or decline one active, session-owned preference or reading-list proposal.",
    ({ approvalId, accepted }) => {
      if (
        !snapshot().approvals.some((proposal) => {
          return proposal.id === approvalId;
        })
      ) {
        throw new ToolError(
          "UNKNOWN_APPROVAL",
          "This approval is no longer active in the current session.",
        );
      }
      ctx.store.approve(approvalId, accepted);
      return { approvalId, accepted };
    },
    { appOnly: true },
  );

  tool(
    "write_story",
    "Write cited generated copy to this job's reserved slot; preserve manual edits as an alternate draft.",
    (args) => {
      const state = ownedIssue(args);
      const records = observed(args.sourceIds, state);
      const story = state.issue.stories.find((item) => {
        return item.slotId === args.slotId;
      });
      const job = state.jobs.find((item) => {
        return item.id === args.requestId && item.slotId === args.slotId;
      });
      const activeJobId = ctx.trace.context?.().jobId;
      if (!activeJobId || activeJobId !== args.requestId) {
        throw new ToolError(
          "WRONG_JOB",
          "Write only the slot assigned to the current writer job.",
        );
      }
      if (!story || !job || story.requestId !== args.requestId) {
        return {
          applied: false,
          reason: "Slot deleted or request replaced.",
          slotId: args.slotId,
        };
      }
      if (
        [
          "cancelled",
          "canceled",
          "superseded",
          "failed",
          "incomplete",
          "interrupted",
        ].includes(job.status)
      ) {
        return {
          applied: false,
          reason: "This writer job is no longer active.",
          slotId: args.slotId,
        };
      }
      if (
        !Number.isSafeInteger(job.baseContentVersion) ||
        args.baseContentVersion !== job.baseContentVersion
      ) {
        throw new ToolError(
          "WRONG_CONTENT_VERSION",
          "Use the content version reserved by this writer job.",
        );
      }
      if (
        !records.some((source) => {
          return (
            typeof source.text === "string" &&
            source.text.trim() &&
            !["metadata", "feed-summary", "search-snippet"].includes(
              source.evidenceLevel,
            )
          );
        })
      ) {
        throw new ToolError(
          "INSUFFICIENT_EVIDENCE",
          "Read supporting source text before writing a generated story.",
        );
      }
      const draft = {
        headline: args.headline,
        body: args.body,
        sourceIds: args.sourceIds,
      };
      const sourceLineage = lineage(records);
      if (
        story.contentVersion === job.baseContentVersion + 1 &&
        story.headline === draft.headline &&
        story.body === draft.body &&
        JSON.stringify(story.sourceIds) === JSON.stringify(draft.sourceIds)
      ) {
        return { applied: true, reused: true, slotId: story.slotId };
      }
      if (["completed", "complete", "done"].includes(job.status)) {
        return {
          applied: false,
          reason: "This writer job has already finished.",
          slotId: args.slotId,
        };
      }
      let completion;
      if (story.locked) {
        ctx.store.update(
          (issue) => {
            const current = issue.stories.find((item) => {
              return item.slotId === args.slotId;
            });
            current.alternateDraft = {
              ...draft,
              sourceLineage,
              requestId: args.requestId,
              baseContentVersion: job.baseContentVersion,
            };
            if (!current.body) {
              current.status = "draft_available";
            }
          },
          {
            actor: "agent",
            action: "locked_draft_retained",
            history: false,
            data: { slotId: args.slotId, requestId: args.requestId },
          },
        );
        completion = { applied: false, alternate: true };
      } else {
        const { state: _state, ...result } = ctx.store.completeStory({
          slotId: args.slotId,
          requestId: args.requestId,
          baseContentVersion: job.baseContentVersion,
          ...draft,
        });
        completion = result;
        ctx.store.update(
          (issue) => {
            const current = issue.stories.find((item) => {
              return item.slotId === args.slotId;
            });
            if (completion.applied) {
              current.sourceLineage = sourceLineage;
            } else if (completion.alternate && current.alternateDraft) {
              Object.assign(current.alternateDraft, {
                sourceLineage,
                requestId: args.requestId,
                baseContentVersion: job.baseContentVersion,
              });
            }
          },
          {
            actor: "agent",
            action: "draft_lineage_recorded",
            history: false,
            data: { slotId: args.slotId, requestId: args.requestId, sourceLineage },
          },
        );
      }
      if (completion.applied && !ctx.config?.onDraftComplete) {
        reviewLater("story_written");
      }
      return { ...completion, slotId: args.slotId, sourceIds: args.sourceIds };
    },
    { modelOnly: true },
  );
  return server;

  // SUPPORTING HELPERS: declarations stay in the same scope.

  function authority(state = snapshot()) {
    const inherited = ctx.trace.context?.() ?? {};
    const job = state.jobs.find((entry) => {
      return entry.id === inherited.jobId && entry.issueId === state.issue.id;
    });
    return { actor: inherited.actor, stage: state.settings.stage, job, researchOnly };
  }

  function ownedIssue(args) {
    const state = snapshot();
    if (args.issueId && args.issueId !== state.issue.id) {
      throw new ToolError(
        "UNKNOWN_ISSUE",
        "This issue does not belong to the current session.",
      );
    }
    return state;
  }

  function observed(ids, state = snapshot()) {
    const known = new Map(
      state.issue.sources.map((source) => {
        return [source.id, source];
      }),
    );
    const caller = authority(state);
    return ids.map((id) => {
      if (!known.has(id)) {
        throw new ToolError(
          "UNKNOWN_SOURCE",
          "Use source IDs observed in this session.",
        );
      }
      if (caller.actor === "agent" && !(caller.job?.sourceIds ?? []).includes(id)) {
        throw new ToolError(
          "UNOBSERVED_SOURCE",
          "Use source IDs observed by the current task.",
        );
      }
      return known.get(id);
    });
  }

  function storyFor(args, { unlocked = false } = {}) {
    const story = snapshot().issue.stories.find((entry) => {
      return entry.slotId === args.slotId;
    });
    if (!story) {
      throw new ToolError(
        "UNKNOWN_SLOT",
        "This story slot no longer exists in the current issue.",
      );
    }
    if (unlocked && story.locked) {
      throw new ToolError(
        "STORY_LOCKED",
        "Unlock this story before changing its placement or copy.",
      );
    }
    return story;
  }

  function checkFrame(frame, state = snapshot()) {
    if (
      frame &&
      (frame.x + frame.width > state.issue.width ||
        frame.y + frame.height > state.issue.height)
    ) {
      throw new ToolError(
        "FRAME_BOUNDS",
        "The story rectangle must stay inside the fixed newspaper page.",
      );
    }
  }

  function reviewLater(reason, movedStoryId) {
    if (snapshot().settings.stage === "tools" || !ctx.editorial?.review) {
      return;
    }
    const context = ctx.trace.context?.() ?? {};
    // Calling the parent review adapter preserves its debounce/cache/revision policy.
    void inContext(context, async () => {
      let span;
      try {
        span = ctx.trace.start("editorial.trigger", {
          reason,
          movedStoryId,
          ...context,
        });
        const result = await ctx.editorial.review({ reason, movedStoryId });
        span.finish({ status: "complete", result: reviewSummary(result) });
      } catch (error) {
        span?.finish({ status: "failed", ...errorData(error, ctx) });
      }
    });
  }

  function tool(
    name,
    description,
    handler,
    {
      schema = toolSchemas[name],
      appOnly = false,
      modelOnly = false,
      readOnly = false,
      presentation = true,
    } = {},
  ) {
    if (researchOnly && !allowsTool(name, { researchOnly: true })) {
      return;
    }
    const observation = OBSERVATION_TOOLS.includes(name);
    const configuration = {
      description,
      inputSchema: schema ?? emptyInput,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        openWorldHint: readOnly,
      },
      ...(presentation || appOnly
        ? {
            _meta: {
              ui: {
                resourceUri: EDITOR_RESOURCE_URI,
                visibility: appOnly
                  ? ["app"]
                  : modelOnly
                    ? ["model"]
                    : ["model", "app"],
              },
            },
          }
        : {}),
    };
    const callback = async (args, extra) => {
      const before =
        !observation && name !== "apply_layout" && ctx.editorial?.layout
          ? snapshot()
          : null;
      try {
        extra.signal.throwIfAborted();
        return success(await handler(args, extra), {
          observation: observation && name !== "clear_execution",
        });
      } catch (error) {
        return failure(error, { observation });
      } finally {
        if (
          before?.layoutOperation &&
          layoutBasis(before) !== layoutBasis(snapshot())
        ) {
          ctx.editorial.layout.invalidate(
            before.layoutOperation.id,
            "An explicit newspaper change replaced the layout operation.",
          );
        }
      }
    };
    if (presentation || appOnly) {
      registerAppTool(server, name, configuration, callback);
    } else {
      server.registerTool(name, configuration, callback);
    }
  }
}

// SUPPORTING HELPERS: declarations stay in the same scope.

function errorData(error, ctx) {
  let message = String(
    error?.message ??
      "The operation could not complete. Its current state is preserved.",
  );
  for (const secret of [ctx.config?.apiKey, ctx.config?.token])
    if (typeof secret === "string" && secret) {
      message = message.replaceAll(secret, "[redacted]");
    }
  const safe = ctx.trace.safe?.(message) ?? message;
  return {
    code:
      typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : "TOOL_FAILED",
    error:
      typeof safe === "string"
        ? safe.slice(0, 2000)
        : "The operation could not complete.",
  };
}

function traceParams(value) {
  if (Array.isArray(value)) {
    return value.map(traceParams);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        return [
          key,
          /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credentials?)$/i.test(
            key,
          )
            ? "[redacted]"
            : traceParams(item),
        ];
      }),
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
    try {
      const url = new URL(value);
      if (url.username || url.password) {
        url.username = "[redacted]";
        url.password = "";
      }
      for (const key of [...url.searchParams.keys()])
        if (
          /^(?:token|access_token|api[-_]?key|password|authorization|credential|signature|sig|x-amz-.+)$/i.test(
            key,
          )
        ) {
          url.searchParams.set(key, "[redacted]");
        }
      return url.href;
    } catch {
      /* Invalid input still receives SDK validation and an Execution record. */
    }
  }
  return value;
}

function lineage(records) {
  return records.map((source) => {
    return {
      id: source.id,
      kind: source.kind ?? "source",
      url: source.canonicalUrl ?? source.url ?? null,
      evidenceLevel: source.evidenceLevel ?? "unspecified",
      retrievedAt: source.retrievedAt ?? null,
      contentDigest:
        source.contentDigest ?? digest(source.text ?? JSON.stringify(source)),
      synthetic:
        source.origin === "fixture" ||
        source.synthetic === true ||
        source.simulated === true,
      completeness: source.completeness ?? null,
    };
  });
}

function reviewSummary(result) {
  if (result?.issue) {
    return { issueRevision: result.issue.revision };
  }
  if (result?.state?.issue) {
    const { state, ...details } = result;
    return { ...details, issueRevision: state.issue.revision };
  }
  return result;
}
