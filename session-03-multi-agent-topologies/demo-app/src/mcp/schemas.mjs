// LEARNING: toolSchemas describes the arguments the model and editor can send.
// Read the same named handler in server.mjs for validation, authority and effects.

import { z } from "zod/v4";
import { distinctSourceIds, sourceIdSchema } from "../sources/schemas.mjs";

export const emptyInput = z.strictObject({});
export const frameSchema = z.strictObject({
  x: z.number().finite().min(0).max(297),
  y: z.number().finite().min(0).max(420),
  width: z.number().finite().positive().max(297),
  height: z.number().finite().positive().max(420),
});
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identity = { slotId: sourceIdSchema };
const patchSchema = z.strictObject({
  headline: z.string().max(200).optional(),
  body: z.string().max(6000).optional(),
  section: z.string().trim().min(1).max(40).optional(),
  prompt: z.string().max(4000).optional(),
});
export const toolSchemas = {
  read_skill: z.strictObject({
    name: z.enum(["hn-briefing", "story-research"]).default("hn-briefing"),
  }),
  inspect_user_preferences: emptyInput,
  propose_briefing: z.strictObject({
    issueId: sourceIdSchema.optional(),
    recommendations: z
      .array(
        z.strictObject({
          sourceId: sourceIdSchema,
          note: z.string().max(800).default(""),
        }),
      )
      .min(1)
      .max(12)
      .optional()
      .describe(
        "Preferred: observed source IDs with recommendation notes, in display order.",
      ),
    sourceIds: distinctSourceIds()
      .optional()
      .describe(
        "Alternative to recommendations for cards without notes. If both are supplied, they must identify the same sources.",
      ),
  }),
  save_reading_list: z.strictObject({ sourceIds: distinctSourceIds() }),
  remember_preferences: z.strictObject({ topic: z.string().max(256) }),
  get_editor_state: emptyInput,
  new_newspaper: emptyInput,
  load_demo_story: emptyInput,
  set_demo_mode: z.strictObject({ on: z.boolean() }),
  create_story: z.strictObject({ slotId: z.uuid(), frame: frameSchema }),
  apply_layout: z.strictObject({
    issueId: sourceIdSchema.optional(),
    baseRevision: version,
    template: z.enum(["newspaper", "breaking_news", "side_by_side"]).optional(),
    frames: z
      .array(z.strictObject({ slotId: sourceIdSchema, frame: frameSchema }))
      .min(1)
      .max(100),
    approval: z
      .strictObject({
        intentId: z.uuid(),
        reviewRequestId: sourceIdSchema,
        documentVersion: version,
        kind: z.enum(["template", "tidy"]),
      })
      .optional(),
  }),
  move_story: z.strictObject({ ...identity, frame: frameSchema }),
  edit_story: z.strictObject({ ...identity, patch: patchSchema }),
  delete_story: z.strictObject(identity),
  lock_story: z.strictObject({ ...identity, locked: z.boolean().default(true) }),
  set_focus: z.strictObject({
    issueId: sourceIdSchema.optional(),
    focus: z.string().trim().min(1).max(2000),
  }),
  set_title: z.strictObject({
    issueId: sourceIdSchema.optional(),
    title: z.string().trim().min(1).max(120),
  }),
  set_audience: z.strictObject({
    audience: z
      .string()
      .trim()
      .min(1, "Enter an audience.")
      .max(200, "Audience must be at most 200 characters."),
  }),
  undo: emptyInput,
  redo: emptyInput,
  request_briefing: z.strictObject({ prompt: z.string().trim().min(1).max(4000) }),
  cancel_briefing: z.strictObject({ jobId: sourceIdSchema }),
  request_story: z.strictObject({
    slotId: sourceIdSchema,
    prompt: z.string().trim().min(1).max(4000),
    contentVersion: version.optional(),
  }),
  cancel_story: z.strictObject({ slotId: sourceIdSchema }),
  report_story_fit: z.strictObject({
    issueId: sourceIdSchema,
    slotId: sourceIdSchema,
    contentVersion: version,
    frame: frameSchema,
    key: z.string().min(1).max(65_536),
    overflow: z.boolean(),
    bodyHeight: z.number().finite().min(0).max(100_000),
    availableBodyHeight: z.number().finite().min(0).max(100_000),
    minimumLineHeight: z.number().finite().min(0).max(10_000),
    requiredHeight: z.number().finite().positive().max(100_000),
  }),
  editorialize_board: z.strictObject({
    reason: z.string().trim().min(1).max(300).default("editor_requested_review"),
    retry: z.boolean().default(false),
  }),
  set_decision_model: z.strictObject({
    model: z.enum(["typesafe/jev-1.13", "perplexity/pplx-decider-v1.1-27b"]),
  }),
  set_stage: z.strictObject({
    stage: z.enum(["tools", "editor", "final", "research"]),
  }),
  set_topology: z.strictObject({
    topology: z.enum(["single", "graph", "swarm"]),
  }),
  revise_copy_demo: emptyInput,
  request_auto_research: z.strictObject({
    slotId: sourceIdSchema,
    contentVersion: version,
  }),
  request_fact_check: z.strictObject({
    slotId: sourceIdSchema,
    contentVersion: version,
    topology: z.enum(["single", "graph", "swarm"]).default("single"),
  }),
  cancel_fact_check: z.strictObject({ runId: z.uuid() }),
  list_execution: z.strictObject({
    view: z.enum(["teaching", "protocol"]).default("teaching"),
    order: z.enum(["asc", "desc"]).default("desc"),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    query: z.string().max(1000).optional(),
    taskId: sourceIdSchema.optional(),
  }),
  get_execution_record: z.strictObject({
    id: sourceIdSchema,
    includeExchange: z.boolean().optional(),
  }),
  clear_execution: emptyInput,
  export_newspaper: z.strictObject({ format: z.literal("html").default("html") }),
  approve_change: z.strictObject({
    approvalId: sourceIdSchema,
    accepted: z.boolean(),
  }),
  write_story: z.strictObject({
    slotId: sourceIdSchema,
    requestId: sourceIdSchema,
    baseContentVersion: version,
    headline: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(6000),
    sourceIds: distinctSourceIds(),
  }),
};
