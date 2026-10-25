import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.mjs";

const post = (app, name, args = {}) => app.request(`/api/mcp/tools/${name}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ arguments: args }),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("an execution read does not inherit a concurrent background save failure", async () => {
  const application = await createApplication({ mode: "fixture", fixture: true });
  const entered = deferred(), release = deferred();
  const original = application.mcp.callTool, flush = application.store.flush;
  let flushes = 0;
  application.mcp.callTool = async (...args) => {
    if (args[0] === "list_execution") { entered.resolve(); await release.promise; }
    return original(...args);
  };
  application.store.flush = async () => {
    flushes++;
    throw Object.assign(new Error("An unrelated save is unavailable."), { code: "STORAGE_UNAVAILABLE" });
  };
  try {
    const reading = post(application.app, "list_execution");
    await entered.promise;
    application.store.setTitle("A concurrent edit stays in memory");
    release.resolve();
    const response = await reading;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).isError, undefined);
    assert.equal(flushes, 0);
    assert.equal(application.store.snapshot().issue.title, "A concurrent edit stays in memory");
  } finally {
    release.resolve();
    application.store.flush = flush;
    await application.close();
  }
});

test("a mutating tool still reports its failed covering save without losing its edit", async () => {
  const application = await createApplication({ mode: "fixture", fixture: true });
  const flush = application.store.flush;
  try {
    await application.mcp.callTool("set_stage", { stage: "editor" });
    application.store.flush = async () => {
      throw Object.assign(new Error("The edit is retained but not acknowledged."), { code: "STORAGE_UNAVAILABLE" });
    };
    const response = await post(application.app, "set_title", { title: "Retained pending title" });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "STORAGE_UNAVAILABLE");
    assert.equal(application.store.snapshot().issue.title, "Retained pending title");
  } finally {
    application.store.flush = flush;
    await application.close();
  }
});
