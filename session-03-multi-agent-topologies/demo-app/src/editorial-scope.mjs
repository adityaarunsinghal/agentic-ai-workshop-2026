// LEARNING: Reuse valid story decisions and send only the copy and evidence needed for new questions.
// Start: createEditorialScopes() and its plan() function.
// Next: presentation.mjs for the exact sentence boundaries and available styles.

import { createHash } from "node:crypto";
import { DECISION_MODELS, DECISION_QUESTION_ID_LIMIT } from "./agent/policy.mjs";
import { SENTENCE_STYLES } from "./presentation.mjs";

// ============================================================================
// MAIN BEHAVIOR - read this section first
// ============================================================================

/** Completed decisions survive unrelated edits; each backend/model keeps its own version. */
export function createEditorialScopes(initial, initialInput) {
  const typography = new Map(),
    verification = new Map();
  function plan(
    current,
    input,
    {
      noulBars = false,
      editorialBackend = noulBars ? "decisions" : "chat",
      model = editorialBackend === "decisions"
        ? current.settings?.decisionModel
        : current.settings?.model,
    } = {},
  ) {
    const identity = modelIdentity(editorialBackend, model);
    const scope = {
      backend: editorialBackend,
      modelFamily: editorialModelFamily(editorialBackend, model),
      typographyStoryIds: [],
      verificationStoryIds: [],
      retainedTypographyStoryIds: [],
      retainedVerificationStoryIds: [],
      restored: [],
    };
    remember(current, input);
    for (const item of Object.values(input.items)) {
      const story = current.issue.stories.find((story) => {
        return story.id === item.id;
      });
      for (const [kind, cache, basis, enabled, valid] of [
        [
          "typography",
          typography,
          typographyBasis(input, item),
          !item.locked && item.sentences.length > 0,
          validTypography(story, item),
        ],
        [
          "verification",
          verification,
          verificationBasis(input, item),
          noulBars,
          validCheck(story),
        ],
      ]) {
        if (!enabled) {
          continue;
        }
        const field = kind === "typography" ? "typography" : "factCheck";
        const retained =
          kind === "typography"
            ? "retainedTypographyStoryIds"
            : "retainedVerificationStoryIds";
        const cached = cache.get(cacheKey(identity, basis));
        if (cached) {
          scope[retained].push(item.id);
          if (
            !valid ||
            (story[field]?.basisDigest && story[field].basisDigest !== basis) ||
            story[field]?.requestId !== cached.requestId ||
            resultIdentity(story[field], kind === "verification") !== identity
          ) {
            scope.restored.push({
              storyId: item.id,
              field,
              basis,
              value: structuredClone(cached),
            });
          }
        } else {
          scope[`${kind}StoryIds`].push(item.id);
        }
      }
    }
    return scope;
  }
  // Old saved decisions can be adopted only at startup, before any new edits.
  remember(initial, initialInput, { adoptLegacy: true });
  function remember(current, input, { adoptLegacy = false } = {}) {
    for (const item of Object.values(input.items)) {
      const story = current.issue.stories.find((story) => {
        return story.id === item.id;
      });
      if (!story) {
        continue;
      }
      for (const [cache, value, basis, valid] of [
        [
          typography,
          story.typography,
          typographyBasis(input, item),
          validTypography(story, item),
        ],
        [
          verification,
          story.factCheck,
          verificationBasis(input, item),
          validCheck(story),
        ],
      ]) {
        const key = cacheKey(resultIdentity(value, cache === verification), basis);
        if (
          key &&
          valid &&
          (value.basisDigest === basis ||
            (adoptLegacy &&
              (!value.basisDigest ||
                (cache === typography &&
                  value.basisDigest === legacyTypographyBasis(input, item)))))
        ) {
          cache.set(key, structuredClone(value));
        }
        while (cache.size > 128) {
          cache.delete(cache.keys().next().value);
        }
      }
    }
  }
  return { plan, remember };
}

/** Keep edition decisions compact; only requested stories carry copy and evidence. */
export function projectEditorialInput(input, questions, typographyPolicy) {
  const storyIds = new Set(
    Object.values(input.items)
      .filter((item) => {
        return (
          Object.hasOwn(questions, verificationQuestionId(item.id)) ||
          item.sentences.some((sentence) => {
            return Object.hasOwn(questions, sentenceQuestionId(item.id, sentence.id));
          })
        );
      })
      .map((item) => {
        return item.id;
      }),
  );
  const editionQuestions = [
    "layout",
    "reaction",
    "lead",
    "layout_cleanup",
    "layout_basis",
  ];
  const edition = editionQuestions.some((id) => {
    return Object.hasOwn(questions, id);
  });
  const items = Object.fromEntries(
    Object.values(input.items)
      .filter((item) => {
        return edition || storyIds.has(item.id);
      })
      .map((item) => {
        return [
          item.id,
          storyIds.has(item.id)
            ? {
                ...item,
                // Offsets identify exact copy without duplicating every sentence's text.
                sentences: item.sentences.map(({ id, start, end }) => {
                  return { id, start, end };
                }),
                evidence: evidence(item),
              }
            : {
                id: item.id,
                headline: item.headline,
                section: item.section,
                locked: item.locked,
                frame: item.frame,
                wordCount: item.wordCount,
                characterCount: item.characterCount,
                // An explicitly bounded preview is context for edition layout, not evidence for a fact check.
                copyPreview: item.copy.slice(0, 600),
                copyPreviewTruncated: item.copy.length > 600,
                evidence: evidence(item).map(({ text, ...metadata }) => {
                  return metadata;
                }),
              },
        ];
      }),
  );
  return JSON.parse(
    JSON.stringify({
      focus: input.focus,
      audience: input.audience,
      editionDate: input.editionDate,
      ...(edition
        ? { appliedTemplate: input.appliedTemplate, movedStoryId: input.movedStoryId }
        : {}),
      items,
      ...(Object.keys(questions).some((id) => {
        return id.startsWith("style_");
      })
        ? { typographyPolicy }
        : {}),
    }),
  );
}

// ============================================================================
// SUPPORTING HELPERS - policies, validation, and bookkeeping
// ============================================================================

const digest = (value) => {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
};

const modelIdentity = (backend, model) => {
  const family = editorialModelFamily(backend, model);
  return family ? `${backend}:${family}` : null;
};
const resultIdentity = (value, nativeOnly = false) => {
  const native = DECISION_MODELS.includes(
    editorialModelFamily("decisions", value?.model),
  );
  return modelIdentity(
    value?.backend ?? (nativeOnly || native ? "decisions" : "chat"),
    value?.model,
  );
};
const cacheKey = (identity, basis) => {
  return identity ? `${identity}:${basis}` : null;
};
export const sentenceQuestionId = (storyId, sentenceId) => {
  return `style_${digest(storyId).slice(0, 24)}_${sentenceId}`;
};
export const verificationQuestionId = (storyId) => {
  const id = `check_${storyId}`;
  return id.length <= DECISION_QUESTION_ID_LIMIT && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(id)
    ? id
    : `check_${digest(storyId).slice(0, 32)}`;
};
const evidence = (item) => {
  return item.evidence.map(({ retrievedAt, ...source }) => {
    return source;
  });
};
const common = (input, item) => {
  return {
    id: item.id,
    focus: input.focus,
    audience: input.audience,
    headline: item.headline,
    copy: item.copy,
  };
};

export const typographyBasis = (input, item) => {
  return digest({
    policy: "story-typography.v3",
    ...common(input, item),
    section: item.section,
  });
};
const legacyTypographyBasis = (input, item) => {
  return digest({
    policy: "story-typography.v2",
    ...common(input, item),
    evidence: evidence(item),
    section: item.section,
    width: item.frame?.width,
    height: item.frame?.height,
  });
};
export const verificationBasis = (input, item) => {
  return digest({
    policy: "story-verification.v1",
    ...common(input, item),
    evidence: evidence(item),
  });
};

/** Only native dated snapshots already accepted by response validation share a family. */
export function editorialModelFamily(backend, model) {
  if (typeof model !== "string" || !model) {
    return null;
  }
  if (backend === "decisions") {
    for (const base of DECISION_MODELS) {
      if (model === base) {
        return base;
      }
      if (!model.startsWith(`${base}-`)) {
        continue;
      }
      const date = model.slice(base.length + 1);
      if (!/^\d{8}$/u.test(date)) {
        continue;
      }
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      const parsed = new Date(`${iso}T00:00:00Z`);
      if (
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === iso
      ) {
        return base;
      }
    }
  }
  return model;
}

function validTypography(story, item) {
  return (
    story.typography?.contentVersion === story.contentVersion &&
    item.sentences.every(({ id, start, end }) => {
      return (
        Object.hasOwn(SENTENCE_STYLES, story.typography.styles?.[id]) &&
        story.typography.sentences?.some((part) => {
          return part.id === id && part.start === start && part.end === end;
        })
      );
    })
  );
}

function validCheck(story) {
  return (
    story.factCheck?.status === "complete" &&
    story.factCheck.contentVersion === story.contentVersion &&
    Number.isFinite(story.factCheck.probability) &&
    story.factCheck.probability >= 0 &&
    story.factCheck.probability <= 1
  );
}
