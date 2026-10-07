/**
 * Safe action guidance shared by the HTTP boundary and browser preflight.
 * Field names and messages come from this allowlist, never submitted values
 * or Ajv's diagnostic text. The server's strict schemas remain authoritative.
 */
import { RESOURCE_LIMITS_FOR_HARNESS_TESTING } from "./limits.mjs";

const choice = (values) => (value) => values.includes(value);
const text =
  (maximum, required = false) =>
  (value) =>
    typeof value === "string" &&
    Array.from(value).length <= maximum &&
    (!required || Boolean(value.trim()));
const integer = (maximum) => (value) =>
  Number.isInteger(value) && value >= 1 && value <= maximum;

export const ACTION_FIELDS = Object.freeze({
  "": { message: "Send an action with only id, type and data." },
  id: { message: "The action ID must be a UUID. Submit a new action." },
  type: { message: "Choose a supported action." },
  data: {
    message: "Action data must contain only the fields for this action.",
  },
  "data.text": {
    id: "prompt",
    message: `Enter a question with some non-whitespace text, up to ${RESOURCE_LIMITS_FOR_HARNESS_TESTING.inputCharacters} characters.`,
    valid: text(RESOURCE_LIMITS_FOR_HARNESS_TESTING.inputCharacters, true),
  },
  "data.options": {
    message: "Briefing settings must contain only supported options.",
  },
  "data.options.control": {
    id: "control",
    message: "Choose agent or fixed control for the briefing.",
    valid: choice(["agent", "fixed"]),
  },
  "data.options.category": {
    id: "category",
    message: "Choose the top, new or best HN category.",
    valid: choice(["top", "new", "best"]),
  },
  "data.options.count": {
    id: "count",
    message: `Listing size must be a whole number from 1 to ${RESOURCE_LIMITS_FOR_HARNESS_TESTING.sourceResults}.`,
    valid: integer(RESOURCE_LIMITS_FOR_HARNESS_TESTING.sourceResults),
  },
  "data.options.topic": {
    id: "topic",
    message: "Briefing topic must be text up to 256 characters.",
    valid: text(256),
  },
  "data.options.reviewer": {
    id: "reviewer",
    message: "Reviewer must be enabled or disabled.",
    valid: (value) => typeof value === "boolean",
  },
  "data.options.permission": {
    id: "permission",
    message: "Choose ask or allow for user-preferences authority.",
    valid: choice(["ask", "allow"]),
  },
  "data.delaySeconds": {
    id: "delay",
    message: `Schedule delay must be a whole number from 1 to ${RESOURCE_LIMITS_FOR_HARNESS_TESTING.scheduleSeconds} seconds.`,
    valid: integer(RESOURCE_LIMITS_FOR_HARNESS_TESTING.scheduleSeconds),
  },
  "data.topic": {
    id: "remember-topic",
    message: "Saved interest must be text up to 256 characters.",
    valid: text(256),
  },
  "data.sourceIds": {
    message: `Choose 1 to ${RESOURCE_LIMITS_FOR_HARNESS_TESTING.userPreferencesEntries} distinct observed HN source IDs, each 1 to 128 characters.`,
  },
  "data.sessionId": {
    message: "The conversation ID is missing or invalid. Refresh the view.",
  },
  "data.briefingId": {
    message: "The briefing ID is missing or invalid. Refresh the view.",
  },
  "data.approvalId": {
    message: "The approval ID is missing or invalid. Refresh the view.",
  },
  "data.accepted": { message: "Approval must be accepted or declined." },
  "data.allowForRun": {
    message:
      "user-preferences permission for this briefing must be enabled or disabled.",
  },
  "data.checkpointId": {
    message: "The checkpoint ID is missing or invalid. Refresh the view.",
  },
  "data.operationId": {
    message: "The operation ID is missing or invalid. Refresh the view.",
  },
});

/** Only controls consumed by this action participate in its preflight. */
export function editableActionFields(type) {
  if (["run", "schedule"].includes(type))
    return [
      "data.text",
      ...Object.keys(ACTION_FIELDS).filter((field) =>
        field.startsWith("data.options."),
      ),
      ...(type === "schedule" ? ["data.delaySeconds"] : []),
    ];
  if (["steer", "follow_up"].includes(type)) return ["data.text"];
  if (type === "remember") return ["data.topic"];
  return [];
}

/** Forward only a recognized validation field through HTTP and action lookup. */
export function publicActionField(error) {
  return error?.code === "INVALID_ACTION" &&
    typeof error.field === "string" &&
    Object.hasOwn(ACTION_FIELDS, error.field)
    ? { field: error.field }
    : {};
}
