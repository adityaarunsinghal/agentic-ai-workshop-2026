/**
 * Scripted responses for an explicit, free preview.
 * These records and completions are synthetic. They make no network calls.
 */
import { randomUUID } from "node:crypto";

export const fixtureRecords = [
  ["tools", "Tools that return observations"],
  ["loops", "A small agent loop"],
  ["memory", "Memory and context"],
].map(([slug, title], index) => ({
  id: `fixture-hn-${index + 1}`,
  kind: "hn",
  upstreamId: String(900001 + index),
  title: `Fixture: ${title}`,
  canonicalUrl: `https://example.org/${slug}`,
  retrievedAt: "2026-10-07T12:00:00.000Z",
  evidenceLevel: "metadata",
  completeness: { completeForRequestedScope: true },
  contentDigest: `fixture-${slug}`,
  origin: "fixture",
}));

export function textFrame(text) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
}

export function toolFrame(name, args) {
  return `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  })}\n\ndata: [DONE]\n\n`;
}

/** Follow the same small recipe so the harness is easy to inspect. */
export function fixtureCompletion(payload) {
  if (payload.messages[0].content.startsWith("Review an HN"))
    return textFrame(
      "Scripted review: these links use synthetic HN metadata. Article contents were not retrieved.",
    );

  const contextMessage = payload.messages.find(
    (message) =>
      message.role === "user" &&
      message.content.startsWith("Application context for this briefing:\n"),
  );
  const context = contextMessage
    ? JSON.parse(contextMessage.content.split("\n").slice(1).join("\n"))
    : {};
  let records = context.fixedWorkflowEvidence ?? [];
  for (const message of payload.messages) {
    if (message.role !== "tool") continue;
    try {
      const observation = JSON.parse(message.content);
      if (Array.isArray(observation.records)) records = observation.records;
    } catch {
      // Skill text is an observation too, but it is not a source batch.
    }
  }
  const answer = () =>
    textFrame(
      "Scripted preview: these links are examples based on synthetic metadata.\n\n" +
        records
          .slice(0, 3)
          .map((record) => `- [${record.title}](${record.canonicalUrl})`)
          .join("\n"),
    );
  if (payload.tool_choice === "none") return answer();
  const last = payload.messages.at(-1);
  const previousCall = [...payload.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.tool_calls)
    ?.tool_calls.at(-1);
  const user = [...payload.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        !message.content.startsWith("Application context for this briefing:\n"),
    );

  if (last.role === "user")
    return toolFrame("read_skill", { name: "hn-briefing" });
  if (previousCall?.function.name === "read_skill")
    return toolFrame(
      "list_stories",
      context.requestedListing ?? { category: "top", count: 3 },
    );
  if (previousCall?.function.name === "list_stories")
    return toolFrame("propose_briefing", {
      recommendations: records.slice(0, 3).map((record) => ({
        sourceId: record.id,
        note: "A scripted recommendation from the returned metadata.",
      })),
    });
  if (
    previousCall?.function.name === "propose_briefing" &&
    user?.content.toLowerCase().includes("save")
  )
    return toolFrame("save_reading_list", {
      sourceIds: records.slice(0, 3).map((record) => record.id),
    });
  return answer();
}
