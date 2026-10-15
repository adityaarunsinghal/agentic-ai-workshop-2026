// These are application policy, not claims made by a tool's visibility metadata.
// LEARNING: taskAllowsTool and allowsTool separate discovery from permission.
// The model sees a task-specific catalog; server.mjs still checks every call.

export const SOURCE_TOOLS = Object.freeze([
  "list_stories",
  "get_story",
  "get_comments",
  "search_hn",
  "search_google_news",
  "search_web",
  "fetch_read",
]);
export const BRIEFING_TOOLS = Object.freeze([
  "read_skill",
  "inspect_user_preferences",
  "list_stories",
  "propose_briefing",
  "save_reading_list",
  "remember_preferences",
]);
export const OBSERVATION_TOOLS = Object.freeze([
  "list_execution",
  "get_execution_record",
  "clear_execution",
]);

const research = new Set(["read_skill", ...SOURCE_TOOLS]);
const shared = new Set([...research, ...BRIEFING_TOOLS]);
const app = new Set([
  ...shared,
  ...OBSERVATION_TOOLS,
  "request_briefing",
  "cancel_briefing",
  "set_stage",
  "approve_change",
  "new_newspaper",
]);
const editor = new Set([
  "get_editor_state",
  "create_story",
  "apply_layout",
  "move_story",
  "edit_story",
  "delete_story",
  "lock_story",
  "set_focus",
  "set_title",
  "set_audience",
  "undo",
  "redo",
  "request_story",
  "cancel_story",
  "editorialize_board",
  "export_newspaper",
  "report_story_fit",
]);
const final = new Set(["set_decision_model", "revise_copy_demo"]);

/** The admitted task, rather than a model-supplied argument, grants tool access. */
export function taskAllowsTool(name, taskType) {
  if (taskType === "auto_research") {
    return research.has(name);
  }
  if (taskType === "briefing") {
    return shared.has(name);
  }
  if (taskType === "story") {
    return name === "write_story" || (shared.has(name) && name !== "propose_briefing");
  }
  return false;
}

export function allowsTool(name, { actor, stage, job, researchOnly = false } = {}) {
  if (researchOnly || !["app", "agent"].includes(actor)) {
    return research.has(name);
  }
  if (actor === "agent") {
    if (!job) {
      return false;
    }
    if (job.maxTurns && job.turn >= job.maxTurns) {
      return false;
    }
    if (
      [
        "completed",
        "incomplete",
        "failed",
        "cancelled",
        "stopped",
        "superseded",
        "interrupted",
      ].includes(job.status) &&
      name !== "write_story"
    ) {
      return false;
    }
    return taskAllowsTool(name, job.type ?? (job.slotId ? "story" : undefined));
  }
  return (
    app.has(name) ||
    (stage !== "tools" && editor.has(name)) ||
    (["final", "research"].includes(stage) && final.has(name)) ||
    (stage === "research" &&
      ["request_auto_research", "cancel_auto_research"].includes(name))
  );
}
