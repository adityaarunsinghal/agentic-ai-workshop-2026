/**
 * Durable user-preferences and an HN reading list.
 * Storage and retrieval are separate from the model's conversation history.
 */
import Ajv from "ajv/dist/2020.js";
import { isDeepStrictEqual } from "node:util";
import { HarnessError } from "../agent/pi-mini.mjs";
import { RESOURCE_LIMITS_FOR_HARNESS_TESTING } from "./limits.mjs";

const hnSourceRecordSchema = {
  type: "object",
  required: [
    "id",
    "kind",
    "upstreamId",
    "title",
    "canonicalUrl",
    "retrievedAt",
    "evidenceLevel",
  ],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    kind: { const: "hn" },
    upstreamId: { type: "string", pattern: "^[0-9]+$" },
    title: { type: "string", minLength: 1, maxLength: 600 },
    canonicalUrl: { type: "string", minLength: 1, maxLength: 2048 },
    retrievedAt: { type: "string", maxLength: 80 },
    evidenceLevel: { const: "metadata" },
  },
};
const validateUserPreferencesValue = new Ajv({ strict: false }).compile({
  type: "object",
  required: ["version", "preferences", "entries"],
  additionalProperties: false,
  properties: {
    version: { const: "hn-memory.v1" },
    preferences: {
      type: "object",
      required: ["topic"],
      additionalProperties: false,
      properties: { topic: { type: "string", maxLength: 256 } },
    },
    entries: {
      type: "array",
      maxItems: RESOURCE_LIMITS_FOR_HARNESS_TESTING.userPreferencesEntries,
      items: hnSourceRecordSchema,
    },
  },
});
const validateHnSourceRecord = new Ajv({ strict: false }).compile(
  hnSourceRecordSchema,
);

/** Accept only complete HN metadata. A URL is a citation, never a fetch command. */
export function requireHnRecord(record) {
  if (!validateHnSourceRecord(record))
    throw new HarnessError(
      "HN_RECORD",
      "HN returned an invalid metadata record.",
    );
  let url;
  try {
    url = new URL(record.canonicalUrl);
  } catch {
    throw new HarnessError("HN_LINK", "HN returned an invalid citation.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !Number.isFinite(Date.parse(record.retrievedAt))
  )
    throw new HarnessError("HN_LINK", "HN returned an unsupported citation.");
  return structuredClone(record);
}

export const emptyUserPreferences = () => ({
  version: "hn-memory.v1",
  preferences: { topic: "" },
  entries: [],
});

function checkedValue(value) {
  if (!validateUserPreferencesValue(value))
    throw new HarnessError(
      "USER_PREFERENCES_SCHEMA",
      "The saved user-preferences have an unsupported shape. Existing data was retained.",
    );
  const ids = new Set();
  for (const record of value.entries) {
    requireHnRecord(record);
    if (ids.has(record.id))
      throw new HarnessError(
        "USER_PREFERENCES_SCHEMA",
        "Saved HN identities repeat.",
      );
    ids.add(record.id);
  }
  return structuredClone(value);
}

/** Conditional saves protect changes made by another view or visit. */
export function createUserPreferences(workshop, publishUserPreferencesState) {
  let savedUserPreferencesValue = emptyUserPreferences(),
    savedUserPreferencesEtag = null,
    userPreferencesLoaded = false,
    pendingUserPreferencesValue = null;

  function publish(status = "saved", error = null) {
    publishUserPreferencesState({
      value: structuredClone(savedUserPreferencesValue),
      etag: savedUserPreferencesEtag,
      loaded: userPreferencesLoaded,
      status,
      error,
      pending: pendingUserPreferencesValue
        ? structuredClone(pendingUserPreferencesValue)
        : null,
    });
  }

  async function load(signal) {
    try {
      const object = await workshop.loadUserPreferences(signal);
      savedUserPreferencesValue = object
        ? checkedValue(object.value)
        : emptyUserPreferences();
      savedUserPreferencesEtag = object?.etag ?? null;
      if (
        pendingUserPreferencesValue &&
        isDeepStrictEqual(
          savedUserPreferencesValue,
          pendingUserPreferencesValue,
        )
      )
        pendingUserPreferencesValue = null;
      userPreferencesLoaded = true;
      publish(object ? "saved" : "empty");
      return structuredClone(savedUserPreferencesValue);
    } catch (error) {
      publish("unavailable", workshop.cleanError(error));
      throw error;
    }
  }

  function propose(toolName, args, evidence) {
    if (!userPreferencesLoaded)
      throw new HarnessError(
        "USER_PREFERENCES_UNAVAILABLE",
        "Reload the user-preferences before saving.",
      );
    const proposedUserPreferencesValue = structuredClone(
      savedUserPreferencesValue,
    );
    let userPreferencesChangeSummary;
    if (toolName === "remember_preferences") {
      proposedUserPreferencesValue.preferences.topic = args.topic;
      userPreferencesChangeSummary = `Remember topic preference: ${args.topic || "(empty)"}`;
    } else if (toolName === "save_reading_list") {
      const known = new Map(
        [...savedUserPreferencesValue.entries, ...evidence.values()].map(
          (record) => [record.id, record],
        ),
      );
      const additions = args.sourceIds.map((id) => {
        const source = known.get(id);
        if (!source)
          throw new HarnessError(
            "UNKNOWN_SOURCE",
            "Save only observed HN source IDs.",
          );
        return requireHnRecord(source);
      });
      const combined = new Map(
        proposedUserPreferencesValue.entries.map((record) => [
          record.id,
          record,
        ]),
      );
      for (const record of additions) combined.set(record.id, record);
      proposedUserPreferencesValue.entries = [...combined.values()];
      userPreferencesChangeSummary = `Save ${additions.length} HN link${additions.length === 1 ? "" : "s"}.`;
    } else
      throw new HarnessError(
        "UNKNOWN_WRITE",
        "This user-preferences action is unavailable.",
      );
    checkedValue(proposedUserPreferencesValue);
    return {
      toolName,
      args: structuredClone(args),
      value: proposedUserPreferencesValue,
      etag: savedUserPreferencesEtag,
      summary: userPreferencesChangeSummary,
    };
  }

  async function commit(proposal, signal) {
    if (proposal.etag !== savedUserPreferencesEtag)
      throw new HarnessError(
        "STORAGE_CONFLICT",
        "The user-preferences changed after approval.",
      );
    pendingUserPreferencesValue = structuredClone(proposal.value);
    publish("saving");
    try {
      const object = await workshop.saveUserPreferences(
        proposal.value,
        proposal.etag,
        signal,
      );
      savedUserPreferencesValue = checkedValue(object.value);
      savedUserPreferencesEtag = object.etag;
      pendingUserPreferencesValue = null;
      publish();
      return {
        saved: true,
        entries: savedUserPreferencesValue.entries.length,
        preferences: savedUserPreferencesValue.preferences,
      };
    } catch (error) {
      publish("save failed", workshop.cleanError(error));
      throw error;
    }
  }

  return {
    load,
    propose,
    commit,
    get value() {
      return structuredClone(savedUserPreferencesValue);
    },
    get etag() {
      return savedUserPreferencesEtag;
    },
    get loaded() {
      return userPreferencesLoaded;
    },
  };
}
