// LEARNING: Start with Editor(): compose the newspaper and connect its controls to useEditor.
// Next: ui/src/editor/PageCanvas.jsx for the physical page and its StoryCard components.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useEditor } from "./useEditor.jsx";
import { PageCanvas } from "./PageCanvas.jsx";
import { SourcePool } from "./SourcePool.jsx";
import { Evidence } from "./Evidence.jsx";
import { Dialog } from "../shared/Dialog.jsx";
import { RecordDialog } from "../shared/Inspector.jsx";
import { Popover, PopoverClose } from "../shared/Popover.jsx";
import { EditorialStatus } from "./EditorialStatus.jsx";
import { LayoutSuggestion } from "./LayoutSuggestion.jsx";
import { AutoResearch } from "./AutoResearch.jsx";
import { PAPER_TEMPLATES, EDITORIAL_BASES } from "../../../src/layout-templates.mjs";
import { persistenceDisplay } from "../shared/persistence.mjs";
import { savedExecutionResult } from "../shared/briefings.mjs";
import { layoutMeasurementKey } from "../shared/geometry.mjs";
import { STAGES, exportDescriptor, storyKey } from "../shared/state.mjs";
import {
  editorialPairs,
  recommendedView,
  suggestedLead,
} from "../shared/editorial.mjs";

// LEARNING: MAIN BEHAVIOR
export function Editor() {
  const controller = useEditor();
  const { state } = controller;
  const [selected, setSelected] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [evidenceKey, setEvidenceKey] = useState(null);
  const [issueSettings, setIssueSettings] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [panel, setPanel] = useState(null);
  const [layoutProposal, setLayoutProposal] = useState(null);
  const [fit, setFit] = useState({});
  const [measurements, setMeasurements] = useState({});
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedPair, setSelectedPair] = useState(null);
  const paperAction = useRef(0);
  const newSlot = useRef(null);
  const bindNewSlot = useCallback((createSlot) => {
    newSlot.current = createSlot;
  }, []);
  const onFit = useCallback((key, overflow) => {
    setFit((previous) => {
      return previous[key] === overflow ? previous : { ...previous, [key]: overflow };
    });
  }, []);
  const onMeasure = useCallback((key, measurement) => {
    setMeasurements((previous) => {
      const old = previous[key];
      return old?.key === measurement.key &&
        old?.ready === measurement.ready &&
        old?.reason === measurement.reason &&
        old?.requiredHeight === measurement.requiredHeight &&
        old?.overflow === measurement.overflow &&
        old?.bodyHeight === measurement.bodyHeight &&
        old?.availableBodyHeight === measurement.availableBodyHeight &&
        old?.minimumLineHeight === measurement.minimumLineHeight &&
        old?.paperTemplate === measurement.paperTemplate &&
        JSON.stringify(old?.template) === JSON.stringify(measurement.template)
        ? previous
        : { ...previous, [key]: measurement };
    });
  }, []);
  // LEARNING: Measurements are observations; the controller reports fit to the server without rewriting copy here.
  useEffect(() => {
    if (!state || controller.dirty || controller.pending.length) {
      return;
    }
    for (const story of state.issue.stories) {
      const measurement = measurements[storyKey(story)];
      if (
        !story.locked &&
        measurement?.ready &&
        measurement.key === layoutMeasurementKey(story) &&
        (measurement.overflow || story.renderedFit?.status === "awaiting_measurement")
      ) {
        controller.reportRenderedFit(story, measurement);
      }
    }
  }, [
    state,
    measurements,
    controller.dirty,
    controller.pending.length,
    controller.reportRenderedFit,
  ]);
  const inspect = useCallback((record, title) => {
    return setInspection({ record, title });
  }, []);
  const select = useCallback((key) => {
    return setSelected(key);
  }, []);
  const showExecution = useCallback(
    (id = null, taskId = "") => {
      const retained = id ? savedExecutionResult(state, id) : null;
      if (retained) {
        inspect(retained, "Saved result from an earlier visit");
        return;
      }
      void controller.openExecution(id, taskId);
    },
    [state, inspect, controller.openExecution],
  );
  useEffect(() => {
    if (!state) {
      return;
    }
    const ids = new Set(state.issue.stories.map(storyKey));
    setMeasurements((previous) => {
      return Object.keys(previous).every((id) => {
        return ids.has(id);
      })
        ? previous
        : Object.fromEntries(
            Object.entries(previous).filter(([id]) => {
              return ids.has(id);
            }),
          );
    });
  }, [state?.issue.id, state?.issue.stories]);

  useEffect(() => {
    function shortcut(event) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") {
        return;
      }
      if (event.target.closest("input, textarea, select, [contenteditable=true]")) {
        return;
      }
      event.preventDefault();
      if (
        !controller.resetting &&
        !controller.pending.length &&
        !controller.failed.length &&
        !controller.dirty
      ) {
        void controller.run(event.shiftKey ? "redo" : "undo");
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => {
      return document.removeEventListener("keydown", shortcut);
    };
  }, [
    controller.run,
    controller.resetting,
    controller.pending.length,
    controller.failed.length,
    controller.dirty,
  ]);

  if (!state) {
    return (
      <main className="app-loading" aria-live="polite">
        <span className="identity-mark">E</span>
        <p className="eyebrow">SESSION 3</p>
        <h1>Multi-agent fact-checker</h1>
        <p>{controller.error || "Connecting to your newspaper…"}</p>
        {controller.connection.isConnected && (
          <button type="button" className="quiet" onClick={controller.refresh}>
            Reload issue
          </button>
        )}
      </main>
    );
  }
  const story = state.issue.stories.find((item) => {
    return storyKey(item) === selected;
  });
  const resolvedSelected = story ? storyKey(story) : null;
  const evidence = state.issue.stories.find((item) => {
    return storyKey(item) === evidenceKey;
  });
  const saveBusy =
    controller.resetting || controller.pending.length > 0 || controller.dirty;
  const saveStatus = persistenceDisplay(state.persistence, {
    pending: saveBusy,
    failed: controller.failed.length > 0,
    resetting: controller.resetting,
  });
  const overflow = state.issue.stories.some((item) => {
    return !item.hidden && fit[storyKey(item)];
  });
  const canExport =
    !controller.resetting &&
    state.issue.stories.some((item) => {
      return item.headline || item.body;
    }) &&
    !overflow &&
    !controller.failed.length;
  const recommendation = recommendedView(state.settings);
  const appliedTemplate = PAPER_TEMPLATES[state.issue.layoutTemplate];
  const hasRecommendation =
    state.editorial?.status === "complete" ||
    state.editorialHistory?.some((receipt) => {
      return receipt.status === "complete";
    });
  const lead = suggestedLead(state.issue);
  const pairs = editorialPairs(state.issue);
  const editorialBusy = state.editorial?.status === "running";
  // LEARNING: Suggestions, applied geometry and completed approval are separate pieces of server state.
  const layoutSettled =
    state.layoutOperation?.status === "complete" &&
    state.layoutOperation.resultRevision === state.issue.revision;
  const reviewBusy =
    editorialBusy ||
    controller.pending.some((entry) => {
      return entry.name === "editorialize_board";
    });
  const stage = STAGES.find((item) => {
    return item.id === state.settings.stage;
  });
  function comparePair(pair) {
    setSelectedPair(pair.id);
    setPanel(null);
  }

  function create(frame) {
    const slot = controller.createSlot(frame);
    if (!slot) {
      return null;
    }
    setSelected(storyKey(slot));
    setPanel(null);
    return slot;
  }
  function showEvidence(item) {
    setEvidenceKey(storyKey(item));
  }
  async function download() {
    // LEARNING: Export waits for local edits to be saved and downloads the acknowledged newspaper.
    const action = paperAction.current;
    setExporting(true);
    setNotice("");
    try {
      if (!(await controller.flushAll())) {
        return;
      }
      if (action !== paperAction.current) {
        return;
      }
      const result = await controller.run("export_newspaper", { format: "html" });
      if (!result || action !== paperAction.current) {
        return;
      }
      const artifact = exportDescriptor(result);
      if (!artifact) {
        setNotice("The export returned no downloadable artifact.");
        return;
      }
      if ((await controller.openLink(artifact.url)) && action === paperAction.current) {
        setNotice(
          `${artifact.filename || "Newspaper"} is ready. Revision ${artifact.revision ?? state.issue.revision}.`,
        );
      }
    } finally {
      setExporting(false);
    }
  }
  async function startNewspaper() {
    paperAction.current++;
    if (!(await controller.newNewspaper())) {
      return;
    }
    setSelected(null);
    setSelectedPair(null);
    setEvidenceKey(null);
    setInspection(null);
    setIssueSettings(false);
    setPreferences(false);
    setPanel(null);
    setLayoutProposal(null);
    setFit({});
    setMeasurements({});
    setNotice("");
  }

  return (
    <main
      className="editor-app"
      data-stage={state.settings.stage}
      inert={controller.resetting || undefined}
      aria-busy={controller.resetting}
    >
      <a className="skip-link" href="#newspaper-workspace">
        Skip to newspaper
      </a>
      <header className="editor-header">
        <h1>Newspaper</h1>
        <div
          className="save-indicator"
          role="status"
          title={saveStatus.label}
          aria-label={saveStatus.label}
        >
          {(saveStatus.busy || saveStatus.saved) && (
            <span
              className={saveStatus.busy ? "working-dot" : "saved-dot"}
              aria-hidden="true"
            />
          )}
          <span>
            {saveStatus.saved
              ? "Saved"
              : saveStatus.busy
                ? "Saving…"
                : saveStatus.label}
          </span>
        </div>
        <div className="editor-primary-actions">
          <button
            type="button"
            className="quiet"
            aria-label="Add story"
            disabled={controller.resetting}
            onClick={() => {
              return newSlot.current?.();
            }}
          >
            + Story
          </button>
        </div>
        <div className="editor-history-actions">
          <button
            type="button"
            className="text-button icon-button"
            aria-label="Undo"
            disabled={saveBusy || Boolean(controller.failed.length)}
            onClick={() => {
              return controller.run("undo");
            }}
            title="Undo · Ctrl/⌘ Z"
          >
            ↶
          </button>
          <button
            type="button"
            className="text-button icon-button"
            aria-label="Redo"
            disabled={saveBusy || Boolean(controller.failed.length)}
            onClick={() => {
              return controller.run("redo");
            }}
            title="Redo · Ctrl/⌘ Shift Z"
          >
            ↷
          </button>
        </div>
        <button
          type="button"
          className="quiet review-button"
          disabled={
            saveBusy ||
            reviewBusy ||
            !state.issue.stories.some((item) => {
              return item.headline || item.body;
            })
          }
          onClick={async () => {
            if (await controller.flushAll()) {
              await controller.run("editorialize_board", {
                reason: "editor_requested_review",
                retry: state.editorial?.status === "failed",
              });
            }
          }}
        >
          {reviewBusy
            ? "Reviewing…"
            : state.editorial?.status === "failed"
              ? "Retry review"
              : "Review issue"}
        </button>
        <div className="export-controls">
          <button
            type="button"
            disabled={exporting || !canExport}
            onClick={download}
            aria-label="Download final newspaper"
            title="Download the current newspaper as HTML"
          >
            <span>{exporting ? "Preparing…" : "Download"}</span>
            <span aria-hidden="true">↓</span>
          </button>
        </div>
        <Popover
          label="Editor settings"
          className="settings-popover"
          trigger={
            <button
              type="button"
              className="text-button icon-button"
              aria-label="Editor settings"
              title="Editor settings"
            >
              •••
            </button>
          }
        >
          <div className="popover-actions">
            <div className="compact-history-menu">
              <button
                type="button"
                className="text-button"
                disabled={saveBusy || Boolean(controller.failed.length)}
                onClick={() => {
                  return controller.run("undo");
                }}
              >
                ↶ Undo
              </button>
              <button
                type="button"
                className="text-button"
                disabled={saveBusy || Boolean(controller.failed.length)}
                onClick={() => {
                  return controller.run("redo");
                }}
              >
                ↷ Redo
              </button>
            </div>
            <PopoverClose asChild>
              <button
                type="button"
                className="text-button"
                disabled={controller.resetting || !controller.connection.isConnected}
                onClick={() => {
                  return controller.run("set_demo_mode", { on: !state.settings.demoMode });
                }}
              >
                {state.settings.demoMode ? "Turn off demo mode" : "Turn on demo mode"}
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  return setPanel("sources");
                }}
              >
                Discover sources
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button
                type="button"
                className="text-button"
                disabled={controller.resetting}
                onClick={() => {
                  return setIssueSettings(true);
                }}
              >
                Masthead & focus
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button
                type="button"
                className="text-button"
                disabled={controller.resetting}
                onClick={() => {
                  return setPreferences(true);
                }}
              >
                Reader preferences
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button
                type="button"
                className="text-button"
                disabled={controller.resetting || !controller.connection.isConnected}
                onClick={startNewspaper}
              >
                {controller.resetting
                  ? "Starting new newspaper…"
                  : "Start new newspaper"}
              </button>
            </PopoverClose>
          </div>
        </Popover>
      </header>
      <section className="editorial-row" aria-label="Editorial choices">
        {state.editorial ? (
          <EditorialStatus
            editorial={state.editorial}
            issueRevision={state.issue.revision}
            settled={layoutSettled}
            summary
          />
        ) : (
          <span className="editorial-idle">Ready to review</span>
        )}
        <div className="editorial-style">
          <span>
            Suggested:{" "}
            <strong>
              {hasRecommendation && recommendation ? recommendation.label : "Pending"}
            </strong>
          </span>
          <span>
            Applied: <strong>{appliedTemplate?.label || "Custom"}</strong>
          </span>
          <span
            className="typography-status"
            title="Sentence typography applies automatically; geometry requires approval."
          >
            Type: auto
          </span>
        </div>
        {layoutProposal && (
          <button
            type="button"
            className="text-button approval-prompt"
            onClick={() => {
              setPanel(null);
              document.getElementById("layout-approval")?.focus();
            }}
          >
            {layoutProposal.ok ? "Geometry needs approval" : "Layout needs attention"}
          </button>
        )}
        <button
          type="button"
          className="text-button context-toggle"
          aria-expanded={panel === "editorial"}
          onClick={() => {
            return setPanel(panel === "editorial" ? null : "editorial");
          }}
        >
          Details{state.suggestions.length ? ` · ${state.suggestions.length}` : ""}
        </button>
      </section>
      {stage?.autoResearch && (
        <AutoResearch
          key={`${state.issue.id}:${resolvedSelected || "none"}`}
          story={story}
          state={state}
          controller={controller}
          onExecution={showExecution}
          compact
          onDetails={() => {
            return setPanel("editorial");
          }}
        />
      )}
      {(controller.error || notice) && (
        <div className="notice app-notice" role={controller.error ? "alert" : "status"}>
          <span>{controller.error || notice}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              controller.dismissError();
              setNotice("");
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {controller.failed.map((entry) => {
        return (
          <div className="notice retained-change" key={entry.id}>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                return inspect(entry, "Retained local change");
              }}
            >
              {entry.name}: {entry.error}
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                return controller.retry(entry);
              }}
            >
              Retry change
            </button>
          </div>
        );
      })}
      {state.approvals.map((proposal) => {
        return (
          <section
            className="approval-strip"
            key={proposal.id}
            aria-label="Review proposed change"
          >
            <div>
              <p className="eyebrow">YOUR APPROVAL</p>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  return inspect(proposal, "Proposed saved change");
                }}
              >
                {proposal.kind === "preference"
                  ? `Remember “${proposal.value}”`
                  : `Save ${proposal.value?.length ?? 0} reading-list links`}{" "}
                ↗
              </button>
            </div>
            <div className="button-row">
              <button
                type="button"
                onClick={() => {
                  return controller.run("approve_change", {
                    approvalId: proposal.id,
                    accepted: true,
                  });
                }}
              >
                Approve
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  return controller.run("approve_change", {
                    approvalId: proposal.id,
                    accepted: false,
                  });
                }}
              >
                Decline
              </button>
            </div>
          </section>
        );
      })}
      <div
        className="editor-workspace"
        id="newspaper-workspace"
        tabIndex={-1}
        data-panel={panel || "none"}
      >
        <PageCanvas
          key={controller.paperGeneration}
          state={state}
          controller={controller}
          selected={resolvedSelected}
          onSelect={select}
          onCreate={create}
          onNewSlotReady={bindNewSlot}
          pairs={pairs}
          selectedPair={selectedPair}
          suggestedLeadId={lead && storyKey(lead)}
          onPair={comparePair}
          onEvidence={showEvidence}
          onFit={onFit}
          onMeasure={onMeasure}
          onInspect={inspect}
          onTitle={() => {
            return setIssueSettings(true);
          }}
        />
        {panel && (
          <ContextPanel
            title={panel === "sources" ? "Discover sources" : "Editorial details"}
            onClose={() => {
              return setPanel(null);
            }}
          >
            {panel === "sources" ? (
              <SourcePool
                sources={state.issue.sources}
                controller={controller}
                onInspect={inspect}
              />
            ) : (
              <>
                <p className="hint">{stage?.description}</p>
                <p>
                  Typography applies automatically. Suggested moves and resizes require
                  your approval.
                </p>
                {EDITORIAL_BASES[state.editorial?.answers?.layout_basis?.choice] && (
                  <p>
                    Editorial basis:{" "}
                    <strong>
                      {
                        EDITORIAL_BASES[state.editorial.answers.layout_basis.choice]
                          .label
                      }
                    </strong>
                  </p>
                )}
                {state.editorial ? (
                  <EditorialStatus
                    editorial={state.editorial}
                    issueRevision={state.issue.revision}
                    settled={layoutSettled}
                    onExecution={showExecution}
                  />
                ) : (
                  <p>Review issue for paper style and story relationship choices.</p>
                )}
                {lead && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      select(storyKey(lead));
                      setPanel(null);
                    }}
                  >
                    Suggested lead: {lead.headline || lead.prompt}
                  </button>
                )}
                {state.suggestions.length > 0 && (
                  <div
                    className="editorial-suggestions"
                    aria-label="Editorial suggestions"
                  >
                    {state.suggestions.map((suggestion) => {
                      return (
                        <button
                          type="button"
                          className="text-button"
                          key={suggestion.id}
                          onClick={() => {
                            const pair = pairs.find((item) => {
                              return item.id === suggestion.id;
                            });
                            if (pair) {
                              comparePair(pair);
                            } else {
                              inspect(suggestion, "Editorial suggestion");
                            }
                          }}
                        >
                          {suggestion.text || suggestion.label || suggestion.kind} ↗
                        </button>
                      );
                    })}
                  </div>
                )}
                {stage?.autoResearch && (
                  <AutoResearch
                    key={`${state.issue.id}:${resolvedSelected || "none"}`}
                    story={story}
                    state={state}
                    controller={controller}
                    onExecution={showExecution}
                    evidence
                  />
                )}
              </>
            )}
          </ContextPanel>
        )}
      </div>
      {!controller.resetting && (
        <LayoutSuggestion
          state={state}
          measurements={measurements}
          controller={controller}
          onProposalChange={setLayoutProposal}
        />
      )}
      {issueSettings && (
        <IssueSettings
          issue={state.issue}
          controller={controller}
          onClose={() => {
            return setIssueSettings(false);
          }}
        />
      )}
      {preferences && (
        <Preferences
          state={state}
          controller={controller}
          onClose={() => {
            return setPreferences(false);
          }}
          onInspect={inspect}
        />
      )}
      {evidence && (
        <Evidence
          story={evidence}
          state={state}
          controller={controller}
          onClose={() => {
            return setEvidenceKey(null);
          }}
          onInspect={inspect}
          onTrace={(id) => {
            setEvidenceKey(null);
            showExecution(id);
          }}
        />
      )}
      {inspection && (
        <RecordDialog
          record={inspection.record}
          title={inspection.title}
          onClose={() => {
            return setInspection(null);
          }}
        >
          {(inspection.record.canonicalUrl || inspection.record.url) && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                return controller.openLink(
                  inspection.record.canonicalUrl || inspection.record.url,
                );
              }}
            >
              Open original ↗
            </button>
          )}
        </RecordDialog>
      )}
    </main>
  );
}

// LEARNING: SUPPORTING HELPERS
// Dialogs and panels used by Editor.
function IssueSettings({ issue, controller, onClose }) {
  const [title, setTitle] = useState(issue.title);
  const [focus, setFocus] = useState(issue.focus);
  const [audience, setAudience] = useState(issue.audience || "builders");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog title="Masthead, focus & audience" onClose={onClose}>
      <form
        className="issue-settings"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving || controller.resetting) {
            return;
          }
          setSaving(true);
          try {
            const titleResult =
              title.trim() !== issue.title
                ? await controller.run(
                    "set_title",
                    { title: title.trim() },
                    { kind: "issue", patch: { title: title.trim() } },
                  )
                : true;
            const focusResult =
              focus.trim() !== issue.focus
                ? await controller.run(
                    "set_focus",
                    { focus: focus.trim() },
                    { kind: "issue", patch: { focus: focus.trim() } },
                  )
                : true;
            const audienceResult =
              audience.trim() !== (issue.audience || "builders")
                ? await controller.run(
                    "set_audience",
                    { audience: audience.trim() },
                    { kind: "issue", patch: { audience: audience.trim() } },
                  )
                : true;
            if (titleResult && focusResult && audienceResult) {
              onClose();
            }
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Newspaper title
          <input
            value={title}
            onChange={(event) => {
              return setTitle(event.target.value);
            }}
            required
            maxLength={120}
          />
        </label>
        <label>
          Editorial focus
          <textarea
            value={focus}
            onChange={(event) => {
              return setFocus(event.target.value);
            }}
            required
            rows={4}
            maxLength={2000}
          />
        </label>
        <label>
          Audience
          <input
            value={audience}
            onChange={(event) => {
              return setAudience(event.target.value);
            }}
            required
            maxLength={200}
            placeholder="Who is this newspaper for?"
          />
        </label>
        <button
          type="submit"
          disabled={
            saving ||
            controller.resetting ||
            !title.trim() ||
            !focus.trim() ||
            !audience.trim()
          }
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </Dialog>
  );
}

function Preferences({ state, controller, onClose, onInspect }) {
  const [topic, setTopic] = useState(state.preferences?.topic || "");
  return (
    <Dialog title="Reader preferences" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await controller.run("remember_preferences", {
            topic: topic.trim(),
          });
          if (result) {
            onClose();
          }
        }}
      >
        <label>
          Remember an interest
          <input
            value={topic}
            onChange={(event) => {
              return setTopic(event.target.value);
            }}
            maxLength={256}
          />
        </label>
        <p className="hint">
          You’ll review the exact proposed change before it is saved.
        </p>
        <button type="submit">Request save</button>
      </form>
      <h3 className="saved-links-title">Saved reading list</h3>
      {(state.preferences?.readingList || []).map((source) => {
        return (
          <div className="saved-source" key={source.id}>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                return onInspect(source, source.title);
              }}
            >
              {source.title}
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                return controller.openLink(source.url);
              }}
            >
              Open ↗
            </button>
          </div>
        );
      })}
      {!state.preferences?.readingList?.length && (
        <p className="empty">Save a source from the pool to build a reading list.</p>
      )}
    </Dialog>
  );
}

function ContextPanel({ title, onClose, children }) {
  const ref = useRef(null);
  const [mobile, setMobile] = useState(() => {
    return window.matchMedia("(max-width: 820px)").matches;
  });
  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const update = () => {
      return setMobile(media.matches);
    };
    media.addEventListener("change", update);
    return () => {
      return media.removeEventListener("change", update);
    };
  }, []);
  useEffect(() => {
    if (mobile) {
      return;
    }
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [mobile]);
  if (mobile) {
    return (
      <Dialog title={title} className="context-drawer" onClose={onClose}>
        {children}
      </Dialog>
    );
  }
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      className="editor-side-panel"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="panel-navigation">
        <span>{title}</span>
        <button
          type="button"
          className="text-button"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          Close
        </button>
      </div>
      <div className="panel-content">{children}</div>
    </aside>
  );
}
