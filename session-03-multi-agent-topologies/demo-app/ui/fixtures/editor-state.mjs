// Synthetic data for source/build checks only. Production never falls back to it.
export const fixture = {
  revision: 17,
  issue: {
    id: "fixture-issue", title: "The Agentic Times", date: "2026-10-13",
    focus: "Practical ideas for reliable agents", audience: "Builders",
    revision: 7, width: 297, height: 420, relationships: [],
    sources: [{
      id: "fixture-hn-101", kind: "hn", title: "Synthetic report on agent evaluation",
      url: "https://example.com/fixture", canonicalUrl: "https://example.com/fixture",
      evidenceLevel: "publisher-excerpt", text: "Synthetic evidence: a small evaluation reported its methods and limitations.",
    }],
    stories: [{
      id: "slot-1", slotId: "slot-1", prompt: "A synthetic evaluation story",
      headline: "Better evaluations start with clearer questions",
      body: "A synthetic workshop source describes an evaluation with a defined scope. Its findings illustrate attribution and evidence review; they are not a report about a real event.",
      sourceIds: ["fixture-hn-101"], frame: { x: 12, y: 46, width: 84, height: 100 },
      section: "lead", locked: false, status: "ready", contentVersion: 2,
      factCheck: { status: "complete", probability: 0.72, model: "typesafe/jev-1.13", inputRevision: 6, requestId: "decision-1" },
    }, {
      id: "slot-2", slotId: "slot-2", prompt: "Research a contrasting perspective",
      headline: "", body: "", sourceIds: [], frame: { x: 102, y: 46, width: 84, height: 100 },
      section: "news", locked: false, status: "researching", contentVersion: 0, requestId: "job-1",
      factCheck: { status: "pending", probability: null },
    }],
  },
  jobs: [{ id: "job-1", slotId: "slot-2", prompt: "Research a contrasting perspective", status: "researching", turn: 3 }],
  trace: [
    { id: "ui-1", parentId: null, kind: "editor", actor: "app", action: "story_moved", status: "complete", beforeRevision: 5, issueRevision: 6, payload: { storyId: "slot-1" } },
    { id: "decision-1", parentId: "ui-1", kind: "decision", actor: "editor", status: "complete", model: "typesafe/jev-1.13", cost: 0.00041, durationMs: 145, turn: 0, payload: { questions: { check: { type: "noul", criteria: { true: "Needs verification", false: "Within evidence" } } } }, result: { answers: { check: { type: "noul", noul: 0.72 } } } },
    { id: "chat-1", parentId: "job-1", kind: "chat", actor: "agent", status: "running", model: "fixture", turn: 3, payload: { messages: [{ role: "user", content: "Synthetic research request" }] } },
  ],
  settings: { stage: "final", model: "fixture-chat", decisionModel: "typesafe/jev-1.13", maxTurns: 10, mode: "fixture" },
  preferences: { topic: "", readingList: [] }, approvals: [], suggestions: [],
};
