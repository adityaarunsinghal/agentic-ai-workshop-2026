import { createHash } from "node:crypto";
import { boundedText } from "./parsers.mjs";
import { upstreamId } from "./schemas.mjs";

const retrievedAt = "2026-10-13T12:00:00.000Z";
const topics = [
  ["tools", "Tools return observations", "story"],
  ["sources", "Reading sources before writing", "story"],
  ["layout", "Show HN: A toy newspaper editor", "show"],
  ["review", "Ask HN: Reviewing a synthetic draft", "ask"],
  ["memory", "Keeping an explicit reading list", "story"],
  ["jobs", "A fictional newsroom job", "job"],
];

const records = topics.map(([topic, title, category], index) => {
  const id = 900001 + index;
  return {
    id: `fixture-hn-${id}`, kind: "hn", upstreamId: String(id),
    title: `Fixture: ${title}`,
    url: `https://example.org/session-02-fixture/${topic}`,
    canonicalUrl: `https://example.org/session-02-fixture/${topic}`,
    text: `This is a synthetic workshop source about ${topic}. In this invented exercise, ` +
      `a fictional editor compared two toy workflows and recorded the results locally. ` +
      `The example does not report a real event, product, study, or employer.`,
    evidenceLevel: "hn-post", retrievedAt, publishedAt: retrievedAt,
    author: "fixture-editor", score: 10 + index, category,
    origin: "fixture", synthetic: true,
    contentDigest: createHash("sha256").update(`synthetic-source-${id}`).digest("hex"),
    completeness: { completeForRequestedScope: true, synthetic: true },
  };
});

function metadata(record) {
  return { ...record, text: "", evidenceLevel: "metadata" };
}

/** No fixture method invokes HTTP, DNS, the decoder, or an inference provider. */
export function fixtureSources(method, args) {
  const losses = [];
  let selected = [];
  if (method === "listStories") {
    const pool = ["top", "new", "best"].includes(args.category)
      ? records : records.filter((record) => record.category === args.category);
    selected = pool.slice(0, args.count).map(metadata);
  } else if (method === "getStory") {
    selected = records.filter((record) => record.upstreamId === String(upstreamId(args.id)));
  } else if (method === "getComments") {
    const story = records.find((record) => record.upstreamId === String(upstreamId(args.id)));
    if (story) {
      selected = Array.from({ length: Math.min(args.limit, 4) }, (_, index) => {
        const id = 910001 + index;
        return {
          id: `fixture-hn-comment-${id}`, kind: "hn-comment", upstreamId: String(id),
          title: `Fixture comment ${index + 1} on ${story.title}`,
          url: `https://example.org/session-02-fixture/comments/${id}`,
          canonicalUrl: `https://example.org/session-02-fixture/comments/${id}`,
          text: `Synthetic comment ${index + 1}: this fictional discussion is evidence of a ` +
            `commenter's opinion, rather than independent verification of the story.`,
          evidenceLevel: "comment", author: "fixture-editor", retrievedAt, publishedAt: retrievedAt,
          relatedSourceIds: [story.id], parentUpstreamId: story.upstreamId, depth: 1,
          origin: "fixture", synthetic: true,
          completeness: { completeForRequestedScope: true, synthetic: true },
        };
      });
    }
  } else if (method === "searchHn" || method === "searchGoogleNews" || method === "searchWeb") {
    const terms = args.query.toLowerCase().split(/\s+/);
    selected = records.filter((record) =>
      terms.some((term) => `${record.title} ${record.text}`.toLowerCase().includes(term)) &&
      (method !== "searchHn" || (args.category === "story"
        ? record.category !== "job" : record.category === args.category)),
    ).slice(0, args.limit).map((record) => ({
      ...record,
      ...(method === "searchWeb" ? {
        id: `fixture-search-${record.upstreamId}`, kind: "web-search",
        text: `Synthetic search snippet: ${record.title}. Open the source to read its content.`,
        evidenceLevel: "search-snippet", provider: "fixture", query: args.query,
      } : method === "searchGoogleNews" ? {
        id: `fixture-news-${record.upstreamId}`, kind: "google-news",
        text: `Synthetic news feed summary: ${record.title}. Publisher content has not been read.`,
        evidenceLevel: "feed-summary", publisher: "Fictional Workshop News",
      } : { text: "", evidenceLevel: "metadata" }),
    }));
  } else if (method === "fetchRead") {
    const record = records.find((candidate) => candidate.url === args.url);
    if (record) {
      const excerpt = boundedText(record.text, args.maxChars);
      const candidates = records.filter((source) => source.id !== record.id);
      selected = [{
        ...record, ...excerpt,
        id: `fixture-web-${record.upstreamId}`, kind: "web", evidenceLevel: "article-text",
        links: candidates.slice(0, args.maxLinks).map((source) => ({ title: source.title, url: source.url })),
        linksTruncated: args.maxLinks > 0 && candidates.length > args.maxLinks,
        relatedSourceIds: args.sourceId ? [args.sourceId] : [],
        completeness: { completeForRequestedScope: !excerpt.truncated, synthetic: true, truncated: excerpt.truncated },
      }];
      if (excerpt.truncated)
        losses.push({ code: "TEXT_LIMIT", message: "The synthetic source was shortened to the requested text limit." });
    } else {
      losses.push({ code: "FIXTURE_URL_UNAVAILABLE", message: "Fixture mode only reads its declared synthetic source URLs." });
    }
  }
  if (!selected.length && !losses.length && !method.startsWith("search"))
    losses.push({ code: "FIXTURE_NOT_FOUND", message: "The requested item is absent from the synthetic fixture." });
  return { records: structuredClone(selected), losses };
}
