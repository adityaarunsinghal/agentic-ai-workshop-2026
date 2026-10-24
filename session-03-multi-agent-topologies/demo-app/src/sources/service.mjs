// LEARNING: createSources exposes search and reading as recorded observations.
// Follow fetchRead from a public page to a source ID used by agent/story.mjs.

import { createHash } from "node:crypto";
import { fixtureSources } from "./fixtures.mjs";
import { decodeNewsUrl } from "./news-decoder.mjs";
import {
  boundedText,
  decodeBytes,
  htmlText,
  parseArticle,
  parseNewsFeed,
} from "./parsers.mjs";
import {
  canonicalUrl,
  createPublicHttp,
  publicUrl,
  SourceError,
} from "./public-http.mjs";
import { sourceSchemas, upstreamId } from "./schemas.mjs";
import { searchPublicWeb } from "./web-search.mjs";

const HN = "https://hacker-news.firebaseio.com/v0/";
const discussionUrl = (id) => {
  return `https://news.ycombinator.com/item?id=${id}`;
};
const hash = (value) => {
  return createHash("sha256").update(value).digest("hex");
};
const isoTime = (time) => {
  return Number.isSafeInteger(time) &&
    time > 0 &&
    Number.isFinite(new Date(time * 1000).getTime())
    ? new Date(time * 1000).toISOString()
    : null;
};
const recordRank = (record) => {
  return !record.text
    ? 0
    : ["metadata", "feed-summary", "search-snippet", "profile"].includes(
          record.evidenceLevel,
        )
      ? 1
      : 2;
};

function loss(error, details = {}) {
  return {
    ...details,
    code: error instanceof SourceError ? error.code : "SOURCE_FAILED",
    message:
      error instanceof SourceError
        ? error.message
        : "This source could not be retrieved or parsed.",
  };
}

/** Source IDs are visit-owned observations, never IDs supplied by a webpage. */
export function createSources({ store, trace, config = {} }) {
  // MAIN BEHAVIOR: each adapter returns evidence with its limitations attached.
  if (!store?.snapshot || !store?.addSources || !trace?.fetch) {
    throw new TypeError("Sources require the session store and traced fetch.");
  }
  const fixture = config.fixture === true || config.mode === "fixture";
  const http = createPublicHttp({ trace, mode: config.mode });
  const requestedTimeout = Math.floor(Number(config.sourceTimeoutMs ?? 15000));
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(100, Math.min(30000, requestedTimeout))
    : 15000;
  const knownSources = () => {
    return store.snapshot().issue.sources ?? [];
  };

  return {
    listStories(input = {}, options) {
      return run("listStories", input, options, async (args, context) => {
        const ids = await json(`${HN}${args.category}stories.json`, context);
        if (
          !Array.isArray(ids) ||
          ids.length > 1000 ||
          ids.some((id) => {
            return !Number.isSafeInteger(id) || id < 1;
          }) ||
          new Set(ids).size !== ids.length
        ) {
          throw new SourceError(
            "HN_INVALID_LIST",
            "HN returned an invalid story listing.",
          );
        }
        return collect(ids.slice(0, args.count), context, async (id) => {
          return hnStory(await hnItem(id, context));
        });
      });
    },
    getStory(input, options) {
      return run("getStory", input, options, (args, context) => {
        return collect([upstreamId(args.id)], context, async (id) => {
          return hnStory(await hnItem(id, context), { includeText: true });
        });
      });
    },
    getComments(input, options) {
      return run("getComments", input, options, async (args, context) => {
        const storyId = upstreamId(args.id);
        const root = await hnItem(storyId, context);
        if (!["story", "job", "poll"].includes(root.type)) {
          throw new SourceError(
            "HN_INVALID_STORY",
            "Read comments from an HN story, job, or poll.",
          );
        }
        const records = [];
        const losses = [];
        const queue = (Array.isArray(root.kids) ? root.kids : [])
          .slice(0, args.limit * 3)
          .map((id) => {
            return { id, depth: 1, parent: storyId };
          });
        const seen = new Set();
        let reads = 0;
        let omitted = Array.isArray(root.kids) && root.kids.length > queue.length;
        while (queue.length && records.length < args.limit && reads < args.limit * 3) {
          context.signal.throwIfAborted();
          const entry = queue.shift();
          if (!Number.isSafeInteger(entry.id) || entry.id < 1 || seen.has(entry.id)) {
            losses.push({
              code: "HN_INVALID_COMMENT",
              message: "HN supplied an invalid or repeated comment reference.",
            });
            continue;
          }
          seen.add(entry.id);
          reads++;
          try {
            const raw = await hnItem(entry.id, context);
            if (raw.type !== "comment" || raw.parent !== entry.parent) {
              throw new SourceError(
                "HN_INVALID_COMMENT",
                "HN returned a comment outside the requested thread.",
              );
            }
            const excerpt = await htmlText(raw.text, 3000);
            if (!excerpt.text) {
              throw new SourceError(
                "HN_EMPTY_COMMENT",
                "The comment has no readable public text.",
              );
            }
            records.push({
              id: `hn-comment-${raw.id}`,
              kind: "hn-comment",
              upstreamId: String(raw.id),
              title: `HN comment by ${boundedText(raw.by, 64).text || "unknown user"}`,
              url: discussionUrl(raw.id),
              canonicalUrl: discussionUrl(raw.id),
              ...excerpt,
              evidenceLevel: "comment",
              author: boundedText(raw.by, 64).text || null,
              publishedAt: isoTime(raw.time),
              retrievedAt: new Date().toISOString(),
              relatedSourceIds: [`hn-${storyId}`],
              parentUpstreamId: String(raw.parent),
              depth: entry.depth,
              origin: "live",
              contentDigest: hash(JSON.stringify(raw)),
              completeness: {
                completeForRequestedScope: !excerpt.truncated,
                truncated: excerpt.truncated,
              },
            });
            if (excerpt.truncated) {
              losses.push({
                code: "TEXT_LIMIT",
                upstreamId: String(raw.id),
                message: "A comment was shortened to its text limit.",
              });
            }
            const kids = Array.isArray(raw.kids) ? raw.kids : [];
            if (entry.depth < args.maxDepth) {
              const available = Math.max(0, args.limit * 3 - reads - queue.length);
              queue.push(
                ...kids.slice(0, available).map((id) => {
                  return { id, depth: entry.depth + 1, parent: raw.id };
                }),
              );
              omitted ||= kids.length > available;
            } else {
              omitted ||= kids.length > 0;
            }
          } catch (error) {
            context.signal.throwIfAborted();
            losses.push(loss(error, { upstreamId: String(entry.id) }));
          }
        }
        if (queue.length || omitted) {
          losses.push({
            code: "COMMENT_SCOPE_LIMIT",
            message: "This bounded sample omits part of the HN discussion.",
          });
        }
        return { records, losses };
      });
    },
    searchHn(input, options) {
      return run("searchHn", input, options, async (args, context) => {
        const url = new URL(
          `https://hn.algolia.com/api/v1/${args.sort === "date" ? "search_by_date" : "search"}`,
        );
        const tags = { story: "story", ask: "ask_hn", show: "show_hn" };
        url.search = new URLSearchParams({
          query: args.query,
          tags: tags[args.category],
          hitsPerPage: String(args.limit),
          page: "0",
        }).toString();
        const result = await json(url.href, context);
        if (!Array.isArray(result.hits)) {
          throw new SourceError(
            "HN_INVALID_SEARCH",
            "HN search returned an invalid result list.",
          );
        }
        const hits = result.hits.slice(0, args.limit);
        return collect(
          hits.map((hit) => {
            return hit.objectID;
          }),
          context,
          async (objectID) => {
            const hit = hits.find((item) => {
              return item.objectID === objectID;
            });
            const id = upstreamId(hit.objectID);
            return hnStory(
              {
                id,
                type: "story",
                title: hit.title,
                url: hit.url,
                text: hit.story_text,
                by: hit.author,
                time: hit.created_at_i,
                score: hit.points,
                descendants: hit.num_comments,
              },
              { includeText: true, search: true },
            );
          },
        );
      });
    },
    searchGoogleNews(input, options) {
      return run("searchGoogleNews", input, options, async (args, context) => {
        const url = new URL("https://news.google.com/rss/search");
        url.search = new URLSearchParams({
          q: args.query,
          hl: args.language,
          gl: args.country,
          ceid: `${args.country}:${args.language}`,
        }).toString();
        const response = await http.read(url.href, {
          ...context,
          kind: "source.news.rss",
          headers: { accept: "application/rss+xml,application/xml,text/xml" },
        });
        const feed = await parseNewsFeed(
          decodeBytes(response.bytes, response.contentType),
        );
        const records = [];
        const losses = [];
        for (const item of (feed.items ?? []).slice(0, args.limit)) {
          try {
            const link = publicUrl(item.link).href;
            const excerpt = await htmlText(item.content ?? item.contentSnippet, 2000);
            let publisherUrl = null;
            if (item.source?.$?.url) {
              try {
                publisherUrl = publicUrl(item.source.$.url).href;
              } catch (error) {
                losses.push(loss(error, { scope: "publisher-link" }));
              }
            }
            records.push({
              id: `news-${hash(link).slice(0, 24)}`,
              kind: "google-news",
              title: boundedText(item.title, 600).text || "Untitled news result",
              url: link,
              canonicalUrl: canonicalUrl(link),
              ...excerpt,
              evidenceLevel: "feed-summary",
              publishedAt: Number.isFinite(Date.parse(item.isoDate ?? item.pubDate))
                ? new Date(item.isoDate ?? item.pubDate).toISOString()
                : null,
              retrievedAt: new Date().toISOString(),
              publisher:
                boundedText(
                  typeof item.source === "string" ? item.source : item.source?._,
                  200,
                ).text || null,
              publisherUrl,
              origin: "live",
              contentDigest: hash(JSON.stringify(item)),
              completeness: {
                completeForRequestedScope: !excerpt.truncated,
                publisherArticleRead: false,
              },
            });
            if (excerpt.truncated) {
              losses.push({
                code: "TEXT_LIMIT",
                message: "A news feed summary was shortened to its text limit.",
              });
            }
          } catch (error) {
            losses.push(loss(error, { scope: "news-item" }));
          }
        }
        return { records, losses };
      });
    },
    searchWeb(input, options) {
      return run("searchWeb", input, options, (args, context) => {
        return searchPublicWeb(args, http, context);
      });
    },
    fetchRead(input, options) {
      return run("fetchRead", input, options, async (args, context) => {
        const losses = [];
        try {
          const target = await decodeNewsUrl(args.url, http, context);
          const response = await http.read(target, {
            ...context,
            kind: "source.read",
            maxBytes: 1024 * 1024,
            allowPartial: true,
          });
          const type = response.contentType.split(";")[0].trim().toLowerCase();
          if (!["text/html", "application/xhtml+xml", "text/plain"].includes(type)) {
            throw new SourceError(
              "UNSUPPORTED_CONTENT",
              "Read public HTML or plain text; binary and other document formats are unsupported.",
            );
          }
          const decoded = decodeBytes(response.bytes, response.contentType);
          const parsed =
            type === "text/plain"
              ? {
                  ...boundedText(decoded, args.maxChars),
                  title: new URL(response.url).hostname,
                  canonicalUrl: canonicalUrl(response.url),
                  author: null,
                  publishedAt: null,
                  evidenceLevel: "plaintext",
                  links: [],
                  linksTruncated: false,
                }
              : await parseArticle(decoded, response.url, args.maxChars, args.maxLinks);
          if (!parsed.text && parsed.evidenceLevel !== "metadata") {
            throw new SourceError(
              "EMPTY_TEXT",
              "The retrieved document has no readable source text.",
            );
          }
          if (response.truncated || parsed.truncated) {
            losses.push({
              code: "TEXT_LIMIT",
              message:
                "This reading is a bounded excerpt, rather than the complete document.",
            });
          }
          if (parsed.evidenceLevel === "metadata") {
            losses.push({
              code:
                parsed.extractionReason === "access-challenge"
                  ? "SOURCE_ACCESS_CHALLENGE"
                  : "SOURCE_METADATA_ONLY",
              reason: parsed.extractionReason,
              url: response.url,
              message:
                "Only metadata, a title, navigation, or an access screen was retrieved; no article body or video transcript was read. Use an observed content link, an accessible transcript, or another public source. Do not cite this as evidence of the unseen content or bypass sign-in, CAPTCHA, or access restrictions.",
            });
          } else if (parsed.readableArticle === false) {
            losses.push({
              code: "ARTICLE_EXTRACTION_UNAVAILABLE",
              message: "Article extraction failed; the result is a page-text excerpt.",
            });
          }
          if (parsed.linksTruncated) {
            losses.push({
              code: "LINK_LIMIT",
              message:
                "Only a bounded set of observed links is included. Raise maxLinks up to 24 or follow a relevant page.",
            });
          }
          const related = args.sourceId
            ? [args.sourceId]
            : knownSources()
                .filter((record) => {
                  return [record.url, record.canonicalUrl].includes(args.url);
                })
                .map((record) => {
                  return record.id;
                });
          return {
            records: [
              {
                id: `web-${hash(parsed.canonicalUrl).slice(0, 24)}`,
                kind: "web",
                title: parsed.title,
                url: response.url,
                canonicalUrl: parsed.canonicalUrl,
                text: parsed.text,
                evidenceLevel: parsed.evidenceLevel,
                author: parsed.author,
                ...(parsed.extractionReason
                  ? { extractionReason: parsed.extractionReason }
                  : {}),
                links: parsed.links,
                linksTruncated: parsed.linksTruncated,
                publishedAt: parsed.publishedAt,
                retrievedAt: new Date().toISOString(),
                originalUrl: args.url,
                resolvedFrom: target !== args.url ? args.url : null,
                relatedSourceIds: related.slice(0, 12),
                redirects: response.redirects,
                origin: "live",
                contentDigest: hash(response.bytes),
                completeness: {
                  completeForRequestedScope: losses.length === 0,
                  truncated: response.truncated || parsed.truncated,
                  readableArticle: parsed.readableArticle ?? null,
                },
              },
            ],
            losses,
          };
        } catch (error) {
          context.signal.throwIfAborted();
          const failure = loss(error, { sourceId: args.sourceId, url: args.url });
          if (error.code === "HTTP_FAILED") {
            failure.message +=
              " Use another public source or an accessible transcript; this reader does not bypass access restrictions.";
          }
          return { records: [], losses: [failure] };
        }
      });
    },
  };

  // SUPPORTING HELPERS: declarations stay in the same scope.

  function remember(records) {
    const known = new Map(
      knownSources().map((record) => {
        return [record.id, record];
      }),
    );
    return records.map((record) => {
      const prior = known.get(record.id);
      // Correct a previous title-only reading of the exact same text without
      // discarding a genuinely richer historical reading when a site changes.
      const correctedMetadata =
        record.evidenceLevel === "metadata" &&
        record.extractionReason &&
        prior?.text === record.text;
      // A later listing must not erase previously retrieved text or its timestamp.
      if (
        prior &&
        !correctedMetadata &&
        (recordRank(prior) > recordRank(record) ||
          (record.completeness?.truncated && prior.text?.length > record.text?.length))
      ) {
        return {
          ...prior,
          score: record.score ?? prior.score,
          metadataRetrievedAt: record.retrievedAt,
        };
      }
      return record;
    });
  }

  async function run(method, input, options, operation) {
    const documentVersion = store.snapshot().documentVersion ?? 0;
    const args = sourceSchemas[method].parse(input ?? {});
    let syntheticReading;
    if (method === "fetchRead") {
      const source =
        args.sourceId &&
        knownSources().find((record) => {
          return record.id === args.sourceId;
        });
      if (args.sourceId && !source) {
        throw new SourceError(
          "UNKNOWN_SOURCE",
          "Read only source IDs observed in this session.",
        );
      }
      if (!args.url && !source) {
        throw new SourceError(
          "MISSING_URL",
          "Supply a public URL or an observed source ID.",
        );
      }
      const syntheticSource =
        fixture &&
        source?.origin === "fixture" &&
        source.text?.trim() &&
        !["metadata", "feed-summary", "search-snippet"].includes(source.evidenceLevel);
      if (
        args.url &&
        source &&
        ![source.url, source.canonicalUrl].some((url) => {
          return (
            url &&
            (syntheticSource
              ? url === args.url
              : canonicalUrl(url) === canonicalUrl(args.url))
          );
        })
      ) {
        throw new SourceError(
          "SOURCE_URL_MISMATCH",
          "The URL does not belong to the referenced source.",
        );
      }
      if (syntheticSource) {
        const excerpt = boundedText(source.text, args.maxChars);
        syntheticReading = {
          records: [
            {
              ...source,
              ...excerpt,
              kind: source.kind ?? "fixture",
              links: (source.links ?? []).slice(0, args.maxLinks),
              linksTruncated:
                args.maxLinks > 0 &&
                (source.linksTruncated || (source.links?.length ?? 0) > args.maxLinks),
              canonicalUrl: source.canonicalUrl ?? source.url,
              retrievedAt: source.retrievedAt ?? new Date().toISOString(),
              completeness: {
                ...source.completeness,
                completeForRequestedScope: !excerpt.truncated,
                synthetic: true,
                truncated: excerpt.truncated,
              },
            },
          ],
          losses: excerpt.truncated
            ? [
                {
                  code: "TEXT_LIMIT",
                  message: "The synthetic source was shortened to its text limit.",
                },
              ]
            : [],
        };
        args.url ??= source.canonicalUrl ?? source.url;
      } else {
        args.url = publicUrl(args.url ?? source.canonicalUrl ?? source.url).href;
      }
    }
    const context =
      options instanceof AbortSignal ? { signal: options } : (options ?? {});
    const signal = AbortSignal.any([
      ...(context.signal ? [context.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    const inherited = trace.context?.() ?? {};
    const { signal: _signal, ...correlation } = context;
    const span = trace.start(`source.${method}`, {
      ...inherited,
      ...correlation,
      args,
      fixture,
    });
    try {
      signal.throwIfAborted();
      const operationContext = { ...inherited, ...context, signal, parentId: span.id };
      const perform = () => {
        return fixture
          ? (syntheticReading ?? fixtureSources(method, args))
          : operation(args, operationContext);
      };
      const result = trace.withContext
        ? await trace.withContext(
            { ...inherited, ...correlation, parentId: span.id },
            perform,
          )
        : await perform();
      signal.throwIfAborted();
      const records = result.records;
      if ((store.snapshot().documentVersion ?? 0) !== documentVersion) {
        throw new SourceError(
          "SOURCE_SCOPE_CHANGED",
          "A new newspaper replaced this source request.",
        );
      }
      if (records.length) {
        await store.addSources(remember(records));
      }
      const batch = {
        schemaVersion: "newspaper.sources.v1",
        records,
        ...(result.discovery ? { discovery: result.discovery } : {}),
        losses: result.losses ?? [],
        fixture,
        completeForRequestedScope: (result.losses ?? []).length === 0,
        scope: {
          method,
          ...(args.count !== undefined ? { count: args.count } : { limit: args.limit }),
          maxDepth: args.maxDepth,
          maxLinks: args.maxLinks,
        },
      };
      span.finish({
        status: "completed",
        sourceIds: records.map((record) => {
          return record.id;
        }),
        completeForRequestedScope: batch.completeForRequestedScope,
        losses: batch.losses,
      });
      return batch;
    } catch (error) {
      span.finish({ status: signal.aborted ? "cancelled" : "failed", ...loss(error) });
      throw error;
    }
  }

  async function json(url, context) {
    const result = await http.read(url, {
      ...context,
      kind: "source.json",
      headers: { accept: "application/json" },
    });
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
    } catch {
      throw new SourceError(
        "INVALID_JSON",
        "The source returned invalid or incomplete JSON.",
      );
    }
  }

  async function hnItem(id, context) {
    const raw = await json(`${HN}item/${id}.json`, context);
    if (!raw || raw.dead || raw.deleted) {
      throw new SourceError(
        "HN_UNAVAILABLE",
        "The HN item is missing, deleted, or unavailable.",
      );
    }
    if (raw.id !== id || !isoTime(raw.time)) {
      throw new SourceError(
        "HN_INVALID_ITEM",
        "HN returned an invalid item identity or publication date.",
      );
    }
    return raw;
  }

  async function hnStory(raw, { includeText = false, search = false } = {}) {
    if (
      !["story", "job", "poll"].includes(raw.type) ||
      typeof raw.title !== "string" ||
      !raw.title.trim()
    ) {
      throw new SourceError(
        "HN_INVALID_STORY",
        "HN returned an unsupported story record.",
      );
    }
    const losses = [];
    let url = discussionUrl(raw.id);
    if (raw.url) {
      try {
        url = publicUrl(raw.url).href;
      } catch (error) {
        losses.push(loss(error, { upstreamId: String(raw.id), scope: "story-link" }));
      }
    }
    const excerpt = includeText
      ? await htmlText(raw.text, 8000)
      : { text: "", truncated: false };
    if (excerpt.truncated) {
      losses.push({
        code: "TEXT_LIMIT",
        message: "The HN post text was shortened to its retrieval limit.",
      });
    }
    const record = {
      id: `hn-${raw.id}`,
      kind: "hn",
      upstreamId: String(raw.id),
      title: boundedText(raw.title, 600).text,
      url,
      canonicalUrl: canonicalUrl(url),
      discussionUrl: discussionUrl(raw.id),
      text: excerpt.text,
      evidenceLevel: excerpt.text
        ? search
          ? "search-snippet"
          : "hn-post"
        : "metadata",
      publishedAt: isoTime(raw.time),
      retrievedAt: new Date().toISOString(),
      author: boundedText(raw.by, 64).text || null,
      score: Number.isSafeInteger(raw.score) ? raw.score : null,
      commentCount: Number.isSafeInteger(raw.descendants) ? raw.descendants : null,
      type: raw.type,
      origin: "live",
      contentDigest: hash(JSON.stringify(raw)),
      completeness: {
        completeForRequestedScope: losses.length === 0,
        truncated: excerpt.truncated,
      },
    };
    return { record, losses };
  }

  async function collect(ids, context, read) {
    // Small batches avoid turning a single listing into an unbounded fan-out.
    const records = [];
    const losses = [];
    for (let offset = 0; offset < ids.length; offset += 3) {
      context.signal.throwIfAborted();
      const results = await Promise.allSettled(ids.slice(offset, offset + 3).map(read));
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          records.push(result.value.record);
          losses.push(...result.value.losses);
        } else {
          context.signal.throwIfAborted();
          losses.push(loss(result.reason, { upstreamId: String(ids[offset + index]) }));
        }
      }
    }
    return { records, losses };
  }
}
