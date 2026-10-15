import { CONTENT, MIN_FRAME, boundFrame, intersects, layoutMeasurementKey } from "../ui/src/shared/geometry.mjs";

export const PAPER_TEMPLATES = Object.freeze({
  newspaper: Object.freeze({ label: "Front Page", description: "A wide lead with supporting stories in newspaper columns." }),
  breaking_news: Object.freeze({ label: "Breaking News", description: "A dominant full-width lead above compact supporting columns." }),
  side_by_side: Object.freeze({ label: "Side by Side", description: "Paired stories in equal columns and aligned rows." }),
});

export const EDITORIAL_BASES = Object.freeze({
  timely_development: Object.freeze({ label: "Timely development", description: "Verified recent developments and their consequences are the strongest editorial consideration." }),
  dominant_story: Object.freeze({ label: "Dominant story", description: "One story is substantially more important to this audience than the supporting coverage." }),
  useful_comparison: Object.freeze({ label: "Useful comparison", description: "Putting the stories together helps readers compare or contrast meaningful perspectives." }),
  balanced_coverage: Object.freeze({ label: "Balanced coverage", description: "Several stories deserve comparable prominence within a varied edition." }),
  insufficient_urgency: Object.freeze({ label: "Urgency not established", description: "The supplied evidence does not establish a sufficiently timely or consequential development to dominate the edition." }),
});

const slotOf = (story) => story.slotId ?? story.id;
const round = (number) => Math.round(number * 100) / 100;
const sameFrame = (a, b) => ["x", "y", "width", "height"].every((key) => a[key] === b[key]);
const bounded = (frame) => ["x", "y", "width", "height"].every((key) => Number.isFinite(frame?.[key])) &&
  sameFrame(frame, boundFrame(frame));
const pinned = (story) => story.locked || story.pinned;
const visible = (story) => !story.hidden && story.section !== "hidden";
const order = (a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x || String(slotOf(a)).localeCompare(String(slotOf(b)));
const specs = {
  newspaper: { gap: 6, column: 87, lead: 180, leadHeight: 54 },
  breaking_news: { gap: 4, column: round((CONTENT.width - 8) / 3), lead: CONTENT.width, leadHeight: 64 },
  side_by_side: { gap: 6, column: (CONTENT.width - 6) / 2 },
};

// Shared with the DOM measurement pass: each requested width is measured under
// the candidate template's actual paper CSS before a plan can be offered.
export function templateStoryPlans(issue, template) {
  if (!Object.hasOwn(PAPER_TEMPLATES, template)) return [];
  const stories = issue.stories.filter(visible).sort(order);
  const spec = specs[template];
  if (template !== "side_by_side") {
    const lead = stories.find((story) => slotOf(story) === issue.leadSuggestion) ?? stories[0];
    return stories.map((story) => ({
      slotId: slotOf(story), template, role: story === lead ? "lead" : "support",
      width: story === lead ? spec.lead : spec.column,
    }));
  }
  const byId = new Map(stories.map((story) => [slotOf(story), story]));
  const used = new Set(), rows = [];
  for (const relationship of issue.relationships ?? []) {
    const pair = [...new Set(relationship.storyIds ?? [])].filter((id) => byId.has(id) && !used.has(id));
    if (pair.length < 2) continue;
    rows.push(pair.slice(0, 2));
    pair.slice(0, 2).forEach((id) => used.add(id));
  }
  const rest = stories.filter((story) => !used.has(slotOf(story))).map(slotOf);
  for (let index = 0; index < rest.length; index += 2) rows.push(rest.slice(index, index + 2));
  return rows.flatMap((row, index) => row.map((slotId, column) => ({
    slotId, template, role: "pair", row: index, column, width: spec.column,
  })));
}

export function planPaperTemplate(issue, template, measurements) {
  const failure = (reason, pending = false) => ({ ok: false, template, reason, pending });
  if (!Object.hasOwn(PAPER_TEMPLATES, template)) return failure("No newspaper template was selected.");
  if (issue.layoutTemplate === template) return { ok: false, template, alreadyApplied: true };
  const assignments = templateStoryPlans(issue, template);
  if (!assignments.length) return failure("Add a story before applying a newspaper template.", true);
  const spec = specs[template], entries = new Map(), occupied = [], proposed = new Map();
  const ids = new Set();
  for (const story of issue.stories) {
    const id = slotOf(story);
    if (!id || ids.has(id) || !bounded(story.frame)) return failure("Some block geometry is unavailable. Keep the current layout.");
    ids.add(id);
    if (!visible(story) || pinned(story)) occupied.push({ slotId: id, frame: story.frame });
  }
  if (occupied.some((entry, index) => occupied.slice(index + 1).some((other) => intersects(entry.frame, other.frame))))
    return failure("Fixed blocks overlap. Separate or unlock them before applying this template.");
  const rows = template === "side_by_side" ? Math.ceil(assignments.length / 2)
    : template === "breaking_news" ? 1 + Math.ceil((assignments.length - 1) / 3)
      : Math.ceil((assignments.length + 1) / 3);
  const rowBudget = Math.floor((CONTENT.height - spec.gap * (rows - 1)) / rows * 2) / 2;
  if (rowBudget < MIN_FRAME.height || (template !== "side_by_side" && rowBudget < spec.leadHeight))
    return failure("There are too many blocks for legal rows in this template.");
  for (const assignment of assignments) {
    const story = issue.stories.find((item) => slotOf(item) === assignment.slotId);
    const measured = measurements[assignment.slotId];
    const candidate = measured?.template;
    if (!measured?.ready || measured.key !== layoutMeasurementKey(story) ||
      candidate?.template !== template || candidate.role !== assignment.role || candidate.width !== assignment.width ||
      !Number.isFinite(candidate.requiredHeight) || candidate.requiredHeight <= 0)
      return failure("Waiting for the current copy to be measured at this template's column widths.", true);
    // Use measured content where it fits. Taller copy gets a bounded template
    // row; the server adapts copy only after the visitor accepts a size change.
    const height = Math.max(MIN_FRAME.height, assignment.role === "lead" ? spec.leadHeight : 0,
      Math.min(350, rowBudget, Math.ceil(candidate.requiredHeight * 2) / 2));
    if (pinned(story) && (Math.abs(story.frame.width - assignment.width) > 0.01 || story.frame.height < candidate.requiredHeight))
      return failure("A locked block needs a different size for this template. Unlock it or keep your layout.");
    entries.set(assignment.slotId, { ...assignment, story, height });
  }
  const free = (frame) => bounded(frame) && !occupied.some((other) => intersects(frame, other.frame, spec.gap));
  const place = (entry, frame) => {
    occupied.push({ slotId: entry.slotId, frame });
    proposed.set(entry.slotId, frame);
  };
  const atColumns = (entry, columns, minimumY) => {
    const ys = [...new Set([minimumY, ...occupied.map(({ frame }) => round(frame.y + frame.height + spec.gap))])]
      .filter((y) => y >= minimumY).sort((a, b) => a - b);
    for (const y of ys) for (const x of columns) {
      const frame = { x: round(x), y: round(y), width: entry.width, height: entry.height };
      if (free(frame)) return frame;
    }
    return null;
  };

  if (template === "side_by_side") {
    const columns = [CONTENT.x, CONTENT.x + spec.column + spec.gap];
    const rows = [...new Set(assignments.map((entry) => entry.row))];
    for (const row of rows) {
      const pair = assignments.filter((entry) => entry.row === row).map((entry) => entries.get(entry.slotId));
      const locked = pair.filter((entry) => pinned(entry.story));
      if (locked.length) {
        const anchor = locked[0].story.frame;
        if (!columns.includes(anchor.x) || locked.some((entry) =>
          entry.story.frame.y !== anchor.y || entry.story.frame.height !== anchor.height || !columns.includes(entry.story.frame.x)))
          return failure("Locked stories cannot form equal rows in their current positions. Unlock them or keep your layout.");
        const usedColumns = new Set(locked.map((entry) => entry.story.frame.x));
        for (const entry of pair.filter((item) => !pinned(item.story))) {
          const x = columns.find((column) => !usedColumns.has(column));
          const frame = { x, y: anchor.y, width: entry.width, height: anchor.height };
          if (entry.height > anchor.height || !free(frame)) return failure("The paired row cannot fit beside its locked story. Unlock it or keep this layout.");
          place(entry, frame); usedColumns.add(x);
        }
        continue;
      }
      const height = Math.max(...pair.map((entry) => entry.height));
      const ys = [...new Set([CONTENT.y, ...occupied.map(({ frame }) => round(frame.y + frame.height + spec.gap))])].sort((a, b) => a - b);
      let rowFrames = null;
      for (const y of ys) {
        const frames = pair.map((entry, index) => ({ x: columns[index], y, width: entry.width, height }));
        if (frames.every(free)) { rowFrames = frames; break; }
      }
      if (!rowFrames) return failure("There is not enough room for equal rows while keeping locked blocks fixed.");
      pair.forEach((entry, index) => place(entry, rowFrames[index]));
    }
  } else {
    const lead = [...entries.values()].find((entry) => entry.role === "lead");
    const leadFrame = pinned(lead.story) ? lead.story.frame : {
      x: CONTENT.x, y: CONTENT.y, width: lead.width, height: lead.height,
    };
    if (leadFrame.x !== CONTENT.x || leadFrame.y !== CONTENT.y || (!pinned(lead.story) && !free(leadFrame)))
      return failure("Locked blocks prevent the wide lead at the top of this template. Unlock them or keep your layout.");
    if (!pinned(lead.story)) place(lead, leadFrame);
    const columns = [0, 1, 2].map((index) => round(CONTENT.x + index * (spec.column + spec.gap)));
    const minimumY = template === "breaking_news" ? round(leadFrame.y + leadFrame.height + spec.gap) : CONTENT.y;
    for (const entry of [...entries.values()].filter((item) => item.role !== "lead")) {
      if (pinned(entry.story)) {
        if (!columns.includes(entry.story.frame.x) || entry.story.frame.y < minimumY)
          return failure("A locked supporting story is outside this template's columns. Unlock it or keep the current layout.");
        continue;
      }
      const frame = atColumns(entry, columns, minimumY);
      if (!frame) return failure("There is not enough room for this template while keeping locked blocks fixed.");
      place(entry, frame);
    }
  }
  const changes = [...proposed].flatMap(([slotId, frame]) => {
    const original = entries.get(slotId).story.frame;
    return sameFrame(original, frame) ? [] : [{ slotId, frame, original,
      resized: original.width !== frame.width || original.height !== frame.height }];
  });
  // Applying a different paper treatment can be meaningful even if manually
  // placed boxes already match it. One unchanged frame allows the atomic stamp.
  const frames = changes.length ? changes.map(({ slotId, frame }) => ({ slotId, frame }))
    : [{ slotId: assignments[0].slotId, frame: entries.get(assignments[0].slotId).story.frame }];
  return { ok: true, template, frames, changes };
}
