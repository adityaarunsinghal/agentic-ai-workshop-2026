export function isIncidentalField(key, value) {
  if (value == null) return false;
  const opaqueText = typeof value === "string" && (
    /(?:^|[-_:])[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ||
    /(?:^|[-_:])[a-f0-9]{12,}$/i.test(value)
  );
  // JSON array renderers use numeric keys. Hide opaque IDs, not ordinary
  // numeric array values such as probabilities or token counts.
  if (typeof key === "number" || (typeof key === "string" && /^\d+$/.test(key)))
    return opaqueText && !/[\/\s]/.test(value);
  if (typeof key !== "string") return false;
  const timestamp = ["at", "timestamp"].includes(key) || /(?:At|_at)$/.test(key);
  if (timestamp) return typeof value === "number" ||
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(value));
  if (["modelId", "profileId"].includes(key)) return false;
  if (/(?:digest|hash|fingerprint|sha(?:1|224|256|384|512)?|md5)$/i.test(key))
    return opaqueText || (typeof value === "string" && /^sha(?:256|384|512)[-:][A-Za-z0-9+/=_-]{24,}$/.test(value));
  const identifier = key === "id" || /(?:Id|ID|_id)$/.test(key);
  const opaque = typeof value === "number" || /^\d+$/.test(String(value)) ||
    opaqueText;
  return identifier && opaque;
}
