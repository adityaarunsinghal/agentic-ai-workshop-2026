import { createHash } from "node:crypto";
import { layoutMeasurementKey, sameFrame, sameFrameSize } from "../../ui/src/shared/geometry.mjs";

export const MAX_RENDERED_FIT_PASSES = 2;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function matchesRenderedCopy(story, report) {
  return story?.contentVersion === report.contentVersion &&
    sameFrame(story.frame, report.frame) && layoutMeasurementKey(story) === report.key;
}

export function currentRenderedEpisode(story) {
  const episode = story.renderedFit;
  return episode?.contentVersion === story.contentVersion && sameFrameSize(episode.frame, story.frame)
    ? episode : null;
}

/** The browser measures the current type. It never chooses smaller typography. */
export function renderedFitTarget(story, report) {
  const words = story.body.trim().split(/\s+/u).filter(Boolean).length;
  const fingerprint = digest([report.key, report.overflow, Math.round(report.bodyHeight),
    Math.round(report.availableBodyHeight), Math.round(report.minimumLineHeight)]);
  const roomForLine = report.availableBodyHeight >= Math.max(1, report.minimumLineHeight) + 2;
  return {
    fingerprint, words, roomForLine,
    maxWords: roomForLine && report.bodyHeight > 0
      ? Math.max(0, Math.min(words - 1, Math.floor(words * report.availableBodyHeight / report.bodyHeight * 0.85)))
      : 0,
  };
}

export const renderedFitMessage = (reason) =>
  (reason === "space"
    ? "The current headline and typography leave too little space for body copy."
    : "Copy still overflows after the bounded rendered-fit corrections.") +
  " Current copy and typography are preserved. Enlarge this block, approve a layout adjustment, or retry fitting.";
