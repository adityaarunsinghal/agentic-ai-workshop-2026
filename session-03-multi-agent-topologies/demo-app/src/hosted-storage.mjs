import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Keep the manifest namespace and the original reference's current-edition /
// pending-actions objects intact. Its A2UI state is not this editor's schema.
export const STORAGE_SCHEMA = "newspaper.edition.v1";
export const EDITOR_KEY = "mcp-editor-current-v1";
export const JOURNAL_KEY = "mcp-editor-pending-v1";
const EDITOR_SCHEMA = "session2.editor.v1";
const JOURNAL_SCHEMA = "session2.editor-journal.v1";
const MIB = 1024 * 1024;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const version = (value) => Number.isSafeInteger(value) && value >= 0;
const etag = (value) => typeof value === "string" && /^"[^"\r\n]{1,200}"$/.test(value);
const stable = (value) => JSON.stringify(value, function (key, item) {
  return record(item) ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item;
});
const digest = (value) => createHash("sha256").update(stable(value)).digest("hex");
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const conflict = () => failure("STORAGE_CONFLICT",
  "Another visit changed the saved edition or pending journal. Your pending work is preserved. Reopen the app and use Account export to recover conflicting work.");

export function validateEditorState(state) {
  if (!record(state) || !record(state.issue) || typeof state.issue.id !== "string" ||
      !state.issue.id || !version(state.issue.revision) ||
      !Array.isArray(state.issue.stories) || !Array.isArray(state.issue.sources) ||
      !record(state.settings) || !["tools", "editor", "final", "research"].includes(state.settings.stage) ||
      !record(state.preferences) || typeof state.preferences.topic !== "string" ||
      !Array.isArray(state.preferences.readingList) ||
      ["jobs", "briefings", "suggestions", "approvals"].some((key) => !Array.isArray(state[key])) ||
      ["trace", "execution", "streamRevision", "persistence"].some((key) => Object.hasOwn(state, key)))
    throw failure("INVALID_SAVED_STATE", "The hosted editor state has an unsupported format. Saved data was preserved.");
  const ids = new Set();
  for (const story of state.issue.stories) {
    const id = story?.slotId ?? story?.id;
    if (!record(story) || typeof id !== "string" || !id || ids.has(id) ||
        !record(story.frame) || !["x", "y", "width", "height"].every((key) => Number.isFinite(story.frame[key])) ||
        typeof story.headline !== "string" || typeof story.body !== "string" ||
        !version(story.contentVersion) || !Array.isArray(story.sourceIds))
      throw failure("INVALID_SAVED_STATE", "A saved story failed validation. Saved data was preserved.");
    ids.add(id);
  }
  return state;
}

function checkedSnapshot(value) {
  if (!record(value) || value.schemaVersion !== EDITOR_SCHEMA || !version(value.version) ||
      value.version < 1 || typeof value.operationId !== "string" || !record(value.state) ||
      typeof value.contentDigest !== "string" || digest(value.state) !== value.contentDigest)
    throw failure("INVALID_SAVED_STATE", "The hosted edition failed its schema or integrity check. Saved data was preserved.");
  validateEditorState(value.state);
  return value;
}

function checkedJournal(value) {
  if (!record(value) || value.schemaVersion !== JOURNAL_SCHEMA ||
      !(value.baseETag === null || etag(value.baseETag)) || !version(value.baseVersion) ||
      (value.baseETag === null) !== (value.baseVersion === 0))
    throw failure("INVALID_SAVED_STATE", "The hosted pending journal needs recovery. Saved data was preserved.");
  checkedSnapshot(value.snapshot);
  if (value.snapshot.version !== value.baseVersion + 1)
    throw failure("INVALID_SAVED_STATE", "The pending journal has an invalid version. Saved data was preserved.");
  return value;
}

/**
 * The broker capability owns app/member/schema authority. Native journal.*
 * calls belong to the portal browser bridge, not the runtime broker. Like the
 * reference EditionStore, this server keeps a CAS-protected object journal.
 * Two fixed keys bound storage growth; acknowledged payloads are cleared.
 */
export async function createHostedStorage(config) {
  if (config.readiness) return { readiness: true, runId: null };
  const schema = config.persistenceSchema ?? STORAGE_SCHEMA;
  if (schema !== STORAGE_SCHEMA)
    throw failure("STORAGE_CONFIG", "Hosted persistence must retain the manifest's newspaper.edition.v1 namespace.");
  let base;
  try { base = new URL(`${String(config.brokerUrl).replace(/\/+$/, "")}/`); } catch {}
  if (!base || !["http:", "https:"].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash || !config.token)
    throw failure("STORAGE_CONFIG", "Hosted persistence requires the scoped workshop broker URL and run token.");
  const fetcher = config.persistenceFetch ?? globalThis.fetch;
  const timeoutMs = config.persistenceTimeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw failure("STORAGE_CONFIG", "Persistence timeout must be between 1 and 60000 milliseconds.");
  async function request(path, init = {}, missing = false) {
    let response;
    try {
      response = await fetcher(new URL(path, base), {
        ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${config.token}`,
          "x-workshop-contract-version": "workshop.app.v1",
          ...init.headers,
        },
      });
    } catch {
      throw failure("STORAGE_UNAVAILABLE", "Hosted storage did not acknowledge the request. Pending work is retained; retry save explicitly.",
        { retryable: true });
    }
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      if ([409, 412, 428].includes(response.status)) throw conflict();
      // Read only bounded, typed diagnostics. Never expose a proxy's raw body,
      // and do not turn a permanent refusal into a transient transport failure.
      const body = await readJson(response, 16384).catch(() => null);
      const brokerError = record(body?.error) ? body.error : {};
      const code = response.status === 413 ? "STORAGE_QUOTA" :
        [401, 403].includes(response.status) ? "STORAGE_SESSION" : "STORAGE_UNAVAILABLE";
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter === null ? 0 : /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      throw failure(code, code === "STORAGE_QUOTA"
        ? "Hosted storage is full. Pending work is retained; export your work before reducing it."
        : code === "STORAGE_SESSION"
          ? "This visit cannot access hosted storage. Pending work is retained; reopen through the app store."
          : "Hosted storage could not confirm the save. Pending work is retained; retry save explicitly.", {
        httpStatus: response.status,
        retryable: ([408, 429, 502, 503, 504].includes(response.status) ||
          (response.status === 500 && brokerError.retryable === true)) && brokerError.retryable !== false,
        retryAfterMs: Number.isNaN(retryAfterMs) ? 0 : retryAfterMs,
        ...(/^[A-Z][A-Z0-9_]{0,63}$/.test(brokerError.code ?? "") ? { brokerCode: brokerError.code } : {}),
      });
    }
    return readJson(response, MIB + 16384);
  }
  async function readJson(response, limit) {
    // Bound response allocation too. Storage values retain the 1 MiB limit.
    const reader = response.body?.getReader(), chunks = [];
    let bytes = 0;
    try {
      if (!reader) throw new Error("Missing body");
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > limit) throw new Error("Oversized response");
        chunks.push(item.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      await reader?.cancel().catch(() => {});
      throw failure("STORAGE_RESPONSE", "Hosted storage returned an invalid acknowledgement. Pending work is retained.");
    } finally { reader?.releaseLock(); }
  }
  const bootstrap = await request("v1/bootstrap");
  if (bootstrap?.contractVersion !== "workshop.app.v1" ||
      !["hosted", "readiness"].includes(bootstrap.mode))
    throw failure("STORAGE_CONFIG", "Hosted storage requires a compatible C01 bootstrap.");
  if (bootstrap.mode === "readiness") return { readiness: true, runId: null };
  if (bootstrap.storage?.schema !== schema || !Number.isSafeInteger(bootstrap.storage.objectBytes) ||
      bootstrap.storage.objectBytes < 1 || !Number.isSafeInteger(bootstrap.storage.visitorBytes) ||
      bootstrap.storage.visitorBytes < 1 || typeof bootstrap.runId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(bootstrap.runId) || bootstrap.simulated !== false)
    throw failure("STORAGE_CONFIG", "The hosted bootstrap does not authorize this editor's visitor storage.");
  const objectBytes = Math.min(MIB, bootstrap.storage.objectBytes);
  const visitorBytes = Math.min(20 * MIB, bootstrap.storage.visitorBytes);
  let current = null, journal = null, attempt = null, loaded = false, problem = null;
  let legacyAvailable = false;
  const keyPath = (key) => `v1/storage/objects/${encodeURIComponent(key)}`;
  let owner;
  function checkedObject(body, key) {
    const object = body?.object;
    if (!record(object) || object.key !== key || object.schema !== schema || !etag(object.etag) ||
        typeof object.appId !== "string" || !object.appId ||
        typeof object.memberId !== "string" || !object.memberId ||
        Buffer.byteLength(JSON.stringify(object.value) ?? "") > objectBytes)
      throw failure("STORAGE_RESPONSE", "Hosted storage returned an invalid object. Saved data was preserved.");
    const scope = `${object.appId}/${object.memberId}`;
    if (owner && owner !== scope)
      throw failure("STORAGE_RESPONSE", "Hosted storage returned inconsistent ownership. Saved data was preserved.");
    owner = scope;
    return object;
  }
  async function get(key) {
    const body = await request(`${keyPath(key)}?schema=${encodeURIComponent(schema)}`, {}, true);
    return body === null ? null : checkedObject(body, key);
  }
  async function put(key, value, previousETag) {
    const body = await request(keyPath(key), {
      method: "PUT",
      headers: { "content-type": "application/json",
        ...(previousETag === null ? { "if-none-match": "*" } : { "if-match": previousETag }) },
      body: JSON.stringify({ schema, value }),
    });
    const object = checkedObject(body, key);
    if (stable(object.value) !== stable(value) || object.etag === previousETag)
      throw failure("STORAGE_RESPONSE", "Hosted storage did not confirm the exact saved content and new version.");
    return object;
  }
  const currentVersion = () => current?.value.version ?? 0;
  const matches = (snapshot) => current?.value.operationId === snapshot.operationId &&
    current.value.version === snapshot.version && current.value.contentDigest === snapshot.contentDigest;
  function checkSize(snapshot, pending) {
    const sizes = [snapshot, pending].map((value) => Buffer.byteLength(JSON.stringify(value)));
    if (sizes.some((bytes) => bytes > objectBytes) || sizes[0] + sizes[1] > visitorBytes)
      throw failure("STORAGE_QUOTA", "The edition and recovery journal exceed hosted storage limits. Nothing was truncated; export your work before reducing it.");
  }
  async function readCurrent() {
    const nextCurrent = await get(EDITOR_KEY);
    if (nextCurrent) checkedSnapshot(nextCurrent.value);
    const nextJournal = await get(JOURNAL_KEY);
    if (nextJournal?.value !== null && nextJournal) checkedJournal(nextJournal.value);
    current = nextCurrent;
    journal = nextJournal;
  }
  async function finish(pending) {
    if (!matches(pending.snapshot)) {
      if ((current?.etag ?? null) !== pending.baseETag || currentVersion() !== pending.baseVersion)
        throw conflict();
      current = await put(EDITOR_KEY, pending.snapshot, pending.baseETag);
    }
    // Do not acknowledge another writer's journal, even after our own PUT.
    if (journal?.value && stable(journal.value) === stable(pending))
      journal = await put(JOURNAL_KEY, null, journal.etag);
    else if (journal?.value) throw conflict();
    attempt = null;
    problem = null;
  }
  async function reconcile(pending, expectedJournalETag) {
    await readCurrent();
    if (matches(pending.snapshot)) return finish(pending);
    if ((current?.etag ?? null) !== pending.baseETag || currentVersion() !== pending.baseVersion)
      throw conflict();
    if (journal?.value) {
      if (stable(journal.value) !== stable(pending)) throw conflict();
    } else {
      if ((journal?.etag ?? null) !== expectedJournalETag) throw conflict();
      journal = await put(JOURNAL_KEY, pending, journal?.etag ?? null);
    }
    await finish(pending);
  }
  async function complete(pending, expectedJournalETag, action) {
    // At most two recovery passes. An uncertain PUT is never replayed without
    // reading both objects and proving the original operation's CAS authority.
    const waits = [250, 750];
    for (let index = 0; ; index++) {
      try { await action(); return; }
      catch (error) {
        if (error.code === "STORAGE_CONFLICT") {
          // Another recovering visit may have finished exactly our operation.
          // Only a canonical match with an empty journal resolves this race.
          const observed = await readCurrent().then(() => true, () => false);
          if (observed && matches(pending.snapshot) && journal && journal.value === null) {
            attempt = null; problem = null; return;
          }
        }
        const wait = Math.max(waits[index] ?? Infinity, error.retryAfterMs ?? 0);
        if (!error.retryable || wait > 5000) throw error;
        await delay(wait);
        action = () => reconcile(pending, expectedJournalETag);
      }
    }
  }
  function status() {
    return {
      mode: "hosted", schema, key: EDITOR_KEY,
      phase: problem ? problem.code === "STORAGE_CONFLICT" ? "conflict" : "failed" : current ? "saved" : "pending",
      version: currentVersion(), etag: current?.etag ?? null,
      acknowledgedRevision: current?.value.state.issue.revision ?? null,
      error: problem ? { code: problem.code, message: problem.message,
        ...(problem.httpStatus ? { httpStatus: problem.httpStatus } : {}),
        ...(problem.brokerCode ? { brokerCode: problem.brokerCode } : {}) } : null,
      recoveryPending: Boolean(attempt || journal?.value),
      legacyAvailable, objectBytes, visitorBytes,
    };
  }
  let recovery = null;
  return {
    readiness: false, runId: bootstrap.runId, status,
    async load() {
      await readCurrent();
      loaded = true;
      if (journal?.value) {
        attempt = journal.value;
        const pending = attempt;
        try { await complete(pending, journal.etag, () => finish(pending)); }
        catch (error) { problem = error; }
        // A still-blocked journal is the pending edition, not disposable cache.
        // Restore it only when its base still has authority; conflicts retain
        // the canonical edition and the separate journal for explicit recovery.
        if (problem && problem.code !== "STORAGE_CONFLICT" &&
            (matches(pending.snapshot) || ((current?.etag ?? null) === pending.baseETag &&
              currentVersion() === pending.baseVersion)))
          return structuredClone(pending.snapshot.state);
      }
      if (!current && !journal) {
        // Inspect only the known historical key. Never list, translate, delete
        // or acknowledge the reference's objects or portal journal entries.
        legacyAvailable = Boolean(await get("current-edition"));
      }
      return current ? structuredClone(current.value.state) : null;
    },
    async save(state) {
      if (!loaded) throw failure("STORAGE_CONFIG", "Restore hosted storage before saving.");
      if (problem || attempt) throw problem ?? conflict();
      validateEditorState(state);
      if (current?.value.contentDigest === digest(state)) return status();
      const snapshot = {
        schemaVersion: EDITOR_SCHEMA, operationId: randomUUID(),
        version: currentVersion() + 1, contentDigest: digest(state), state: structuredClone(state),
      };
      const pending = {
        schemaVersion: JOURNAL_SCHEMA, baseETag: current?.etag ?? null,
        baseVersion: currentVersion(), snapshot,
      };
      checkSize(snapshot, pending);
      attempt = pending;
      try {
        // A losing writer cannot replace a pending journal observed by another
        // visit. Every phase is conditional, including clearing the journal.
        const expectedJournalETag = journal?.etag ?? null;
        await complete(pending, expectedJournalETag, async () => {
          journal = await put(JOURNAL_KEY, pending, expectedJournalETag);
          await finish(pending);
        });
      } catch (error) { problem = error; throw error; }
      return status();
    },
    async retry() {
      if (recovery) return recovery;
      if (!attempt) {
        if (problem) throw problem;
        return;
      }
      const pending = attempt;
      const expectedJournalETag = journal?.etag ?? null;
      recovery = complete(pending, expectedJournalETag, () => reconcile(pending, expectedJournalETag))
        .catch((error) => { problem = error; throw error; })
        .finally(() => { recovery = null; });
      return recovery;
    },
  };
}
