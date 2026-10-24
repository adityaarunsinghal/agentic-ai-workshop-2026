import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PAGE, PX_PER_MM } from "../shared/geometry.mjs";

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 3;
const width = PAGE.width * PX_PER_MM;
const height = PAGE.height * PX_PER_MM;
const stops = [MIN_ZOOM, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, MAX_ZOOM];
const clamp = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
const editable = (target) => target.closest("input, textarea, select, [contenteditable=true]");
const touchPoint = (touches) => ({
  clientX: (touches[0].clientX + touches[1].clientX) / 2,
  clientY: (touches[0].clientY + touches[1].clientY) / 2,
});
const touchDistance = (touches) => Math.hypot(
  touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY,
);

export function useCanvasZoom({ viewport, paper, cancelSelection }) {
  const [available, setAvailable] = useState({ width: 680, height: 740 });
  const [mode, setMode] = useState("fit");
  const fitWidth = clamp(available.width / width);
  const fitPage = Math.min(fitWidth, clamp(available.height / height));
  const scale = mode === "fit" ? fitPage : mode === "width" ? fitWidth : mode;
  const currentScale = useRef(scale);
  const pendingAnchor = useRef(null);
  const pinch = useRef(null);
  const suppressUntil = useRef(0);
  const cancel = useRef(cancelSelection);
  cancel.current = cancelSelection;

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [viewport]);

  const zoomTo = useCallback((value, anchor, paperPoint) => {
    const node = viewport.current;
    const sheet = paper.current;
    if (!node || !sheet) return;
    if (value === "fit" || value === "width") {
      pendingAnchor.current = null;
      currentScale.current = value === "fit" ? fitPage : fitWidth;
      node.scrollTo({ top: 0, left: 0 });
      setMode(value);
      return;
    }
    const next = clamp(Number(value));
    if (!Number.isFinite(next)) return;
    const bounds = node.getBoundingClientRect();
    const point = anchor ?? {
      clientX: bounds.left + node.clientWidth / 2,
      clientY: bounds.top + node.clientHeight / 2,
    };
    const rectangle = sheet.getBoundingClientRect();
    const renderedScale = rectangle.width / width;
    pendingAnchor.current = {
      clientX: point.clientX, clientY: point.clientY,
      x: paperPoint?.x ?? (point.clientX - rectangle.left) / renderedScale,
      y: paperPoint?.y ?? (point.clientY - rectangle.top) / renderedScale,
    };
    currentScale.current = next;
    setMode(next);
  }, [fitPage, fitWidth, paper, viewport]);

  // Scroll the newly sized paper back under the same pointer or reading point.
  useLayoutEffect(() => {
    const node = viewport.current;
    const anchor = pendingAnchor.current;
    if (node && paper.current && anchor) {
      const rectangle = paper.current.getBoundingClientRect();
      node.scrollLeft += rectangle.left + anchor.x * scale - anchor.clientX;
      node.scrollTop += rectangle.top + anchor.y * scale - anchor.clientY;
    } else if (node && mode === "fit") {
      node.scrollTo({ top: 0, left: 0 });
    }
    pendingAnchor.current = null;
    currentScale.current = scale;
  }, [scale, mode, available, paper, viewport]);

  const zoomBy = useCallback((direction) => {
    const current = currentScale.current;
    const next = direction > 0
      ? stops.find((value) => value > current + 0.005) ?? MAX_ZOOM
      : [...stops].reverse().find((value) => value < current - 0.005) ?? MIN_ZOOM;
    zoomTo(next);
  }, [zoomTo]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    function wheel(event) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      zoomTo(currentScale.current * Math.exp(-event.deltaY * unit * 0.003), event);
    }
    function touchStart(event) {
      if (event.touches.length !== 2 || !paper.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel.current();
      const point = touchPoint(event.touches);
      const rectangle = paper.current.getBoundingClientRect();
      const renderedScale = rectangle.width / width;
      pinch.current = {
        distance: Math.max(1, touchDistance(event.touches)), scale: currentScale.current,
        x: (point.clientX - rectangle.left) / renderedScale,
        y: (point.clientY - rectangle.top) / renderedScale,
      };
      suppressUntil.current = Infinity;
    }
    function touchMove(event) {
      if (!pinch.current || event.touches.length !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      zoomTo(pinch.current.scale * touchDistance(event.touches) / pinch.current.distance,
        touchPoint(event.touches), pinch.current);
    }
    function touchEnd(event) {
      if (!pinch.current || event.touches.length >= 2) return;
      if (event.cancelable) event.preventDefault();
      pinch.current = null;
      suppressUntil.current = performance.now() + 350;
    }
    function click(event) {
      if (performance.now() >= suppressUntil.current) return;
      event.preventDefault();
      event.stopPropagation();
    }
    const options = { passive: false, capture: true };
    node.addEventListener("wheel", wheel, options);
    node.addEventListener("touchstart", touchStart, options);
    node.addEventListener("touchmove", touchMove, options);
    node.addEventListener("touchend", touchEnd, options);
    node.addEventListener("touchcancel", touchEnd, options);
    node.addEventListener("click", click, true);
    return () => {
      node.removeEventListener("wheel", wheel, true);
      node.removeEventListener("touchstart", touchStart, true);
      node.removeEventListener("touchmove", touchMove, true);
      node.removeEventListener("touchend", touchEnd, true);
      node.removeEventListener("touchcancel", touchEnd, true);
      node.removeEventListener("click", click, true);
    };
  }, [paper, viewport, zoomTo]);

  function onKeyDown(event) {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || editable(event.target)) return;
    if (!["+", "=", "-", "0"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "0") zoomTo("fit");
    else zoomBy(event.key === "-" ? -1 : 1);
  }

  return {
    scale, mode, zoomTo, zoomBy, onKeyDown,
    suppressPointer: () => performance.now() < suppressUntil.current,
  };
}
