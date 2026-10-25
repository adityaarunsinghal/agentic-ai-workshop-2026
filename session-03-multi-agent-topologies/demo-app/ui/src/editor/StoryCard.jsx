// LEARNING: Start with StoryCard(): render one story and translate its gestures into controller actions.
// Next: ui/src/editor/AutoResearch.jsx for the controls that research and revise a selected story.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { sentenceCss, styledSentences } from "../../../src/presentation.mjs";
import {
  CONTENT,
  MIN_FRAME,
  PX_PER_MM,
  boundFrame,
  layoutMeasurementKey,
  measureStoryLayout,
} from "../shared/geometry.mjs";
import { errorMessage, hasFactCheck, storyKey } from "../shared/state.mjs";
import { FactCheck } from "./FactCheck.jsx";
import { observedStoryLinks, sentenceDisplayParts } from "./story-text.mjs";

// Session 3 demo: the bundled story's planted errors are highlighted for the class. Before a
// fact-check every planted sentence is "planted"; after one, each is "caught" or "missed".
const PLANTED_LABELS = Object.freeze({
  planted: "Planted error",
  caught: "Planted error, caught and corrected",
  missed: "Planted error, missed",
});
function plantedMarksFor(story) {
  const marks = new Map();
  const result = story.plantedResult?.claims;
  if (Array.isArray(result) && result.length) {
    for (const claim of result) {
      if (typeof claim?.text === "string") marks.set(claim.text.trim(), claim.status === "caught" ? "caught" : "missed");
    }
    return marks;
  }
  for (const claim of story.plantedClaims ?? []) {
    if (typeof claim?.text === "string") marks.set(claim.text.trim(), "planted");
  }
  return marks;
}
function PlantedLegend({ story }) {
  const result = story.plantedResult?.claims;
  if (!Array.isArray(result) || !result.length) {
    return (
      <p className="planted-legend" aria-live="polite">
        <span className="planted-swatch planted-planted" /> Planted errors ({story.plantedClaims?.length ?? 0})
      </p>
    );
  }
  const caught = result.filter((claim) => claim.status === "caught").length;
  return (
    <p className="planted-legend" aria-live="polite">
      <span className="planted-swatch planted-caught" /> Caught ({caught})
      <span className="planted-swatch planted-missed" /> Missed ({result.length - caught})
    </p>
  );
}

const running = new Set([
  "pending",
  "queued",
  "researching",
  "reading",
  "writing",
  "running",
  "resizing",
  "fitting",
]);
const incomplete = new Set([
  "failed",
  "error",
  "incomplete",
  "interrupted",
  "cancelled",
  "canceled",
  "superseded",
  "needs_fit",
]);
const arrows = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// LEARNING: MAIN BEHAVIOR
export function StoryCard({
  story,
  job,
  controller,
  selected,
  scale,
  stage,
  demoMode = false,
  editorial,
  onSelect,
  onEvidence,
  onFit,
  onMeasure,
  onInspect,
  leadSuggested = false,
  pairs = [],
  selectedPair,
  onPair,
  paperTemplate = null,
  templatePlan,
}) {
  const frame = boundFrame(story.frame);
  const key = storyKey(story);
  const hasCopy = Boolean(story.headline || story.body);
  const plantedMarks = useMemo(() => (demoMode ? plantedMarksFor(story) : new Map()), [demoMode, story.plantedClaims, story.plantedResult]);
  const busy = running.has(job?.status ?? story.status);
  const needsFit =
    (job?.phase === "needs_fit" || story.status === "needs_fit") &&
    (!job?.prompt || job.prompt === story.prompt);
  const failed =
    incomplete.has(job?.status ?? story.status) ||
    Boolean(
      !busy &&
      ((typeof story.researchNote === "string" && story.researchNote.trim()) ||
        (!hasCopy && job)),
    );
  const [editing, setEditing] = useState(false);
  const [requestOpen, setRequestOpen] = useState(!hasCopy);
  const [overflow, setOverflow] = useState(story.status === "overflow");
  const copyRef = useRef(null);
  const articleRef = useRef(null);
  const keyFrame = useRef(null);
  const keyTimer = useRef(null);
  const current = useRef(null);
  current.current = { story, controller };
  const highlighted = pairs.find((pair) => {
    return pair.id === selectedPair;
  });
  const pending = controller.pending.filter((entry) => {
    return entry.target?.slotId === key;
  });
  const starting = pending.some((entry) => {
    return entry.name === "request_story";
  });
  const note = [story.researchNote, job?.answer, job?.explanation].find((value) => {
    return typeof value === "string" && value.trim();
  });
  const failure =
    note ||
    errorMessage(
      job?.error ||
        story.error ||
        (needsFit
          ? "Copy still needs fitting. Retry fitting to continue from the saved draft."
          : "More evidence is needed for this request."),
    );
  const alternate = story.alternateDraft;
  const canUseAlternate =
    alternate &&
    !story.locked &&
    !story.pinned &&
    JSON.stringify(story.sourceIds) === JSON.stringify(alternate.sourceIds);
  const resizeJob = job?.operation === "resize" || job?.phase === "resizing";
  const progress =
    job?.phase === "fitting"
      ? "Fitting copy"
      : resizeJob
        ? job?.status === "queued"
          ? "Resize queued"
          : "Resizing copy"
        : {
            queued: "Queued",
            pending: "Queued",
            writing: "Writing",
            reading: "Reading",
            rewriting: "Updating copy",
          }[job?.phase ?? job?.status ?? story.status] || "Researching";
  const sources = controller.state.issue.sources;
  const links = useMemo(() => {
    return observedStoryLinks(story, sources);
  }, [story.body, story.sourceIds, sources]);
  const candidateTemplate = templatePlan?.template;
  const candidateRole = templatePlan?.role;
  const candidateWidth = templatePlan?.width;

  function openObservedLink(event, href) {
    event.preventDefault();
    void controller.openLink(href);
  }

  // LEARNING: Measure the rendered copy and report its fit; model requests belong to the controller/server path.
  useEffect(() => {
    const node = copyRef.current;
    const article = articleRef.current;
    const signature = layoutMeasurementKey(story);
    const report = (measurement) => {
      return onMeasure(key, { key: signature, paperTemplate, ...measurement });
    };
    if (!node || !article || editing || requestOpen || busy || starting) {
      report({
        ready: false,
        reason:
          busy || starting
            ? "working"
            : editing
              ? "editing"
              : requestOpen
                ? "prompt"
                : "empty",
      });
      return;
    }
    let disposed = false;
    const measure = () => {
      if (disposed) {
        return;
      }
      const measured = measureStoryLayout(article);
      if (!measured) {
        return;
      }
      setOverflow(measured.overflow);
      onFit(key, measured.overflow);
      report({
        ready: node.ownerDocument.fonts?.status !== "loading",
        reason: node.ownerDocument.fonts?.status === "loading" ? "fonts" : null,
        ...measured,
        ...(candidateTemplate && Number.isFinite(candidateWidth)
          ? {
              template: {
                template: candidateTemplate,
                role: candidateRole,
                width: candidateWidth,
                requiredHeight: measureTemplateCopy(
                  article,
                  candidateTemplate,
                  candidateRole,
                  candidateWidth,
                ),
              },
            }
          : {}),
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) {
      observer.observe(node.firstElementChild);
    }
    for (const child of article.children) {
      observer.observe(child);
    }
    document.fonts?.ready.then(measure);
    measure();
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [
    story,
    sources,
    frame.width,
    frame.height,
    editing,
    requestOpen,
    busy,
    starting,
    key,
    onFit,
    onMeasure,
    paperTemplate,
    candidateTemplate,
    candidateRole,
    candidateWidth,
    leadSuggested,
  ]);
  useEffect(() => {
    return () => {
      return clearTimeout(keyTimer.current);
    };
  }, []);

  function keyMove(event) {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      onSelect(key);
      if (!story.locked) {
        setRequestOpen(false);
        setEditing(true);
      }
      return;
    }
    if (!arrows[event.key] || story.locked || story.pinned) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 5 : 1;
    const [dx, dy] = arrows[event.key];
    const previous = keyFrame.current ?? frame;
    const next = boundFrame(
      event.altKey
        ? {
            ...previous,
            width: previous.width + dx * step,
            height: previous.height + dy * step,
          }
        : { ...previous, x: previous.x + dx * step, y: previous.y + dy * step },
    );
    keyFrame.current = next;
    clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      void current.current.controller.moveStory(current.current.story, next);
      keyFrame.current = null;
    }, 300);
  }

  // LEARNING: The preview scale changes screen pixels; saved story frames remain in millimeters.
  return (
    <Rnd
      className={`story-rnd ${selected ? "selected" : ""} ${highlighted ? `paired-card ${highlighted.kind}` : ""} ${leadSuggested ? "suggested-lead-card" : ""}`}
      size={{ width: frame.width * PX_PER_MM, height: frame.height * PX_PER_MM }}
      position={{
        x: (frame.x - CONTENT.x) * PX_PER_MM,
        y: (frame.y - CONTENT.y) * PX_PER_MM,
      }}
      scale={scale}
      bounds="parent"
      minWidth={MIN_FRAME.width * PX_PER_MM}
      minHeight={MIN_FRAME.height * PX_PER_MM}
      maxWidth={CONTENT.width * PX_PER_MM}
      maxHeight={350 * PX_PER_MM}
      disableDragging={Boolean(story.locked || story.pinned)}
      enableResizing={selected && !story.locked && !story.pinned}
      dragHandleClassName="story-handle"
      cancel=".no-drag, input, textarea, form, [data-copy]"
      dragGrid={[PX_PER_MM, PX_PER_MM]}
      resizeGrid={[PX_PER_MM, PX_PER_MM]}
      onDragStart={() => {
        return onSelect(key);
      }}
      onDragStop={(_event, data) => {
        return controller.moveStory(story, {
          ...frame,
          x: CONTENT.x + data.x / PX_PER_MM,
          y: CONTENT.y + data.y / PX_PER_MM,
        });
      }}
      onResizeStart={() => {
        return onSelect(key);
      }}
      onResizeStop={(_event, _direction, element, _delta, position) => {
        return controller.moveStory(story, {
          x: CONTENT.x + position.x / PX_PER_MM,
          y: CONTENT.y + position.y / PX_PER_MM,
          width: element.offsetWidth / PX_PER_MM,
          height: element.offsetHeight / PX_PER_MM,
        });
      }}
      resizeHandleClasses={{
        top: "resize-edge",
        right: "resize-edge",
        bottom: "resize-edge",
        left: "resize-edge",
        topLeft: "resize-corner",
        topRight: "resize-corner",
        bottomLeft: "resize-corner",
        bottomRight: "resize-corner",
      }}
    >
      <article
        ref={articleRef}
        className={`newspaper-story ${!hasCopy ? "draft-slot" : ""} ${busy ? "pending-slot" : ""}`}
        data-story-id={key}
        data-lead={leadSuggested || undefined}
        aria-label={story.headline || story.prompt || "Empty story block"}
        onPointerDown={(event) => {
          return event.stopPropagation();
        }}
        onClick={() => {
          return onSelect(key);
        }}
      >
        <div
          className="story-handle"
          role="button"
          tabIndex={0}
          onKeyDown={keyMove}
          onFocus={() => {
            return onSelect(key);
          }}
          aria-disabled={story.locked || story.pinned}
          aria-label={`Move ${story.headline || "story block"}. Arrows move, Shift moves 5 millimeters, Alt resizes. Enter edits copy.`}
        >
          <span className="drag-mark" aria-hidden="true">
            ⠿
          </span>
          {leadSuggested && (
            <span
              className="lead-marker"
              aria-label="Suggested lead"
              title="Suggested lead"
            >
              ★
            </span>
          )}
          <span className="story-handle-actions no-drag">
            {!editing && (
              <button
                type="button"
                className="paper-button"
                disabled={story.locked}
                onClick={() => {
                  setRequestOpen(false);
                  setEditing(true);
                }}
              >
                Edit copy
              </button>
            )}
            <button
              type="button"
              className="paper-button"
              aria-pressed={Boolean(story.locked)}
              aria-label={story.locked ? "Unlock story" : "Pin and lock story"}
              onClick={() => {
                return controller.lockStory(story);
              }}
            >
              {story.locked ? "◆" : "◇"}
            </button>
            <button
              type="button"
              className="paper-button"
              disabled={story.locked}
              aria-label="Remove this story block"
              onClick={(event) => {
                event.stopPropagation();
                void controller.deleteStory(story);
                onSelect(null);
              }}
            >
              ×
            </button>
          </span>
        </div>
        {editing ? (
          <InlineCopyEditor
            story={story}
            controller={controller}
            onDone={() => {
              return setEditing(false);
            }}
          />
        ) : hasCopy ? (
          <div
            className="story-copy-scroll no-drag"
            ref={copyRef}
            data-copy
            tabIndex={0}
            aria-label="Story copy"
          >
            <div className="story-copy">
              {story.headline && <h3>{story.headline}</h3>}
              <div className="story-body">
                {styledSentences(story).map((sentence) => {
                  const planted = plantedMarks.get(sentence.text.trim());
                  return (
                    <span
                      key={sentence.id}
                      data-sentence-id={sentence.id}
                      className={planted ? `planted-claim planted-${planted}` : undefined}
                      title={planted ? PLANTED_LABELS[planted] : undefined}
                      style={sentenceCss(sentence.style)}
                    >
                      {sentenceDisplayParts(sentence, links).map((part, index) => {
                        return part.href ? (
                          <a
                            key={part.start}
                            href={part.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={part.href}
                            onClick={(event) => {
                              return openObservedLink(event, part.href);
                            }}
                            onAuxClick={(event) => {
                              if (event.button === 1) {
                                openObservedLink(event, part.href);
                              }
                            }}
                          >
                            {part.text}
                          </a>
                        ) : (
                          <React.Fragment key={`text:${index}`}>
                            {part.text}
                          </React.Fragment>
                        );
                      })}
                    </span>
                  );
                })}
              </div>
              {plantedMarks.size > 0 && <PlantedLegend story={story} />}
            </div>
          </div>
        ) : (
          !requestOpen && (
            <p className="inline-note">Edit copy or ask for a story in this block.</p>
          )
        )}
        {(busy || starting) && (
          <div className="story-progress with-copy">
            <div className="story-progress-line" role="status">
              <strong>
                {starting && !busy
                  ? needsFit
                    ? "Resuming fitting"
                    : "Starting research"
                  : progress}
                …
              </strong>
              {busy && (
                <button
                  type="button"
                  className="paper-button no-drag"
                  onClick={() => {
                    return controller.cancelStory(story);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        {failed && !busy && (
          <p className="research-note" role="status">
            {failure}
          </p>
        )}
        {requestOpen && (
          <form
            className="inline-request no-drag"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await controller.requestStory(story, story.prompt || "")) {
                setRequestOpen(false);
              }
            }}
          >
            <label htmlFor={`topic-${key}`}>Give me a story about ___ here</label>
            <textarea
              id={`topic-${key}`}
              value={story.prompt || ""}
              maxLength={4000}
              rows={2}
              required
              placeholder="Topic…"
              disabled={story.locked}
              onChange={(event) => {
                return controller.draftPrompt(story, event.target.value);
              }}
              onBlur={() => {
                void controller.flushDraft(key);
              }}
            />
            <div className="inline-request-actions">
              <button
                type="submit"
                className="paper-button"
                disabled={story.locked || busy || starting || !story.prompt?.trim()}
              >
                {needsFit ? "Retry fitting" : failed ? "Retry research" : "Research"}
              </button>
              <button
                type="button"
                className="paper-button"
                onClick={() => {
                  return setRequestOpen(false);
                }}
              >
                Close prompt
              </button>
            </div>
          </form>
        )}
        {alternate && (
          <div className="alternate-draft no-drag">
            <span>Alternate draft retained</span>
            <button
              type="button"
              className="paper-button"
              onClick={() => {
                return onInspect(alternate, "Retained alternate draft");
              }}
            >
              Inspect
            </button>
            {canUseAlternate && (
              <button
                type="button"
                className="paper-button"
                onClick={() => {
                  setEditing(false);
                  void controller.useAlternate(story);
                }}
              >
                Use this draft
              </button>
            )}
          </div>
        )}
        <div className="story-card-footer no-drag">
          {!editing && (
            <span
              className="overflow-label"
              aria-hidden={!overflow}
              style={{ visibility: overflow ? "visible" : "hidden" }}
            >
              Copy exceeds this block. Resize it to fit the copy.
            </span>
          )}
          <div className="story-source-row">
            {!requestOpen && (
              <button
                type="button"
                className="paper-button"
                disabled={story.locked || (needsFit && (busy || starting))}
                onClick={() => {
                  if (needsFit) {
                    void controller.requestStory(story, story.prompt || "");
                    return;
                  }
                  void controller.flushDraft(key);
                  setEditing(false);
                  setRequestOpen(true);
                }}
              >
                {needsFit ? "Retry fitting" : failed ? "Retry research" : "Ask"}
              </button>
            )}
            <button
              type="button"
              className="source-count"
              onClick={() => {
                return onEvidence(story);
              }}
            >
              Evidence{story.sourceIds?.length ? ` · ${story.sourceIds.length}` : ""}
            </button>
            {pairs.map((pair) => {
              return (
                <button
                  type="button"
                  className={`paper-pair-tag ${pair.kind}`}
                  key={pair.id}
                  title={`${pair.label}: ${pair.stories
                    .map((item) => {
                      return item.headline || item.prompt;
                    })
                    .join(" / ")}`}
                  aria-label={`Highlight pair ${pair.number}: ${pair.label}`}
                  onClick={() => {
                    return onPair(pair);
                  }}
                >
                  ↔ {pair.number}
                </button>
              );
            })}
            <button
              type="button"
              className="paper-button"
              aria-label="Inspect story record"
              onClick={() => {
                return onInspect(story, "Story record");
              }}
            >
              ⋯
            </button>
          </div>
          {hasFactCheck(stage) && hasCopy && (
            <FactCheck
              story={story}
              editorial={editorial}
              compact
              onClick={() => {
                return onEvidence(story);
              }}
            />
          )}
        </div>
      </article>
    </Rnd>
  );
}

// LEARNING: SUPPORTING HELPERS
// Offscreen measurement and the inline copy editor used by StoryCard.
function measureTemplateCopy(article, template, role, width) {
  // Measure the same rendered copy under the proposed paper CSS and width.
  // This inert, offscreen clone never changes the live block or its text.
  const probe = article.ownerDocument.createElement("div");
  probe.className = "newspaper-page";
  probe.dataset.template = template;
  probe.setAttribute("aria-hidden", "true");
  probe.setAttribute("inert", "");
  Object.assign(probe.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${width}mm`,
    height: "auto",
    transform: "none",
    visibility: "hidden",
    pointerEvents: "none",
  });
  const copy = article.cloneNode(true);
  copy.removeAttribute("data-story-id");
  copy.dataset.lead = String(role === "lead");
  for (const element of copy.querySelectorAll("[id]")) {
    element.removeAttribute("id");
  }
  Object.assign(copy.style, { height: "auto", minHeight: "0", overflow: "visible" });
  const scroll = copy.querySelector(".story-copy-scroll");
  if (scroll) {
    Object.assign(scroll.style, {
      flex: "none",
      height: "auto",
      maxHeight: "none",
      overflow: "visible",
    });
  }
  probe.append(copy);
  try {
    (article.closest(".editor-app") ?? article.ownerDocument.body).append(probe);
    return Math.max(
      MIN_FRAME.height,
      Math.max(copy.offsetHeight, copy.scrollHeight) / PX_PER_MM + 1,
    );
  } finally {
    probe.remove();
  }
}

function InlineCopyEditor({ story, controller, onDone }) {
  // A focused editor owns its buffer. Server responses cannot replace a
  // selection or partially typed text, even before the next change event.
  const [copy, setCopy] = useState(() => {
    return { headline: story.headline || "", body: story.body || "" };
  });
  const version = useRef(0);
  const [saving, setSaving] = useState(false);
  function change(patch) {
    version.current++;
    setCopy((previous) => {
      return { ...previous, ...patch };
    });
    controller.draftStory(story, patch);
  }
  return (
    <div className="inline-copy-editor no-drag">
      <label>
        Headline
        <textarea
          aria-label="Story headline"
          rows={1}
          value={copy.headline}
          maxLength={200}
          disabled={story.locked}
          autoFocus={!story.headline}
          onChange={(event) => {
            return change({ headline: event.target.value });
          }}
          onBlur={() => {
            void controller.flushDraft(storyKey(story));
          }}
        />
      </label>
      <label>
        Copy
        <textarea
          aria-label="Story body"
          rows={5}
          value={copy.body}
          disabled={story.locked}
          autoFocus={Boolean(story.headline)}
          onChange={(event) => {
            return change({ body: event.target.value });
          }}
          onBlur={() => {
            void controller.flushDraft(storyKey(story));
          }}
        />
      </label>
      {copy.body.length > 6000 && (
        <p className="inline-note">
          Shorten to 6,000 characters to save. Your full edit is retained.
        </p>
      )}
      <button
        type="button"
        className="paper-button"
        disabled={saving}
        onClick={async () => {
          const finishingVersion = version.current;
          setSaving(true);
          const saved = await controller.flushDraft(storyKey(story));
          setSaving(false);
          if (saved && version.current === finishingVersion) {
            onDone();
          }
        }}
      >
        {saving ? "Saving…" : "Done editing"}
      </button>
    </div>
  );
}
