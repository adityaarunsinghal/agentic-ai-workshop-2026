import { ResearchError } from "./policy.mjs";

// These corrections consume the existing run's turn and inference allowance.
export const MAX_FIT_REWRITES = 2;

export function copyFitError(fit) {
  return new ResearchError("STORY_FIT",
    `The candidate contains ${fit.words} words; this slot permits ${fit.maxWords}` +
    (fit.maxCharacters === undefined ? "." : ` and ${fit.maxCharacters} characters (candidate: ${fit.characters}).`) +
    " Current copy is preserved. Enlarge the block, shorten its copy, or retry fitting.");
}

export function copyFitInstruction(fit) {
  return `The proposed body contains ${fit.words} words; this slot permits ${fit.maxWords}. ` +
    (fit.maxCharacters === undefined ? "" :
      `It contains ${fit.characters} characters; the maximum is ${fit.maxCharacters}. `) +
    `Aim for at most ${Math.max(1, Math.floor(fit.maxWords * 0.9))} words, including attribution. ` +
    "Shorten this same grounded draft, preserving meaning, material caveats, attribution and observed sourceIds. " +
    "Retain exact sentences that still serve the shorter version; edit only the copy needed to fit. " +
    "Return {headline,body,sourceIds} JSON. Do not invent facts, pad text, or truncate a sentence. " +
    "Do not call tools or repeat research merely to shorten copy. This correction shares the original run allowance.";
}
