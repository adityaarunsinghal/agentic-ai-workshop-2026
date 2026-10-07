/**
 * Local preferences use an acknowledged SQLite transaction.
 * A separate project directory gets its own database; fixtures use :memory:.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessError } from "../agent/pi-mini.mjs";
import { RESOURCE_LIMITS_FOR_HARNESS_TESTING as limits } from "../support/limits.mjs";

export function createLocalStore(filename = ":memory:") {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      etag TEXT NOT NULL
    );
  `);
  const select = database.prepare(
    "SELECT value, etag FROM preferences WHERE key = ?",
  );
  const put = database.prepare(`
    INSERT INTO preferences (key, value, etag) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, etag = excluded.etag
  `);
  function load(signal) {
    signal?.throwIfAborted();
    const row = select.get("hn-memory");
    return row
      ? {
          key: "hn-memory",
          schema: "chat.v1",
          value: JSON.parse(row.value),
          etag: row.etag,
        }
      : null;
  }
  function save(value, etag, signal) {
    signal?.throwIfAborted();
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > limits.userPreferencesBytes)
      throw new HarnessError(
        "STORAGE_LIMIT",
        "The complete preferences object exceeds the local storage limit.",
      );
    database.exec("BEGIN IMMEDIATE");
    try {
      const previous = load(signal);
      if ((previous?.etag ?? null) !== etag)
        throw Object.assign(
          new HarnessError(
            "STORAGE_CONFLICT",
            "Preferences changed after they were loaded. Reload before saving.",
          ),
          { status: 412 },
        );
      const nextEtag = `"${randomUUID()}"`;
      put.run("hn-memory", encoded, nextEtag);
      database.exec("COMMIT");
      return {
        key: "hn-memory",
        schema: "chat.v1",
        value: structuredClone(value),
        etag: nextEtag,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return { load, save, close: () => database.close() };
}
