import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PAPER_TEMPLATES, templateStoryPlans } from "../../../src/layout-templates.mjs";
import { CONTENT, PAGE, PX_PER_MM, emptyFrame, randomEmptyFrame } from "../shared/geometry.mjs";
import { storyKey } from "../shared/state.mjs";
import { Popover, PopoverClose } from "../shared/Popover.jsx";
import { StoryCard } from "./StoryCard.jsx";
import { MAX_ZOOM, MIN_ZOOM, useCanvasZoom } from "./useCanvasZoom.jsx";

function editionDate(date) {
  if (!date) return "Edition date not supplied";
  const parsed = new Date(`${String(date).slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? String(date)
    : parsed.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

export function PageCanvas({
  state, controller, selected, onSelect, onCreate, onEvidence, onFit, onMeasure, onTitle, onInspect,
  pairs = [], selectedPair, suggestedLeadId, onPair,
  onNewSlotReady,
}) {
  const viewport = useRef(null);
  const paper = useRef(null);
  const boundary = useRef(null);
  const pointerStart = useRef(null);
  const [notice, setNotice] = useState("");
  const { scale, mode: zoom, zoomTo, zoomBy, onKeyDown, suppressPointer } = useCanvasZoom({
    viewport, paper,
    cancelSelection: () => { pointerStart.current = null; },
  });
  const stories = state.issue.stories.filter((story) => !story.hidden && story.section !== "hidden");
  const paperTemplate = Object.hasOwn(PAPER_TEMPLATES, state.issue.layoutTemplate) ? state.issue.layoutTemplate : null;
  const templatePlans = useMemo(() => new Map(
    templateStoryPlans(state.issue, state.settings.editorLayout).map((plan) => [plan.slotId, plan]),
  ), [state.issue, state.settings.editorLayout]);
  const frames = state.issue.stories.map((story) => story.frame);
  const creation = useRef({ frames, onCreate });
  creation.current = { frames, onCreate };
  function point(event) {
    const rectangle = boundary.current.getBoundingClientRect();
    return {
      x: CONTENT.x + (event.clientX - rectangle.left) / scale / PX_PER_MM,
      y: CONTENT.y + (event.clientY - rectangle.top) / scale / PX_PER_MM,
    };
  }
  const create = useCallback((frame) => {
    if (!frame) {
      setNotice("There is not enough vacant space for a block here.");
      return null;
    }
    setNotice("");
    const slot = creation.current.onCreate(frame);
    creation.current.frames = [...creation.current.frames, frame];
    if (slot) requestAnimationFrame(() => {
      const block = boundary.current?.querySelector(`[data-story-id="${CSS.escape(storyKey(slot))}"]`);
      block?.scrollIntoView({ block: "nearest", inline: "nearest" });
      block?.querySelector("textarea")?.focus({ preventScroll: true });
    });
    return frame;
  }, []);
  const newSlot = useCallback(() => create(randomEmptyFrame(creation.current.frames)), [create]);
  // The parent toolbar can keep this callback in a ref and invoke it without
  // duplicating vacancy allocation or placing another button over the paper.
  useEffect(() => {
    onNewSlotReady?.(newSlot);
    return () => onNewSlotReady?.(null);
  }, [onNewSlotReady, newSlot]);
  function clickStart(event) {
    if (suppressPointer() || event.button !== 0 || event.target.closest(".story-rnd, [data-story-id]")) return;
    const at = point(event);
    pointerStart.current = { ...at, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    boundary.current.setPointerCapture(event.pointerId);
  }
  function clickEnd(event) {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || start.pointerId !== event.pointerId || suppressPointer()) return;
    if (Math.hypot(start.clientX - event.clientX, start.clientY - event.clientY) <= 8) {
      create(emptyFrame(creation.current.frames, { x: start.x, y: start.y }));
    }
  }

  return (
    <section className="canvas-column" aria-label="Newspaper" onKeyDownCapture={onKeyDown}>
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className="canvas-viewport" ref={viewport} tabIndex={0}
        aria-label="Newspaper preview. Pinch or Control-scroll to zoom."
        aria-keyshortcuts="Control+= Control+- Control+0 Meta+= Meta+- Meta+0">
        <div className="page-scaled" ref={paper} style={{ width: PAGE.width * PX_PER_MM * scale, height: PAGE.height * PX_PER_MM * scale }}>
          <div className="newspaper-page" data-template={paperTemplate || undefined} style={{ transform: `scale(${scale})` }}>
            <header className="newspaper-masthead">
              <button type="button" className="masthead-title" title="Edit newspaper title" onClick={onTitle}
                style={{ fontSize: `${Math.max(16, Math.min(30, 1400 / Math.max(1, String(state.issue.title || "").length)))}pt` }}>
                {state.issue.title || "The Agentic Times"}
              </button>
              <div className="edition-meta"><time dateTime={state.issue.date}>{editionDate(state.issue.date)}</time><span>{state.issue.audience || "For curious builders"}</span></div>
            </header>
            <div ref={boundary} className="page-content-boundary"
              tabIndex={0} role="group" aria-label="Newspaper story area. Click empty space or use Add story in the toolbar."
              onPointerDown={clickStart} onPointerUp={clickEnd}
              onPointerCancel={() => { pointerStart.current = null; }}
              style={{ left: `${CONTENT.x}mm`, top: `${CONTENT.y}mm`, width: `${CONTENT.width}mm`, height: `${CONTENT.height}mm` }}>
              {!stories.length && (
                <p className="blank-page-hint">Click empty space to add a story.</p>
              )}
              {stories.map((story) => (
                <StoryCard key={storyKey(story)} story={story} controller={controller}
                  job={[...state.jobs].reverse().find((job) => job.type !== "auto_research" &&
                    job.slotId === story.slotId && (!story.requestId || job.id === story.requestId))}
                  selected={storyKey(story) === selected} scale={scale} stage={state.settings.stage}
                  demoMode={state.settings.demoMode === true}
                  editorial={state.editorial}
                  leadSuggested={storyKey(story) === suggestedLeadId}
                  paperTemplate={paperTemplate} templatePlan={templatePlans.get(storyKey(story))}
                  pairs={pairs.filter((pair) => pair.stories.some((item) => item.id === story.id))}
                  selectedPair={selectedPair} onPair={onPair}
                  onSelect={onSelect} onEvidence={onEvidence} onFit={onFit} onMeasure={onMeasure} onInspect={onInspect} />
              ))}
            </div>
            <footer className="newspaper-footer"><span aria-label="Page 1">1</span></footer>
          </div>
        </div>
      </div>
      <footer className="canvas-footer">
        <span className="paper-geometry">297 × 420 mm</span>
        <div className="zoom-controls" role="group" aria-label="Newspaper zoom"
          title="Pinch or Ctrl-scroll to zoom. Ctrl/⌘ +, − and 0 also work.">
          <button type="button" className="zoom-step" aria-label="Zoom out" title="Zoom out"
            disabled={scale <= MIN_ZOOM} onClick={() => zoomBy(-1)}>−</button>
          <Popover label="Zoom level" className="zoom-popover"
            trigger={<button type="button" className="zoom-level" aria-label={`Zoom level: ${Math.round(scale * 100)}%`}
              title="Choose zoom level">{Math.round(scale * 100)}% <span aria-hidden="true">⌄</span></button>}>
            {[["fit", "Fit page"], ["width", "Fit width"], [0.5, "50%"], [0.75, "75%"],
              [1, "100%"], [1.5, "150%"], [2, "200%"], [3, "300%"]].map(([value, label]) =>
              <PopoverClose asChild key={value}>
                <button type="button" aria-pressed={zoom === value} onClick={() => zoomTo(value)}>{label}</button>
              </PopoverClose>,
            )}
          </Popover>
          <button type="button" className="zoom-step" aria-label="Zoom in" title="Zoom in"
            disabled={scale >= MAX_ZOOM} onClick={() => zoomBy(1)}>+</button>
          <button type="button" className="zoom-fit" title="Fit page (Ctrl/⌘ 0)"
            aria-pressed={zoom === "fit"} onClick={() => zoomTo("fit")}>Fit page</button>
        </div>
      </footer>
    </section>
  );
}
