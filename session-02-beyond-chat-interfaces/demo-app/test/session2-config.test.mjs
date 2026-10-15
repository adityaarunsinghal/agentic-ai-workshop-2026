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
