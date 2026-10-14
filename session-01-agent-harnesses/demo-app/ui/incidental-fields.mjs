export function isIncidentalField(key, value) {
  if (typeof key !== "string" || value == null) return false;
  const timestamp = ["at", "timestamp"].includes(key) || /(?:At|_at)$/.test(key);
  if (timestamp) return typeof value === "number" ||
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(value));
  if (["modelId", "profileId"].includes(key)) return false;
  const identifier = key === "id" || /(?:Id|ID|_id)$/.test(key);
  const opaque = typeof value === "number" || /^\d+$/.test(String(value)) ||
    /(?:^|[-_:])[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(value)) ||
    /(?:^|[-_:])[a-f0-9]{12,}$/i.test(String(value));
  return identifier && opaque;
}
