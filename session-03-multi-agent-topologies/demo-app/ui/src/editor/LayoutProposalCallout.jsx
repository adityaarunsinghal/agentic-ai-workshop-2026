import React, { useEffect, useId, useRef, useState } from "react";
import { PAPER_TEMPLATES } from "../../../src/layout-templates.mjs";

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const center = (rect) => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 });
function edgeToward(rect, point) {
  const middle = center(rect), dx = point.x - middle.x, dy = point.y - middle.y;
  const scale = Math.min((rect.right - rect.left) / 2 / (Math.abs(dx) || 1),
    (rect.bottom - rect.top) / 2 / (Math.abs(dy) || 1));
  return { x: middle.x + dx * scale, y: middle.y + dy * scale };
}

export function LayoutProposalCallout({ proposal, applying, onApprove, onDecline }) {
  const callout = useRef(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [paths, setPaths] = useState([]);
  const changes = proposal.changes ?? [];
  const count = changes.length;
  const resized = changes.filter((change) => change.resized).length;
  const title = proposal.kind === "template"
    ? `Approve ${PAPER_TEMPLATES[proposal.template].label} layout?`
    : "Approve layout cleanup?";

  useEffect(() => {
    const panel = callout.current;
    if (!panel || !proposal.ok) return;
    const view = panel.ownerDocument.defaultView;
    const cards = new Map([...panel.ownerDocument.querySelectorAll(".newspaper-story[data-story-id]")]
      .map((element) => [element.dataset.storyId, element]));
    const targets = changes.map((change) => cards.get(change.slotId)).filter(Boolean);
    let frame = null;
    function measure() {
      frame = null;
      const box = panel.getBoundingClientRect();
      const routes = [];
      for (const target of targets) {
        const rect = target.getBoundingClientRect();
        const viewport = target.closest(".canvas-viewport")?.getBoundingClientRect();
        let visible = {
          left: Math.max(4, rect.left, viewport?.left ?? 0),
          top: Math.max(4, rect.top, viewport?.top ?? 0),
          right: Math.min(view.innerWidth - 4, rect.right, viewport?.right ?? view.innerWidth),
          bottom: Math.min(view.innerHeight - 4, rect.bottom, viewport?.bottom ?? view.innerHeight),
        };
        if (visible.right <= visible.left || visible.bottom <= visible.top) continue;
        if (overlaps(visible, box)) {
          // A large block can extend behind the notification. Point to its
          // visible portion instead of hiding the arrow for the whole block.
          visible = [
            { ...visible, right: Math.min(visible.right, box.left - 8) },
            { ...visible, left: Math.max(visible.left, box.right + 8) },
            { ...visible, bottom: Math.min(visible.bottom, box.top - 8) },
            { ...visible, top: Math.max(visible.top, box.bottom + 8) },
          ].filter((part) => part.right > part.left && part.bottom > part.top)
            .sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top))[0];
          if (!visible) continue;
        }
        const start = edgeToward(box, center(visible));
        const end = edgeToward(visible, start);
        const x = (start.x + end.x) / 2;
        routes.push(`M ${start.x} ${start.y} C ${x} ${start.y}, ${x} ${end.y}, ${end.x} ${end.y}`);
        if (routes.length === 3) break;
      }
      setPaths((previous) => previous.join("|") === routes.join("|") ? previous : routes);
    }
    const schedule = () => { if (frame === null) frame = view.requestAnimationFrame(measure); };
    const sizeObserver = new ResizeObserver(schedule);
    sizeObserver.observe(panel);
    const positionObserver = new MutationObserver(schedule);
    const paper = panel.ownerDocument.querySelector(".canvas-viewport .newspaper-page");
    if (paper) positionObserver.observe(paper, { attributes: true, attributeFilter: ["style"] });
    for (const target of targets) {
      sizeObserver.observe(target);
      if (target.parentElement) positionObserver.observe(target.parentElement, { attributes: true, attributeFilter: ["style"] });
    }
    panel.ownerDocument.addEventListener("scroll", schedule, true);
    view.addEventListener("resize", schedule);
    view.visualViewport?.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame !== null) view.cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      positionObserver.disconnect();
      panel.ownerDocument.removeEventListener("scroll", schedule, true);
      view.removeEventListener("resize", schedule);
      view.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [proposal]);

  return <>
    {paths.length > 0 && <svg className="layout-proposal-arrows" aria-hidden="true" focusable="false">
      <defs><marker id={`proposal-arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" />
      </marker></defs>
      {paths.map((path, index) => <path className="proposal-arrow" key={index} d={path}
        markerEnd={`url(#proposal-arrow-${id})`} />)}
    </svg>}
    <aside ref={callout} id="layout-approval" tabIndex={-1} className="layout-suggestion" role="dialog" aria-modal="false" aria-labelledby={`proposal-title-${id}`}>
      <p id={`proposal-title-${id}`}>{title}</p>
      {!proposal.ok ? <p className="hint">{proposal.reason}</p> : <>
        <p>{count ? `${count} ${count === 1 ? "block" : "blocks"} will ${resized ? "move or resize" : "move"}.`
          : "Placements match. Approval applies the style."}
          {proposal.kind === "template" && resized ? " Copy fitting and one final review follow approval."
            : proposal.kind === "tidy" ? " Your copy and typography stay as they are." : ""}</p>
        {count > 0 && paths.length < count && <p className="hint proposal-arrow-count">
          {paths.length ? `Arrows point to ${paths.length} of ${count} affected ${count === 1 ? "block" : "blocks"}.`
            : "Scroll the paper to see the affected blocks."}
        </p>}
      </>}
      <div className="button-row">
        <button type="button" disabled={applying || !proposal.ok} onClick={onApprove}>{applying ? "Applying…" : "Approve"}</button>
        <button type="button" className="quiet" disabled={applying} onClick={onDecline}>Decline</button>
      </div>
    </aside>
  </>;
}
