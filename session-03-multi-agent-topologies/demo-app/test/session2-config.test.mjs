import assert from "node:assert/strict";
import test from "node:test";
import { configuration } from "../src/config.mjs";

test("hosted visits listen on the sandbox network; local modes stay on loopback", () => {
  const hosted = configuration({ WORKSHOP_RUNTIME: "hosted", PORT: "8080" });
  assert.equal(hosted.host, "0.0.0.0");
  assert.equal(hosted.port, 8080);
  assert.equal(configuration({}).host, "127.0.0.1");
  assert.equal(configuration({ WORKSHOP_DEVELOPMENT_TOKEN: "test" }).host, "127.0.0.1");
  assert.equal(configuration({ OPENROUTER_API_KEY: "test" }).host, "127.0.0.1");
  assert.equal(configuration({ HOST: "192.0.2.1" }).host, "192.0.2.1");
});

test("hosted diagnostics use the application workspace with headroom for accounting", () => {
  const hosted = configuration({ WORKSHOP_RUNTIME: "hosted", WORKSHOP_WORKDIR: "/work" });
  assert.equal(hosted.stateFile, "/work/session-02-editor-view/issue.json");
  assert.equal(hosted.exportsDirectory, "/work/session-02-editor-view/exports");
  assert.equal(hosted.executionArchive.maximumArchiveBytes, 96 * 1024 * 1024);
  assert.equal(hosted.executionArchive.maximumPendingBytes, 16 * 1024 * 1024);
  assert.equal(hosted.executionArchive.minimumFreeBytes, 32 * 1024 * 1024);
  assert.equal(hosted.executionArchive.rollingRetention, true);
  assert.equal(configuration({ WORKSHOP_RUNTIME: "hosted" }).stateFile, hosted.stateFile);
  assert.equal(configuration({ WORKSHOP_RUNTIME: "hosted", WORKSHOP_WORKDIR: "/custom-work" }).stateFile,
    "/custom-work/session-02-editor-view/issue.json");
  assert.equal(configuration({}).stateFile, ".local/editor-state.json");
  assert.equal(configuration({ SESSION2_STATE_FILE: "/isolated/issue.json" }).stateFile, "/isolated/issue.json");
});
