import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostedStorage, EDITOR_KEY, JOURNAL_KEY, STORAGE_SCHEMA } from "../src/hosted-storage.mjs";
import { createIssueStore } from "../src/domain/store.mjs";
import { createApplication } from "../src/server.mjs";
import { configuration } from "../src/config.mjs";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// Offline C01 boundary: the caller cannot select an app/member in the body.
// Every request, conditional write and namespace is exercised through fetch.
function broker() {
  const objects = new Map(), calls = [];
  const appId = randomUUID(), runId = randomUUID();
  let fault = null, bootstrapMode = "hosted", visitorBytes = 20 * 1024 * 1024;
  const address = (member, key) => `${member}/${key}`;
  function seed(member, key, value) {
    const object = { appId, memberId: member, key, schema: STORAGE_SCHEMA,
      value: structuredClone(value), etag: `"${randomUUID()}"`,
      bytes: Buffer.byteLength(JSON.stringify(value)),
      updatedAt: new Date().toISOString(), expiresAt: "2026-12-31T00:00:00.000Z" };
    objects.set(address(member, key), object);
    return object;
  }
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://offline-broker.invalid");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-workshop-contract-version"), "workshop.app.v1");
    assert.equal(init.redirect, "error");
    const member = headers.get("authorization")?.replace(/^Bearer /, "");
    assert.ok(member);
    const key = decodeURIComponent(url.pathname.split("/").at(-1));
    const method = init.method ?? "GET";
    const call = { member, key, method };
    calls.push(call);
    if (key === "bootstrap") return Response.json({
      contractVersion: "workshop.app.v1", mode: bootstrapMode, runId, simulated: false,
      storage: { schema: STORAGE_SCHEMA, objectBytes: 1024 * 1024, visitorBytes },
      inference: { selection: { modelId: "openai/gpt-6-luna", profileId: "luna-auto" } },
    });
    assert.match(url.pathname, /^\/v1\/storage\/objects\//);
    if (method === "GET") {
      assert.equal(url.searchParams.get("schema"), STORAGE_SCHEMA);
      return objects.has(address(member, key))
        ? Response.json({ object: objects.get(address(member, key)) })
        : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    assert.equal(method, "PUT");
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ["schema", "value"]);
    assert.equal(body.schema, STORAGE_SCHEMA);
    call.value = body.value;
    call.ifMatch = headers.get("if-match");
    call.ifNoneMatch = headers.get("if-none-match");
    const prior = objects.get(address(member, key));
    if (prior ? headers.get("if-match") !== prior.etag : headers.get("if-none-match") !== "*")
      return Response.json({ error: { code: "STORAGE_CONFLICT" } }, { status: 412 });
    const beforeFault = fault?.({ key, body, after: false });
    if (beforeFault instanceof Response) return beforeFault;
    if (beforeFault)
      return Response.json({ error: { code: "STORAGE_QUOTA" } }, { status: 413 });
    const object = seed(member, key, body.value);
    const afterFault = fault?.({ key, body, after: true });
    if (afterFault instanceof Response) return afterFault;
    if (afterFault) throw new Error("lost acknowledgement");
    return Response.json({ object });
  };
  return {
    objects, calls, fetch, seed, runId,
    object: (member, key) => objects.get(address(member, key)),
    fail(fn) { fault = fn; },
    readiness() { bootstrapMode = "readiness"; },
    quota(bytes) { visitorBytes = bytes; },
    config(member = "visitor-a") {
      return { mode: "hosted", brokerUrl: "https://offline-broker.invalid", token: member,
        persistenceFetch: fetch, persistenceSchema: STORAGE_SCHEMA };
    },
  };
}
async function open(remote, { member = "visitor-a", file } = {}) {
  const config = remote.config(member);
  const persistence = await createHostedStorage(config);
  const restored = await persistence.load();
  const store = await createIssueStore({ config, persistence, restored, file });
  return { store, persistence };
}
const quietTrace = { record() {}, entries: [] };

test("hosted save/reopen retains issue, preferences, manual copy and independent versions", async () => {
  const remote = broker();
  const { store } = await open(remote);
  const slot = store.reserveStory();
  store.editStory(slot.slotId, { headline: "Manual headline", body: "Keep my exact copy." });
  store.lockStory(slot.slotId);
  store.approve(store.remember("agent systems").proposal.id, true);
  store.setStage("final");
  await store.flush();
  const first = store.snapshot();
  assert.equal(first.persistence.phase, "saved");
  assert.equal(remote.object("visitor-a", JOURNAL_KEY).value, null);
  const { store: next } = await open(remote);
  const expected = structuredClone(first.issue);
  expected.stories[0].factCheck = {
    ...expected.stories[0].factCheck, status: "unavailable",
    error: "Assessment completion was not recorded before restart.",
  };
  assert.deepEqual(next.snapshot().issue, expected);
  assert.deepEqual(next.snapshot().preferences, first.preferences);
  assert.equal(next.snapshot().settings.stage, "final");
  next.updateActivity({ editorial: { status: "complete" } });
  await next.flush();
  assert.equal(next.snapshot().issue.revision, first.issue.revision);
  assert.ok(next.snapshot().persistence.version > first.persistence.version);
  for (const key of ["trace", "execution", "streamRevision", "persistence"])
    assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state[key], undefined);
});

test("visitor capability isolation and foreign cache never become restored state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosted-persistence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "cache.json");
  const remote = broker();
  const { store: first } = await open(remote, { file });
  first.setTitle("Visitor A private copy");
  await first.flush();
  const { store: second } = await open(remote, { member: "visitor-b", file });
  assert.equal(second.snapshot().issue.title, "The Agentic Times");
  second.setTitle("Visitor B copy");
  await second.flush();
  assert.equal((await open(remote)).store.snapshot().issue.title, "Visitor A private copy");
  await writeFile(file, "{corrupt-cache");
  assert.equal((await open(remote, { file })).store.snapshot().issue.title, "Visitor A private copy");
});

test("historical A2UI objects and portal journal records are never rewritten or migrated", async () => {
  const remote = broker();
  remote.seed("visitor-a", "current-edition", {
    schemaVersion: STORAGE_SCHEMA, state: { edition: { articles: ["legacy"] } }, receipts: [],
  });
  remote.seed("visitor-a", "pending-actions", [{ action: { actionId: "original-action" } }]);
  remote.seed("visitor-a", "unrelated-setting", { private: "retained" });
  const prior = JSON.stringify([...remote.objects]);
  const { store } = await open(remote);
  assert.equal(store.snapshot().persistence.legacyAvailable, true);
  assert.equal(JSON.stringify([...remote.objects]), prior);
  store.setTitle("New MCP edition");
  await store.flush();
  assert.equal(JSON.stringify([...remote.objects].slice(0, 3)), prior);
  assert.ok(remote.calls.filter((call) => call.method === "PUT")
    .every((call) => [EDITOR_KEY, JOURNAL_KEY].includes(call.key)));
});

test("two writers cannot silently overwrite a saved edition or pending journal", async () => {
  const remote = broker();
  const { store: a } = await open(remote);
  a.setTitle("Baseline");
  await a.flush();
  const { store: b } = await open(remote);
  a.setTitle("Writer A wins");
  await a.flush();
  b.setTitle("Writer B pending");
  await assert.rejects(b.flush(), { code: "STORAGE_CONFLICT" });
  assert.equal(b.snapshot().persistence.phase, "conflict");
  assert.equal(b.snapshot().issue.title, "Writer B pending");
  const before = remote.calls.length;
  b.setFocus("An additional unsaved change");
  await assert.rejects(b.flush(), { code: "STORAGE_CONFLICT" });
  assert.equal(remote.calls.length, before);
  await assert.rejects(b.retryPersistence(), { code: "STORAGE_CONFLICT" });
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state.issue.title, "Writer A wins");
});

test("a failed canonical save retains a durable journal and new runtime safely recovers it", async () => {
  const remote = broker();
  const { store } = await open(remote);
  store.setTitle("Baseline");
  await store.flush();
  remote.fail(({ key, after }) => key === EDITOR_KEY && !after);
  store.setTitle("Recover this exact edit");
  await assert.rejects(store.flush(), { code: "STORAGE_QUOTA" });
  assert.equal(store.snapshot().persistence.phase, "failed");
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state.issue.title, "Baseline");
  assert.equal(remote.object("visitor-a", JOURNAL_KEY).value.snapshot.state.issue.title, "Recover this exact edit");
  remote.fail(null);
  const { store: recovered } = await open(remote);
  assert.equal(recovered.snapshot().issue.title, "Recover this exact edit");
  assert.equal(recovered.snapshot().persistence.phase, "saved");
  assert.equal(remote.object("visitor-a", JOURNAL_KEY).value, null);
});

for (const phase of ["journal", "edition", "ack"]) {
  test(`lost ${phase} acknowledgement reconciles automatically without replaying an accepted PUT`, async () => {
    const remote = broker();
    const { store } = await open(remote);
    let dropped = false;
    remote.fail(({ key, body, after }) => {
      const match = phase === "edition" ? key === EDITOR_KEY :
        key === JOURNAL_KEY && (phase === "ack" ? body.value === null : body.value !== null);
      if (!after || !match || dropped) return false;
      dropped = true;
      return true;
    });
    store.setTitle("Keep this write");
    await store.flush();
    assert.equal(store.snapshot().persistence.phase, "saved");
    const writes = remote.calls.filter(({ key, method }) => key === EDITOR_KEY && method === "PUT");
    assert.equal(writes.length, 1);
    assert.equal(remote.calls.filter(({ method }) => method === "PUT").length, 3);
    assert.equal(remote.object("visitor-a", EDITOR_KEY).value.operationId, writes[0].value.operationId);
    assert.equal(remote.object("visitor-a", JOURNAL_KEY).value, null);
    assert.equal((await open(remote)).store.snapshot().issue.title, "Keep this write");
  });
}

test("transient refusal reconciles before retry, preserving edits made during recovery", async () => {
  const remote = broker();
  const { store } = await open(remote);
  let refused = false;
  remote.fail(({ after }) => {
    if (after || refused) return false;
    refused = true;
    store.setTitle("Newer manual edit");
    return Response.json({ error: { code: "RATE_LIMITED", retryable: true } }, { status: 429 });
  });
  store.setTitle("First pending edit");
  await store.flush();
  const firstPut = remote.calls.findIndex(({ method }) => method === "PUT");
  assert.deepEqual(remote.calls.slice(firstPut, firstPut + 4).map(({ method, key }) => [method, key]), [
    ["PUT", JOURNAL_KEY], ["GET", EDITOR_KEY], ["GET", JOURNAL_KEY], ["PUT", JOURNAL_KEY],
  ]);
  const journals = remote.calls.filter(({ key, value }) => key === JOURNAL_KEY && value);
  assert.equal(journals[0].value.snapshot.operationId, journals[1].value.snapshot.operationId);
  assert.equal(journals[0].ifNoneMatch, journals[1].ifNoneMatch);
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state.issue.title, "Newer manual edit");
  assert.equal(store.snapshot().persistence.phase, "saved");
});

test("persistent transient failure stops after two recovery passes and explicit retries coalesce", async () => {
  const remote = broker();
  const { store } = await open(remote);
  remote.fail(({ after }) => !after && Response.json({
    error: { code: "RUNTIME_UNAVAILABLE", retryable: true },
  }, { status: 503 }));
  store.setTitle("Pending first edit");
  await assert.rejects(store.flush(), { code: "STORAGE_UNAVAILABLE", httpStatus: 503 });
  assert.equal(remote.calls.filter(({ method }) => method === "PUT").length, 3);
  assert.equal(store.snapshot().persistence.error.httpStatus, 503);
  assert.equal(store.snapshot().persistence.error.brokerCode, "RUNTIME_UNAVAILABLE");
  const stopped = remote.calls.length;
  store.setTitle("Pending latest edit");
  await assert.rejects(store.flush(), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(remote.calls.length, stopped);
  remote.fail(null);
  await Promise.all([store.retryPersistence(), store.retryPersistence()]);
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state.issue.title, "Pending latest edit");
  assert.equal(remote.calls.slice(stopped).filter(({ method }) => method === "PUT").length, 6);
  assert.equal(store.snapshot().persistence.phase, "saved");
});

test("permanent refusals and a Retry-After beyond the recovery bound never auto retry", async () => {
  for (const [status, error, headers] of [
    [400, { code: "INVALID_REQUEST" }],
    [403, { code: "SESSION_EXPIRED" }],
    [413, { code: "STORAGE_QUOTA" }],
    [500, { code: "INTERNAL_ERROR" }],
    [500, { code: "INTERNAL_ERROR", retryable: false }],
    [429, { code: "RATE_LIMITED", retryable: true }, { "retry-after": "60" }],
  ]) {
    const remote = broker();
    const { store } = await open(remote);
    remote.fail(({ after }) => !after && Response.json({ error }, { status, headers }));
    store.setTitle("Retain the entire pending edition");
    await assert.rejects(store.flush());
    assert.equal(remote.calls.filter(({ method }) => method === "PUT").length, 1, `HTTP ${status}`);
    assert.equal(store.snapshot().issue.title, "Retain the entire pending edition");
    assert.equal(remote.objects.size, 0);
  }
});

test("an unverified successful response requires explicit reconciliation, never an automatic PUT replay", async () => {
  const remote = broker();
  const { store } = await open(remote);
  let invalid = false;
  remote.fail(({ key, after }) => {
    if (!after || invalid || key !== EDITOR_KEY) return false;
    invalid = true;
    return new Response("{invalid JSON", { status: 200 });
  });
  store.setTitle("An accepted write with a malformed acknowledgement");
  await assert.rejects(store.flush(), { code: "STORAGE_RESPONSE" });
  const before = remote.calls.length;
  await store.retryPersistence();
  assert.equal(remote.calls.slice(before).filter(({ key, method }) => key === EDITOR_KEY && method === "PUT").length, 0);
  assert.equal(store.snapshot().persistence.phase, "saved");
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.version, 1);
});

test("another writer during transient recovery retains ordinary conflict authority", async () => {
  const remote = broker();
  const { store: a } = await open(remote);
  a.setTitle("Baseline"); await a.flush();
  const { store: b } = await open(remote);
  const pending = new Promise((resolve) => {
    let refused = false;
    remote.fail(({ after }) => {
      if (after || refused) return false;
      refused = true; resolve();
      return Response.json({ error: { retryable: true } }, { status: 503 });
    });
  });
  a.setTitle("Writer A pending");
  const saving = assert.rejects(a.flush(), { code: "STORAGE_CONFLICT" });
  await pending;
  remote.fail(null);
  b.setTitle("Writer B wins"); await b.flush();
  await saving;
  assert.equal(a.snapshot().issue.title, "Writer A pending");
  assert.equal(a.snapshot().persistence.phase, "conflict");
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state.issue.title, "Writer B wins");
});

test("a second recovering visit can acknowledge the same operation without a false conflict", async () => {
  const remote = broker(), config = remote.config();
  let recovered = false;
  config.persistenceFetch = async (url, init) => {
    if (!recovered && init.method === "PUT" && String(url).endsWith(EDITOR_KEY)) {
      recovered = true;
      await open(remote);
    }
    return remote.fetch(url, init);
  };
  const persistence = await createHostedStorage(config);
  const store = await createIssueStore({ config, persistence, restored: await persistence.load() });
  store.setTitle("One pending operation");
  await store.flush();
  assert.equal(store.snapshot().persistence.phase, "saved");
  assert.equal(remote.object("visitor-a", JOURNAL_KEY).value, null);
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.version, 1);
});

test("a still-blocked journal restores pending copy and never replaces it with the older edition", async () => {
  const remote = broker();
  const { store } = await open(remote);
  store.setTitle("Older canonical copy"); await store.flush();
  remote.fail(({ key, after }) => key === EDITOR_KEY && !after);
  store.setTitle("Pending journal copy");
  await assert.rejects(store.flush(), { code: "STORAGE_QUOTA" });
  const { store: recovered } = await open(remote);
  assert.equal(recovered.snapshot().issue.title, "Pending journal copy");
  assert.equal(recovered.snapshot().persistence.phase, "failed");
  recovered.setFocus("An edit after reopen");
  remote.fail(null);
  await recovered.retryPersistence();
  const saved = remote.object("visitor-a", EDITOR_KEY).value.state.issue;
  assert.equal(saved.title, "Pending journal copy");
  assert.equal(saved.focus, "An edit after reopen");
});

test("disconnected observers cannot fail confirmed saves or prevent later saves", async () => {
  const remote = broker();
  const { store } = await open(remote);
  let received = null;
  store.subscribe((state) => {
    if (state.persistence.phase === "saved") throw new Error("observer disconnected");
  });
  store.subscribe(async (state) => {
    if (state.persistence.phase === "saved") throw new Error("asynchronous observer disconnected");
  });
  store.subscribe((state) => { received = state; });
  store.setTitle("Confirmed first copy"); await store.flush();
  store.setTitle("Confirmed second copy"); await store.flush();
  assert.equal(received.persistence.phase, "saved");
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state.issue.title, "Confirmed second copy");
  assert.equal(remote.calls.filter(({ key, method }) => key === EDITOR_KEY && method === "PUT").length, 2);
});

test("a stale recovery journal is retained without overwriting a newer canonical edition", async () => {
  const remote = broker();
  const { store } = await open(remote);
  store.setTitle("First");
  await store.flush();
  remote.fail(({ key, after }) => key === EDITOR_KEY && !after);
  store.setTitle("Pending older edit");
  await assert.rejects(store.flush());
  const pending = structuredClone(remote.object("visitor-a", JOURNAL_KEY));
  remote.fail(null);
  const { store: next } = await open(remote);
  next.setTitle("Newer durable edition");
  await next.flush();
  remote.seed("visitor-a", JOURNAL_KEY, pending.value);
  const { store: conflicted } = await open(remote);
  assert.equal(conflicted.snapshot().issue.title, "Newer durable edition");
  assert.equal(conflicted.snapshot().persistence.phase, "conflict");
  assert.equal(remote.object("visitor-a", JOURNAL_KEY).value.snapshot.state.issue.title, "Pending older edit");
});

test("size bounds reject before writes, count UTF-8, and never truncate source evidence", async () => {
  const remote = broker();
  const { store } = await open(remote);
  store.addSources([{ id: "large", title: "Retained evidence", text: "漢".repeat(360000) }]);
  const before = remote.calls.length;
  await assert.rejects(store.flush(), { code: "STORAGE_QUOTA" });
  assert.equal(remote.calls.length, before);
  assert.equal(store.snapshot().issue.sources[0].text.length, 360000);
  assert.equal(remote.objects.size, 0);
  const smaller = broker();
  smaller.quota(1500);
  const { store: constrained } = await open(smaller);
  constrained.setTitle("The current object and journal share the visitor allowance");
  await assert.rejects(constrained.flush(), { code: "STORAGE_QUOTA" });
  assert.equal(smaller.objects.size, 0);
});

test("broker quota failure is sticky; explicit retry saves edits accumulated after the failure", async () => {
  const remote = broker();
  const { store } = await open(remote);
  remote.fail(({ after }) => !after);
  store.setTitle("Unconfirmed");
  await assert.rejects(store.flush(), { code: "STORAGE_QUOTA" });
  store.setTitle("Latest pending copy");
  await assert.rejects(store.flush(), { code: "STORAGE_QUOTA" });
  remote.fail(null);
  await store.retryPersistence();
  assert.equal((await open(remote)).store.snapshot().issue.title, "Latest pending copy");
});

test("corrupt saved envelopes fail without replacing originals", async () => {
  const remote = broker();
  remote.seed("visitor-a", EDITOR_KEY, { schemaVersion: "unknown", state: {} });
  const before = JSON.stringify([...remote.objects]);
  await assert.rejects(open(remote), { code: "INVALID_SAVED_STATE" });
  assert.equal(JSON.stringify([...remote.objects]), before);
  assert.equal(remote.calls.filter(({ method }) => method === "PUT").length, 0);
});

test("mismatched response ownership or schema stops restoration without writes", async () => {
  for (const change of [{ memberId: "another-visitor" }, { schema: "other.schema.v1" }]) {
    const remote = broker();
    const { store } = await open(remote);
    store.setTitle("The original visitor");
    await store.flush();
    Object.assign(remote.object("visitor-a", JOURNAL_KEY), change);
    const writes = remote.calls.filter(({ method }) => method === "PUT").length;
    await assert.rejects(open(remote), { code: "STORAGE_RESPONSE" });
    assert.equal(remote.calls.filter(({ method }) => method === "PUT").length, writes);
  }
});

test("JSON object key reordering retains the content digest and original schema", async () => {
  const remote = broker();
  const { store } = await open(remote);
  store.setTitle("Database JSON key order is not content");
  await store.flush();
  const object = remote.object("visitor-a", EDITOR_KEY);
  object.value.state = Object.fromEntries(Object.entries(object.value.state).reverse());
  assert.equal((await open(remote)).store.snapshot().issue.title, "Database JSON key order is not content");
  assert.equal(object.schema, STORAGE_SCHEMA);
});

test("cache failure cannot turn an acknowledged hosted save into a failed durable save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosted-cache-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "regular-file");
  await writeFile(file, "retain");
  const remote = broker();
  const { store } = await open(remote, { file: join(file, "cache.json") });
  store.setTitle("Durable without cache");
  await store.flush();
  assert.equal(store.snapshot().persistence.phase, "saved");
  assert.match(store.snapshot().persistence.cacheError, /cache/);
  assert.equal((await open(remote)).store.snapshot().issue.title, "Durable without cache");
  assert.equal(await readFile(file, "utf8"), "retain");
});

test("explicit readiness is offline and bootstrap readiness never accesses visitor storage", async () => {
  let calls = 0;
  const explicit = await createHostedStorage({
    readiness: true, persistenceFetch() { calls++; throw new Error("No network"); },
  });
  assert.equal(explicit.readiness, true);
  assert.equal(calls, 0);
  const remote = broker();
  remote.readiness();
  const discovered = await createHostedStorage(remote.config());
  assert.equal(discovered.readiness, true);
  assert.deepEqual(remote.calls.map(({ key }) => key), ["bootstrap"]);
  const store = await createIssueStore({ trace: quietTrace, config: { readiness: true } });
  assert.equal(store.snapshot().persistence.phase, "readiness");
  assert.throws(() => store.setTitle("Must not save"), { code: "READINESS_ONLY" });
  await assert.rejects(store.retryPersistence(), { code: "READINESS_ONLY" });
});

test("application readiness serves health/state without network or cache writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosted-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "original.json");
  await writeFile(file, "{this file must not be read}");
  t.mock.method(globalThis, "fetch", () => { throw new Error("Readiness must remain offline"); });
  const app = await createApplication({
    ...configuration({ WORKSHOP_RUNTIME: "hosted", WORKSHOP_READINESS: "1",
      WORKSHOP_BROKER_URL: "https://offline-broker.invalid", WORKSHOP_RUN_TOKEN: "readiness-only" }),
    stateFile: file, exportsDirectory: join(root, "exports"),
  });
  assert.equal((await app.app.request("/healthz")).status, 200);
  assert.equal((await (await app.app.request("/api/state")).json()).persistence.phase, "readiness");
  assert.equal((await app.app.request("/api/persistence/retry", { method: "POST" })).status, 403);
  await app.close();
  assert.equal(await readFile(file, "utf8"), "{this file must not be read}");
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test("native bootstrap readiness without WORKSHOP_READINESS makes only the free bootstrap read", async (t) => {
  const remote = broker();
  remote.readiness();
  t.mock.method(globalThis, "fetch", remote.fetch);
  const app = await createApplication({
    ...configuration({ WORKSHOP_RUNTIME: "hosted",
      WORKSHOP_BROKER_URL: "https://offline-broker.invalid", WORKSHOP_RUN_TOKEN: "readiness" }),
    persistenceFetch: remote.fetch,
  });
  assert.equal(app.config.readiness, true);
  assert.equal((await app.app.request("/healthz")).status, 200);
  assert.equal(app.store.snapshot().persistence.phase, "readiness");
  await app.close();
  assert.deepEqual(remote.calls.map(({ key }) => key), ["bootstrap"]);
});

test("678 streaming progress notifications make no storage writes and terminal briefing flushes once", async () => {
  const remote = broker();
  const { store } = await open(remote);
  const job = store.startBriefing({ prompt: "Find agent harness sources" });
  await store.flush();
  const before = remote.calls.filter(({ method }) => method === "PUT").length;
  for (let index = 0; index < 678; index++) {
    store.updateJob(job.id, {
      status: "researching", phase: "model", turn: index % 10,
      partialText: `Streaming answer ${index}`,
      budget: { reservedUsd: 0.05 }, operationIds: [`operation-${index}`],
    });
    await Promise.resolve();
  }
  await store.flush();
  assert.equal(remote.calls.filter(({ method }) => method === "PUT").length, before);
  assert.equal(store.snapshot().briefings[0].partialText, "Streaming answer 677");
  const persisted = remote.object("visitor-a", EDITOR_KEY).value.state;
  assert.deepEqual(persisted.jobs, []);
  assert.equal(persisted.briefings[0].partialText, "");
  store.updateJob(job.id, { status: "completed", phase: "completed", answer: "The final briefing." });
  assert.equal(store.snapshot().persistence.phase, "saving");
  await store.flush();
  assert.equal(remote.calls.filter(({ method }) => method === "PUT").length, before + 3);
  assert.equal((await open(remote)).store.snapshot().briefings[0].answer, "The final briefing.");
  assert.equal(remote.objects.size, 2);
});

test("pending and in-flight writes cannot report saved, and explicit flush bypasses debounce", async () => {
  const remote = broker();
  const config = remote.config();
  let release, began, hold = true;
  const started = new Promise((resolve) => { began = resolve; });
  config.persistenceFetch = async (url, init) => {
    if (hold && init.method === "PUT" && String(url).endsWith(EDITOR_KEY)) {
      hold = false;
      began();
      await new Promise((resolve) => { release = resolve; });
    }
    return remote.fetch(url, init);
  };
  const persistence = await createHostedStorage(config);
  const store = await createIssueStore({ config, persistence, restored: await persistence.load() });
  store.setTitle("A");
  assert.equal(store.snapshot().persistence.phase, "pending");
  const saving = store.flush();
  await started;
  assert.equal(store.snapshot().persistence.phase, "saving");
  assert.equal(store.snapshot().persistence.acknowledgedRevision, null);
  store.setTitle("B");
  assert.equal(store.snapshot().persistence.phase, "saving");
  release();
  await saving;
  assert.equal(store.snapshot().persistence.phase, "saved");
  assert.equal(remote.object("visitor-a", EDITOR_KEY).value.state.issue.title, "B");
});

test("HTTP save failure carries safe storage status; reads/export remain usable and retry clears it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosted-http-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = broker();
  t.mock.method(globalThis, "fetch", remote.fetch);
  // Trace captures native fetch at module initialization. Intercept its free
  // gateway bootstrap too, with all actual network connections disabled.
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  dispatcher.get("https://offline-broker.invalid").intercept({ path: "/v1/bootstrap" }).reply(200, {
    inference: { selection: { modelId: "openai/gpt-6-luna", profileId: "luna-auto" } },
  }).persist();
  setGlobalDispatcher(dispatcher);
  t.after(async () => { setGlobalDispatcher(previousDispatcher); await dispatcher.close(); });
  const app = await createApplication({
    ...remote.config(), stateFile: join(root, "cache.json"), exportsDirectory: join(root, "exports"),
  });
  t.after(() => app.close().catch(() => {}));
  await app.gateway.ready();
  await app.store.flush();
  remote.fail(({ after }) => !after);
  const response = await app.app.request("/api/mcp/tools/set_stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ arguments: { stage: "editor" } }),
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, "STORAGE_QUOTA");
  assert.equal(typeof body.error, "string");
  assert.equal(body.persistence.phase, "failed");
  assert.equal((await app.app.request("/api/state")).status, 200);
  const slot = app.store.reserveStory();
  app.store.editStory(slot.slotId, { headline: "Pending copy", body: "Export this manual edit." });
  const exported = await app.app.request("/api/mcp/tools/export_newspaper", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ arguments: { format: "html" } }),
  });
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).isError, undefined);
  remote.fail(null);
  const retried = await app.app.request("/api/persistence/retry", { method: "POST" });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).persistence.phase, "saved");
  await app.close();
  const next = await createApplication({
    ...remote.config(), stateFile: join(root, "different-cache.json"), exportsDirectory: join(root, "exports"),
  });
  await next.gateway.ready();
  assert.equal(next.store.snapshot().settings.stage, "editor");
  assert.equal(next.store.snapshot().issue.id, app.store.snapshot().issue.id);
  assert.equal(next.gateway.budget.accountingAvailable, true);
  await next.close();
});
