/** Display projections only. Original records remain in the server archive. */
export function activityStatus(status = "") {
  if (["settled", "completed", "complete"].includes(status)) return "Completed";
  return status ? status[0].toUpperCase() + status.slice(1).replaceAll("_", " ") : "";
}

export function activityDuration(record) {
  const value = record?.durationMs;
  if (!Number.isFinite(value) || value < 0) return "";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

export function activityLabel(record) {
  let label = record.label || record.toolName || record.type || record.kind || "Activity";
  const prefix = /^(tool|model|harness|user)(?:\s*[·:]\s*|\s+)/i;
  while (prefix.test(label) && label.match(prefix)[1].toLowerCase() === record.actor)
    label = label.replace(prefix, "");
  return label;
}

function callKey(record) {
  const type = record.type ?? record.kind ?? "";
  if (/^tool_execution_(start|end)$/.test(type) && record.toolCallId)
    return JSON.stringify(["tool", record.taskId ?? record.briefingId, record.agentRunId,
      record.operationId, record.toolCallId]);
  return null;
}

/** Pair only records on this page. Protocol mode returns every original row. */
export function inspectionActivities(records, view = "teaching") {
  const groups = new Map();
  for (const record of records) {
    const key = view === "teaching" ? callKey(record) ?? record.id : record.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups].map(([key, originals]) => {
    const start = originals.find((record) => record.type?.endsWith("_start"));
    const end = originals.find((record) => record.type?.endsWith("_end"));
    const first = start ?? originals[0];
    const record = start && end ? {
      ...start,
      status: end.status ?? start.status,
      durationMs: start.durationMs ?? end.durationMs,
      updatedSequence: Math.max(start.updatedSequence ?? 0, end.updatedSequence ?? 0),
    } : first;
    return {
      key, record,
      outcomeId: start && end ? end.id : first.endRecordId,
      originalCount: originals.length,
    };
  });
}
