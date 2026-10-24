import { z } from "zod/v4";

export const SOURCE_LIMIT = 12;
export const DEFAULT_LIMIT = 5;
export const sourceIdSchema = z.string().trim().min(1).max(128);
const limit = z.number().int().min(1).max(SOURCE_LIMIT);
const hnId = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^(?:(?:fixture-)?hn-(?:comment-)?)?[1-9]\d{0,15}$/),
]);

export function upstreamId(value) {
  const raw = String(value).replace(/^(?:fixture-)?hn-(?:comment-)?/, "");
  const id = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("Use a positive HN item ID or an observed HN source ID.");
  return id;
}

export const sourceSchemas = {
  listStories: z.strictObject({
    category: z.enum(["top", "new", "best", "ask", "show", "job"]).default("top"),
    count: limit.default(DEFAULT_LIMIT),
  }),
  getStory: z.strictObject({ id: hnId }),
  getComments: z.strictObject({
    id: hnId,
    limit: limit.default(DEFAULT_LIMIT),
    maxDepth: z.number().int().min(1).max(3).default(2),
  }),
  searchHn: z.strictObject({
    query: z.string().trim().min(1).max(300),
    category: z.enum(["story", "ask", "show"]).default("story"),
    sort: z.enum(["relevance", "date"]).default("relevance"),
    limit: limit.default(DEFAULT_LIMIT),
  }),
  searchGoogleNews: z.strictObject({
    query: z.string().trim().min(1).max(300),
    limit: limit.default(DEFAULT_LIMIT),
    language: z.enum(["en", "es", "fr", "de", "it", "pt", "ja"]).default("en"),
    country: z.string().regex(/^[A-Z]{2}$/).default("US"),
  }),
  searchWeb: z.strictObject({
    query: z.string().trim().min(1).max(300),
    limit: limit.default(DEFAULT_LIMIT),
  }),
  fetchRead: z.strictObject({
    url: z.string().trim().min(1).max(2048).optional(),
    sourceId: sourceIdSchema.optional(),
    maxChars: z.number().int().min(200).max(24000).default(12000),
    maxLinks: z.number().int().min(0).max(24).default(12),
  }),
};

export function distinctSourceIds(max = SOURCE_LIMIT) {
  return z.array(sourceIdSchema).min(1).max(max).refine(
    (ids) => new Set(ids).size === ids.length,
    "Source IDs must be distinct.",
  );
}
