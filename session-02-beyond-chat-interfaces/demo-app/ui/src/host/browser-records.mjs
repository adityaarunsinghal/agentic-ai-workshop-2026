import { compactRecord, LOCAL_SUMMARY_LIMIT } from "../shared/execution.mjs";
import { errorMessage, sanitizeForInspection } from "../shared/state.mjs";

// Diagnostic delivery has its own lifecycle. It never joins an editor action
// queue, retries a tool, or changes whether the browser interaction succeeds.
export async function persistBrowserRecord(entry, { send, updateLocal, onAcknowledged }) {
  const localId = entry.id;
  updateLocal((records) => [
    ...records.filter((record) => record.id !== localId).slice(-(LOCAL_SUMMARY_LIMIT - 1)),
    { ...compactRecord(entry), actor: "host", reportedBy: "browser", deliveryStatus: "pending" },
  ]);
  let acknowledged;
  try {
    acknowledged = await send(entry);
  } catch (error) {
    updateLocal((records) => records.map((record) => record.id === localId ? {
      ...record, deliveryStatus: "failed",
      deliveryError: sanitizeForInspection(errorMessage(error)).slice(0, 300),
    } : record));
    return null;
  }
  // The server stores browser:<uuid>; the retained tab summary uses the event
  // UUID. An acknowledgment must remove that local identity, not the server ID.
  updateLocal((records) => records.filter((record) => record.id !== localId));
  try { onAcknowledged?.(acknowledged); } catch { /* A UI notification cannot undo receipt of the report. */ }
  return acknowledged;
}
