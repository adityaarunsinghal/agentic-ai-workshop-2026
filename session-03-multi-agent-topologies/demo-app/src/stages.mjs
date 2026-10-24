// LEARNING: These profiles define what each stage adds to the same application.
// Follow editorialBackend into editorial.mjs and apps into ui/src/host/Host.jsx.

export const STAGE_PROFILES = Object.freeze({
  tools: Object.freeze({
    id: "tools",
    label: "MCP briefing",
    apps: false,
    editorialBackend: "none",
    nativeDecisions: false,
    noulBars: false,
  }),
  editor: Object.freeze({
    id: "editor",
    label: "MCP Apps with general model",
    apps: true,
    editorialBackend: "chat",
    nativeDecisions: false,
    noulBars: false,
  }),
  final: Object.freeze({
    id: "final",
    label: "Jev editorial decisions",
    apps: true,
    editorialBackend: "decisions",
    nativeDecisions: true,
    noulBars: true,
  }),
  research: Object.freeze({
    id: "research",
    label: "Auto research",
    apps: true,
    editorialBackend: "decisions",
    nativeDecisions: true,
    noulBars: true,
    autoResearch: true,
  }),
});
export function stageProfile(stage) {
  const profile = STAGE_PROFILES[stage];
  if (!profile) {
    throw new Error("Choose a known teaching stage.");
  }
  return profile;
}
