// LEARNING: The fact-check archive is a bundled document collection the three
// arrangements search and read through tool calls. It is NOT fixture mode: the
// documents are real text shipped with the demo, and a live model reasons over what
// it actually reads here. The seeded newspaper story restates these documents' claims,
// twenty of them wrong, and every wrong claim has a near-miss sibling document that
// matches the same search terms and states the stale value — so a value can be
// confirmed only by READING, never from a search title alone. That is the whole point
// of the exercise: an arrangement that trusts a search title or an outdated notice
// gets the claim wrong; one that reads the document that settles it gets it right.
// Next: topologies.mjs runs an arrangement; each search/read call lands here.

import dataset from "./archive-dataset.json" with { type: "json" };

// Search is title-and-body keyword overlap, the same scoring used to validate the dataset: a
// title hit counts double a body hit, ties break by document ID so results are stable.
// It returns up to five document IDs WITH TITLES ONLY, so a value is never visible from
// search; the agent must read a document to see its text.
const STOPWORDS = new Set([
  "the", "and", "for", "was", "branch", "with", "from", "that", "this", "its", "after", "who", "has",
]);

const normalize = (value) => {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9$.%]+/gu, " ").trim();
};

const terms = (value) => {
  return normalize(value)
    .split(" ")
    .filter((word) => {
      return word.length > 2 && !STOPWORDS.has(word);
    });
};

// Freeze the bundled documents and claims once; the archive is read-only.
const DOCS = Object.freeze(dataset.docs.map((doc) => Object.freeze({ ...doc })));
const DOC_BY_ID = new Map(DOCS.map((doc) => [doc.id, doc]));

// Precompute each document's term sets so a search over 160 documents stays cheap even
// when every per-claim agent in the graph searches at once.
const DOC_TERMS = DOCS.map((doc) => {
  return {
    doc,
    titleTerms: new Set(terms(doc.title)),
    bodyTerms: new Set(terms(doc.text)),
  };
});

export const ARCHIVE_HEADLINE = dataset.headline;
export const ARCHIVE_CLAIMS = Object.freeze(dataset.claims.map((claim) => Object.freeze({ ...claim })));
export const ARCHIVE_SIZE = DOCS.length;

// A canonical reading order for the seeded story. The dataset ships several claim
// orderings for bias testing; the demo seeds the first (natural) order so the story a
// student opens is deterministic and the claim/sentence split below is stable.
const STORY_ORDER = dataset.orders?.[0] ?? ARCHIVE_CLAIMS.map((_claim, index) => index + 1);

// search(query) -> up to five {id, title} matches, titles only. Mirrors the broker
// runner's scoring exactly so a live run here behaves like the validated runs.
export function searchArchive(query) {
  const queryTerms = terms(query);
  if (!queryTerms.length) {
    return [];
  }
  const scored = [];
  for (const entry of DOC_TERMS) {
    let score = 0;
    for (const term of queryTerms) {
      score += (entry.titleTerms.has(term) ? 2 : 0) + (entry.bodyTerms.has(term) ? 1 : 0);
    }
    if (score > 0) {
      scored.push({ doc: entry.doc, score });
    }
  }
  scored.sort((a, b) => {
    return b.score - a.score || (a.doc.id < b.doc.id ? -1 : 1);
  });
  return scored.slice(0, 5).map((entry) => {
    return { id: entry.doc.id, title: entry.doc.title };
  });
}

// read(docId) -> the document's full text, or null for an unknown ID. Reading is the
// only way to see a document's values, which is how the exercise separates an
// arrangement that reads its evidence from one that trusts a title.
export function readArchive(docId) {
  const doc = DOC_BY_ID.get(String(docId ?? "").trim());
  if (!doc) {
    return null;
  }
  return { id: doc.id, title: doc.title, text: doc.text };
}

// The seeded newspaper story: the archive's claims rendered as one newspaper story,
// one sentence per claim in the canonical order, under the dataset's headline. A
// student opens this story and runs the fact-check against the bundled archive. The
// claims are the dataset's claim TEXT verbatim, so the deterministic sentence split in
// claimsFromStory recovers exactly this claim set (claims are derived by CODE, never by
// a model audit).
export function seededStory() {
  const claimById = new Map(ARCHIVE_CLAIMS.map((claim) => [claim.id, claim]));
  const sentences = STORY_ORDER.map((number) => {
    return claimById.get(`c${number}`);
  }).filter(Boolean);
  return {
    headline: ARCHIVE_HEADLINE,
    body: sentences.map((claim) => claim.text).join(" "),
    // The planted errors, so the editor can highlight them for the class and, after a run,
    // show which ones the arrangement caught. Only the sentence text and ID; the agents
    // never read story metadata, they get claims from the sentence split.
    plantedClaims: sentences
      .filter((claim) => claim.truth === "unsupported")
      .map((claim) => ({ id: claim.id, text: claim.text })),
  };
}

// The gold-standard answer key for scoring a run OUT OF BAND (the live recorder and the
// tests use it; the arrangements never see it). Each entry carries the claim's truth,
// the document that settles it, and the corrected value for a wrong claim.
export function answerKey() {
  return ARCHIVE_CLAIMS.map((claim) => {
    return {
      claimId: claim.id,
      text: claim.text,
      truth: claim.truth,
      gold: claim.gold,
      fix: claim.fix ?? null,
      kind: claim.kind,
    };
  });
}
