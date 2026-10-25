// LEARNING: Start with ToolsStage(): direct MCP calls and agent briefings share this first stage.
// Next: ui/src/host/AppFrame.jsx to see how an MCP HTML resource becomes an interactive editor.

import React, { lazy, Suspense, useState } from "react";
import { JsonInspector } from "../shared/Inspector.jsx";
import { MarkdownView } from "../shared/MarkdownView.jsx";
import { errorMessage, structuredResult, toolError } from "../shared/state.mjs";
import { briefingText, briefingViews } from "../shared/briefings.mjs";
import { durationLabel, isRunning } from "../shared/execution.mjs";

const JsonArguments = lazy(() => {
  return import("../shared/JsonArguments.jsx").then((module) => {
    return { default: module.JsonArguments };
  });
});

const tools = [
  ["search_web", "Search the web", { query: "agent reliability research", limit: 5 }],
  ["read_skill", "HN briefing skill", { name: "hn-briefing" }],
  ["list_stories", "HN feed", { category: "top", count: 5 }],
  ["search_hn", "Search Hacker News", { query: "agents", limit: 5 }],
  ["search_google_news", "Search Google News", { query: "AI agents", limit: 5 }],
  ["fetch_read", "Fetch & read a source", { url: "https://example.com/" }],
  ["get_story", "HN story details", { id: 1 }],
  ["get_comments", "HN comments", { id: 1, limit: 5, maxDepth: 2 }],
  ["propose_briefing", "Choose briefing sources", { sourceIds: [] }],
  ["inspect_user_preferences", "Reader preferences", {}],
];

// LEARNING: MAIN BEHAVIOR
export function ToolsStage({ state, callTool, onInspect, onExecution, onOpenLink }) {
  const [name, setName] = useState(tools[0][0]);
  const [argumentsText, setArgumentsText] = useState(
    JSON.stringify(tools[0][2], null, 2),
  );
  const [result, setResult] = useState(null);
  const [resultTool, setResultTool] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [submittedJob, setSubmittedJob] = useState(null);
  const [toolEditorOpened, setToolEditorOpened] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const briefings = briefingViews(state, submittedJob);
  const skillText = resultTool === "read_skill" ? structuredResult(result)?.text : null;
  // LEARNING: A direct tool call sends the student's JSON; it does not ask a model to choose a tool.
  async function runTool(event) {
    event.preventDefault();
    setError("");
    let args;
    try {
      args = JSON.parse(argumentsText);
      if (!args || Array.isArray(args) || typeof args !== "object") {
        throw new Error("Arguments must be a JSON object.");
      }
    } catch (failure) {
      setError(failure.message);
      return;
    }
    setWorking(true);
    try {
      const response = await callTool(name, args);
      setResult(response);
      setResultTool(name);
      const failure = toolError(response);
      if (failure) {
        throw failure;
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setWorking(false);
    }
  }
  // LEARNING: A briefing request starts server-owned agent work; later snapshots report its progress.
  async function ask(event) {
    event.preventDefault();
    if (!prompt.trim()) {
      return;
    }
    setWorking(true);
    setError("");
    try {
      const response = await callTool("request_briefing", { prompt: prompt.trim() });
      const failure = toolError(response);
      if (failure) {
        throw failure;
      }
      setSubmittedJob(structuredResult(response)?.job ?? null);
      setPrompt("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setWorking(false);
    }
  }
  async function cancelBriefing(briefing) {
    if (!briefing.canCancel || cancelling) {
      return;
    }
    setCancelling(briefing.job.id);
    setError("");
    try {
      const response = await callTool("cancel_briefing", { jobId: briefing.job.id });
      const failure = toolError(response);
      if (failure) {
        throw failure;
      }
      // A submitted-job placeholder can outlive a cancellation response until
      // the next state arrives; do not leave that placeholder looking active.
      setSubmittedJob((previous) => {
        return previous?.id === briefing.job.id ? null : previous;
      });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setCancelling(null);
    }
  }
  return (
    <section className="tools-stage" aria-label="MCP tools stage">
      <div className="tools-welcome">
        <p className="eyebrow">STAGE 1 · MCP BRIEFING</p>
        <h2>Ask for a research briefing.</h2>
        <p>
          Use the familiar Session 1 agent with web search, HN and news tools. Follow
          its source choices and answer, then open Execution to inspect the request and
          turns.
        </p>
      </div>
      <form className="host-composer" onSubmit={ask}>
        <label htmlFor="agent-prompt">What would you like to research?</label>
        <textarea
          id="agent-prompt"
          value={prompt}
          onChange={(event) => {
            return setPrompt(event.target.value);
          }}
          rows={3}
          required
          maxLength={4000}
          placeholder="Find evidence about how builders are making agents more reliable."
        />
        <div className="section-head">
          <span className="hint">Up to 10 turns per agent run</span>
          <button type="submit" disabled={working || !prompt.trim()}>
            {working ? "Sending…" : "Ask for a briefing"}
          </button>
        </div>
      </form>
      {briefings.map((briefing) => {
        return (
          <article
            className="host-story host-briefing"
            key={briefing.id ?? briefing.jobId}
          >
            <div className="section-head">
              <span className="trace-badge" data-role="agent">
                agent
              </span>
              <span className="hint" role="status">
                {briefing.status}
                {briefing.job?.turn != null
                  ? ` · Turn ${briefing.job.turn}/${briefing.job.maxTurns ?? 10}`
                  : ""}
              </span>
              {briefing.executionHistory.available !== false &&
                (briefing.jobId || briefing.executionHistory.recordId) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      return onExecution?.(
                        briefing.executionHistory.recordId,
                        briefing.job?.taskId ?? briefing.taskId ?? briefing.jobId ?? "",
                      );
                    }}
                  >
                    Open Execution
                  </button>
                )}
              {briefing.canCancel && (
                <button
                  type="button"
                  className="quiet"
                  disabled={cancelling !== null}
                  onClick={() => {
                    return cancelBriefing(briefing);
                  }}
                >
                  {cancelling === briefing.job.id ? "Cancelling…" : "Cancel briefing"}
                </button>
              )}
            </div>
            {briefing.executionHistory.available === false && (
              <p className="hint" role="status">
                {briefing.executionHistory.label} Inspect the saved briefing below.
              </p>
            )}
            <h2>{briefing.prompt || "Selected briefing sources"}</h2>
            {briefing.answer && (
              <MarkdownView
                className="briefing-answer"
                text={briefing.answer}
                onOpenLink={onOpenLink}
              />
            )}
            {!briefing.answer && briefing.partialText && (
              <div className="briefing-partial">
                <p className="hint">
                  {isRunning(briefing)
                    ? "Agent response in progress"
                    : "Saved partial response"}
                </p>
                <MarkdownView
                  className="briefing-answer"
                  text={briefing.partialText}
                  onOpenLink={onOpenLink}
                  showSource={false}
                />
              </div>
            )}
            {isRunning(briefing) && (
              <div className="briefing-progress">
                <p role="status">
                  {briefing.status === "queued"
                    ? "Briefing queued…"
                    : briefing.phase === "generating"
                      ? "The agent is responding…"
                      : "The agent is preparing the briefing…"}
                </p>
                <progress aria-label="Briefing request in progress" />
              </div>
            )}
            {briefing.error && (
              <p className="notice" role="alert">
                {errorMessage(briefing.error)}
              </p>
            )}
            {!briefing.answer &&
              !isRunning(briefing) &&
              !briefing.error &&
              !briefing.cards.length && (
                <p className="hint">
                  No answer was returned for this request.{" "}
                  {briefing.executionHistory.available === false
                    ? "Inspect the saved result below."
                    : "Inspect its outcome in Execution."}
                </p>
              )}
            {briefing.cards.length > 0 && (
              <ol className="briefing-cards">
                {briefing.cards.map((value, index) => {
                  const card = typeof value === "string" ? { sourceId: value } : value;
                  const source = state.issue.sources.find((item) => {
                    return item.id === (card.sourceId ?? card.id);
                  });
                  return (
                    <li key={card.id ?? card.sourceId ?? index}>
                      <h3>
                        {card.title ||
                          card.headline ||
                          source?.title ||
                          "Briefing source"}
                      </h3>
                      <p>
                        {briefingText(
                          card.note ?? card.summary ?? card.body ?? card.text,
                        )}
                      </p>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          return onInspect(source ?? card, "Briefing source");
                        }}
                      >
                        Inspect source ↗
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="hint">
              {briefing.sourceIds.length} observed source references
              {briefing.job?.model ? ` · ${briefing.job.model}` : ""}
              {briefing.job?.durationMs != null
                ? ` · ${durationLabel(briefing.job.durationMs)}`
                : ""}
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                return onInspect(
                  briefing,
                  briefing.executionHistory.available === false
                    ? "Saved briefing result · full trace unavailable"
                    : "Briefing result",
                );
              }}
            >
              {briefing.executionHistory.available === false
                ? "Inspect saved briefing"
                : "Inspect briefing"}{" "}
              ↗
            </button>
          </article>
        );
      })}
      <details
        className="tools-laboratory"
        onToggle={(event) => {
          // Load once on demand; retaining the mount preserves editor history
          // and selection when this optional panel is collapsed and reopened.
          if (event.currentTarget.open) {
            setToolEditorOpened(true);
          }
        }}
      >
        <summary>Call a research tool directly</summary>
        <form onSubmit={runTool}>
          <label>
            Tool
            <select
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setArgumentsText(
                  JSON.stringify(
                    tools.find(([id]) => {
                      return id === event.target.value;
                    })[2],
                    null,
                    2,
                  ),
                );
              }}
            >
              {tools.map(([id, label]) => {
                return (
                  <option key={id} value={id}>
                    {label} · {id}
                  </option>
                );
              })}
            </select>
          </label>
          {toolEditorOpened && (
            <Suspense
              fallback={
                <p className="hint" role="status">
                  Loading JSON editor…
                </p>
              }
            >
              <JsonArguments value={argumentsText} onChange={setArgumentsText} />
              <button type="submit" className="quiet" disabled={working}>
                {working ? "Calling tool…" : "Call MCP tool"}
              </button>
            </Suspense>
          )}
        </form>
      </details>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {result && (
        <section className="tool-result">
          <div className="section-head">
            <h3>Tool result</h3>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                return onInspect(result, "Complete MCP tool result");
              }}
            >
              Inspect full JSON ↗
            </button>
          </div>
          {typeof skillText === "string" && (
            <MarkdownView text={skillText} onOpenLink={onOpenLink} />
          )}
          <details>
            <summary>Returned MCP content</summary>
            <JsonInspector value={result} />
          </details>
        </section>
      )}
    </section>
  );
}
