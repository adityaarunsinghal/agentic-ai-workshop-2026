// Millimeters from the page's top left; react-rnd owns dragging and resizing.
export const PAGE = Object.freeze({
  width: 297, height: 420, margin: 12, contentTop: 44, contentBottom: 404,
  headlinePt: 14, bodyPt: 10,
});
export const PX_PER_MM = 96 / 25.4;
export const MIN_FRAME = Object.freeze({ width: 45, height: 36 });
export const CONTENT = Object.freeze({
  x: PAGE.margin, y: PAGE.contentTop,
  width: PAGE.width - PAGE.margin * 2,
  height: PAGE.contentBottom - PAGE.contentTop,
});
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value) => Math.round(value * 100) / 100;
const frameKeys = ["x", "y", "width", "height"];
// Under one tenth of a CSS pixel at 96dpi. Compare against the retained frame,
// so repeated DOM round trips cannot accumulate drift or resize writer work.
export const FRAME_EPSILON_MM = 0.025;
const sameCoordinate = (a, b) => Number.isFinite(a) && Number.isFinite(b) &&
  Math.abs(a - b) <= FRAME_EPSILON_MM + 1e-9;
export const sameFrameSize = (a, b) =>
  ["width", "height"].every((key) => sameCoordinate(a?.[key], b?.[key]));
export const sameFrame = (a, b) =>
  frameKeys.every((key) => sameCoordinate(a?.[key], b?.[key]));

export function retainFramePrecision(previous, next) {
  const frame = Object.fromEntries(frameKeys.map((key) => [
    key, sameCoordinate(previous?.[key], next?.[key]) ? previous[key] : next?.[key],
  ]));
  // Retaining the original width/height must not push a real move past an edge.
  frame.x = Math.min(CONTENT.x + CONTENT.width - frame.width, Math.max(CONTENT.x, frame.x));
  frame.y = Math.min(CONTENT.y + CONTENT.height - frame.height, Math.max(CONTENT.y, frame.y));
  return frame;
}

export function boundFrame(frame = {}) {
  const width = Math.min(CONTENT.width, Math.max(MIN_FRAME.width, finite(frame.width, 86)));
  const height = Math.min(350, Math.max(MIN_FRAME.height, finite(frame.height, 104)));
  return {
    x: round(Math.min(CONTENT.x + CONTENT.width - width, Math.max(CONTENT.x, finite(frame.x, CONTENT.x)))),
    y: round(Math.min(CONTENT.y + CONTENT.height - height, Math.max(CONTENT.y, finite(frame.y, CONTENT.y)))),
    width: round(width), height: round(height),
  };
}

export function intersects(a, b, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

const blockSizes = [{ width: 86, height: 104 }, { width: 64, height: 78 }, MIN_FRAME];
const vacant = (frames, candidate) => !frames.some((frame) => intersects(candidate, frame, 2));

// A canvas click stays at the chosen position, using a smaller block when needed.
export function emptyFrame(frames, point = CONTENT) {
  for (const size of blockSizes) {
    const candidate = boundFrame({ ...point, ...size });
    if (vacant(frames, candidate)) return candidate;
  }
  return null;
}

// Add story chooses among vacant bounded positions, without touching old blocks.
export function randomEmptyFrame(frames, random = Math.random) {
  for (const size of blockSizes) {
    const candidates = [];
    const xs = new Set([CONTENT.x, CONTENT.x + CONTENT.width - size.width]);
    const ys = new Set([CONTENT.y, CONTENT.y + CONTENT.height - size.height]);
    for (let x = CONTENT.x; x + size.width <= CONTENT.x + CONTENT.width; x += 6) xs.add(x);
    for (let y = CONTENT.y; y + size.height <= CONTENT.y + CONTENT.height; y += 6) ys.add(y);
    for (const frame of frames) {
      xs.add(frame.x + frame.width + 2); xs.add(frame.x - size.width - 2);
      ys.add(frame.y + frame.height + 2); ys.add(frame.y - size.height - 2);
    }
    for (const y of ys) {
      for (const x of xs) {
        const frame = boundFrame({ x, y, ...size });
        if (frame.x === round(x) && frame.y === round(y) && vacant(frames, frame)) candidates.push(frame);
      }
    }
    if (candidates.length) {
      const sample = Math.min(1 - Number.EPSILON, Math.max(0, Number(random()) || 0));
      return candidates[Math.floor(sample * candidates.length)];
    }
  }
  return null;
}

export function layoutMeasurementKey(story) {
  const typography = story.typography?.contentVersion === story.contentVersion
    ? { styles: story.typography.styles, sentences: story.typography.sentences } : null;
  return JSON.stringify([
    story.slotId ?? story.id, story.frame, story.contentVersion,
    story.headline ?? "", story.body ?? "", typography,
  ]);
}

// StoryCard reserves the same warning row whether its text is visible or not.
// Both overflow and the proposed height therefore use identical, stable chrome.
// The inner copy has natural height; the outer scroller fills allocated space.
export function measureStoryLayout(article) {
  const node = article.querySelector(".story-copy-scroll");
  const content = node?.firstElementChild;
  if (!node || !content) return null;
  const view = article.ownerDocument.defaultView;
  const edges = (element, names) => {
    const css = view.getComputedStyle(element);
    return names.reduce((sum, name) => sum + (Number.parseFloat(css[name]) || 0), 0);
  };
  const box = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"];
  const margins = ["marginTop", "marginBottom"];
  const chrome = [...article.children].filter((element) => element !== node)
    .reduce((sum, element) => sum + element.offsetHeight + edges(element, margins), 0);
  const requiredPixels = Math.max(content.scrollHeight, content.offsetHeight) +
    chrome + edges(article, box) + edges(node, [...box, ...margins]);
  const body = content.querySelector(".story-body");
  const copyHeight = Math.max(content.scrollHeight, content.offsetHeight);
  const bodyHeight = body ? Math.max(body.scrollHeight, body.offsetHeight) : 0;
  const availableCopyHeight = Math.max(0, node.clientHeight - edges(node, ["paddingTop", "paddingBottom"]));
  const lineHeights = body ? [...body.querySelectorAll("[data-sentence-id]")].map((element) => {
    const css = view.getComputedStyle(element);
    return Number.parseFloat(css.lineHeight) || Number.parseFloat(css.fontSize) * 1.2;
  }).filter(Number.isFinite) : [];
  return {
    overflow: node.scrollHeight > node.clientHeight + 2,
    requiredHeight: Math.max(MIN_FRAME.height, Math.ceil(requiredPixels) / PX_PER_MM + 1),
    copyHeight, bodyHeight, availableCopyHeight,
    availableBodyHeight: Math.max(0, availableCopyHeight - (copyHeight - bodyHeight)),
    minimumLineHeight: lineHeights.length ? Math.min(...lineHeights) : 0,
  };
}

const withinPage = (frame) => ["x", "y", "width", "height"].every((key) => Number.isFinite(frame?.[key])) &&
  frameKeys.every((key) => frame[key] === boundFrame(frame)[key]);

// Heights come from current DOM measurements. Widths never change in this
// plan, so its copy cannot reflow into a different, unmeasured column width.
export function tidyLayoutPlan(stories, measurements, { leadSlotId } = {}) {
  const fixed = [], movable = [];
  const ids = new Set();
  for (const story of stories) {
    const slotId = story.slotId ?? story.id;
    if (!slotId || ids.has(slotId) || !withinPage(story.frame)) return null;
    ids.add(slotId);
    const hidden = story.hidden || story.section === "hidden";
    const measurement = measurements[slotId];
    if (!hidden && measurement?.key !== layoutMeasurementKey(story)) return null;
    const keepEditorFixed = !measurement?.ready && ["editing", "prompt", "empty"].includes(measurement?.reason);
    if (!hidden && !keepEditorFixed && (!measurement?.ready ||
      !Number.isFinite(measurement.requiredHeight) || measurement.requiredHeight <= 0)) return null;
    if (hidden || story.locked || story.pinned || keepEditorFixed) {
      if (!hidden && measurement.ready && measurement.requiredHeight > story.frame.height) return null;
      fixed.push({ slotId, frame: story.frame });
    } else {
      const requested = Math.max(MIN_FRAME.height, Math.ceil(measurement.requiredHeight * 2) / 2);
      // A fractional safety cushion alone does not justify enlarging fitted copy.
      const height = requested > story.frame.height && measurement.overflow === false
        ? story.frame.height : requested;
      if (height > 350) return null;
      movable.push({ slotId, original: story.frame, frame: { ...story.frame, height } });
    }
  }
  if (!movable.length || fixed.some((item, index) => fixed.slice(index + 1).some((other) => intersects(item.frame, other.frame)))) return null;
  const readingOrder = (a, b) => a.original.y - b.original.y || a.original.x - b.original.x;
  const leadFirst = (compare) => (a, b) => Number(b.slotId === leadSlotId) - Number(a.slotId === leadSlotId) || compare(a, b);
  const orders = [
    leadFirst(readingOrder),
    leadFirst((a, b) => b.frame.height - a.frame.height || b.frame.width - a.frame.width || readingOrder(a, b)),
    leadFirst((a, b) => b.frame.width - a.frame.width || b.frame.height - a.frame.height || readingOrder(a, b)),
  ];
  const usefulSizing = movable.some((item) => item.frame.height > item.original.height ||
    item.original.height - item.frame.height >= 6);
  let best = null;
  for (const order of orders) {
    const placed = [...fixed];
    let fits = true;
    for (const item of [...movable].sort(order)) {
      const xs = [...new Set([CONTENT.x, item.original.x, ...placed.map(({ frame }) => frame.x + frame.width + 2)])].sort((a, b) => a - b);
      const ys = [...new Set([CONTENT.y, item.original.y, ...placed.map(({ frame }) => frame.y + frame.height + 2)])].sort((a, b) => a - b);
      let position = null;
      for (const y of ys) {
        for (const x of xs) {
          const candidate = { ...item.frame, x: round(x), y: round(y) };
          if (withinPage(candidate) && vacant(placed.map((entry) => entry.frame), candidate)) {
            position = candidate; break;
          }
        }
        if (position) break;
      }
      if (!position) { fits = false; break; }
      placed.push({ slotId: item.slotId, frame: position });
    }
    if (!fits) continue;
    const bottom = Math.max(...placed.map(({ frame }) => frame.y + frame.height));
    const oldBottom = Math.max(...stories.map(({ frame }) => frame.y + frame.height));
    const frames = placed.filter((item) => {
      const old = movable.find((entry) => entry.slotId === item.slotId);
      return old && !sameFrame(old.original, item.frame);
    });
    if (!frames.length || (!usefulSizing && oldBottom - bottom < 6)) continue;
    if (!best || bottom < best.bottom) best = { frames, bottom };
  }
  return best ? { frames: best.frames } : null;
}
