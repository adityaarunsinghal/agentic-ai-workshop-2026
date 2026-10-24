import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createApplication } from "../src/server.mjs";
import { createAutoResearch } from "../src/auto-research.mjs";
import { createIssueStore } from "../src/domain/store.mjs";
import { createTrace } from "../src/trace.mjs";
import { createGateway } from "../src/agent/gateway.mjs";
import { fixtureAutoResearch } from "../src/agent/auto-research-fixture.mjs";
import { sseResponse } from "../src/agent/fixture.mjs";
import { fixtureSources } from "../src/sources/fixtures.mjs";
import { createMcpServer } from "../src/mcp/server.mjs";
import { connectMcp } from "../src/mcp/client.mjs";

// Every provider/source in this file is explicitly synthetic. The ordinary
// application, Pi stream parser, MCP authority, store, archive and save path run.
const original = {
  headline: "A synthetic comparison",
  body: "A fictional editor compared two toy workflows and recorded their results. " +
    "The synthetic experiment proves these workflows are better than every real product on the market.",
};
const config = { mode: "fixture", fixture: true, maxTurns: 10 };
const inputOf = (messages) => {
  const content = messages.findLast((message) => message.role === "user").content;
  return JSON.parse(typeof content === "string" ? content :
    content.filter((part) => part.type === "text").map((part) => part.text).join(""));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function pauseAt(task, occurrence = 1) {
  return { task, remaining: occurrence, entered: deferred(), release: deferred() };
}
function observeGateway(gateway, pause) {
  const requests = [], complete = gateway.completeText.bind(gateway);
  gateway.completeText = async (args) => {
    const input = inputOf(args.messages);
    requests.push({ input, signal: args.signal });
    const response = await complete(args);
    // A real, parsed fixture response is held here deliberately, even after
    // abort. The runner must reject a late result rather than trust the adapter.
    if (pause?.task === input.task && --pause.remaining === 0) {
      pause.entered.resolve({ input, signal: args.signal });
      await pause.release.promise;
    }
    return response;
  };
  return requests;
}
function seed(store) {
  store.setStage("research");
  const slot = store.reserveStory();
  store.editStory(slot.slotId, original);
  return store.getStory(slot.slotId);
}
async function appFixture(t, { pause, saved, maxTurns = 10, fixtureChat } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "session2-auto-research-"));
  const stateFile = join(directory, "issue.json");
  if (saved) await writeFile(stateFile, saved);
  const application = await createApplication({
    ...config, maxTurns, fixtureChat, stateFile, exportsDirectory: join(directory, "exports"),
  });
  t.after(async () => {
    pause?.release.resolve();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  const requests = observeGateway(application.gateway, pause);
  const story = saved ? application.store.snapshot().issue.stories[0] : seed(application.store);
  const tool = async (name, args = {}) => {
    const response = await application.mcp.callTool(name, args);
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    return response.structuredContent;
  };
  return { ...application, requests, story, stateFile, tool,
    start: () => tool("request_auto_research", {
      slotId: story.slotId, contentVersion: application.store.getStory(story.slotId).contentVersion,
    }),
  };
}
async function reachedPause(app, pause) {
  return Promise.race([
    pause.entered.promise,
    app.autoResearch.waitForIdle().then(() => {
      throw new Error(`Run finished before ${pause.task}: ${JSON.stringify(app.store.snapshot().autoResearchRuns)}`);
    }),
  ]);
}
const runOf = (app, id) => app.store.snapshot().autoResearchRuns.find((run) => run.id === id);
const events = (app, kind) => app.trace.entries.filter((entry) => entry.kind === `auto_research.${kind}`);
const fixtureReply = (transform) => ({ payload }) => {
  const input = inputOf(payload.messages), output = fixtureAutoResearch(input);
  const result = transform(input, output) ?? output;
  return sseResponse({ content: typeof result === "string" ? result : JSON.stringify(result) }, "stop", payload.model);
};

test("a late evaluation cannot overwrite a manual edit or obtain writer/app tool authority",
  { timeout: 10000 }, async (t) => {
    const pause = pauseAt("auto_research_evaluate");
    const app = await appFixture(t, { pause });
    const { runId, executionId } = await app.start();
    const held = await reachedPause(app, pause);
    assert.deepEqual(app.store.getStory(app.story.slotId), app.story, "Trials stay out of the editor.");
    const state = app.store.snapshot();
    const caller = { actor: "agent", jobId: runId };
    const available = (await app.mcp.listTools(caller)).map((tool) => tool.name);
    assert.ok(available.includes("search_web") && available.includes("fetch_read"));
    for (const name of ["write_story", "edit_story", "request_auto_research", "set_stage", "new_newspaper"]) {
      assert.equal(available.includes(name), false, name);
      const denied = await app.mcp.callTool(name, { actor: "app", taskType: "story" }, caller);
      assert.equal(denied.isError, true, name);
      assert.equal(denied.structuredContent.code, "TOOL_AUTHORITY", name);
    }
    app.store.editStory(app.story.slotId, { body: "The human's newer copy stays authoritative." });
    const edited = app.store.getStory(app.story.slotId);
    assert.equal(held.signal.aborted, true);
    // Exercise the store's independent synchronous CAS, not only subscription cancellation.
    assert.throws(() => app.store.applyResearchRevision({
      runId, slotId: app.story.slotId, storyId: app.story.id, issueId: state.issue.id,
      documentVersion: state.documentVersion, contentVersion: app.story.contentVersion,
      expectedRequestId: app.story.requestId, ...held.input.candidate,
    }), { code: "SUPERSEDED" });
    pause.release.resolve();
    await app.autoResearch.waitForIdle();
    assert.deepEqual(app.store.getStory(app.story.slotId), edited);
    assert.equal(runOf(app, runId).status, "superseded");
    assert.equal(events(app, "keep").length, 0);
    assert.equal(events(app, "stop")[0].parentId, executionId);
    assert.equal(events(app, "stop")[0].taskId, runId);
    assert.equal((await app.mcp.listTools(caller)).length, 0, "Finished runs lose research authority.");
  });

test("Stop, a stage change and a new newspaper reject an already computed late evaluation",
  { timeout: 20000 }, async (t) => {
    for (const action of ["stop", "stage", "reset"]) await t.test(action, async (t) => {
      const pause = pauseAt("auto_research_evaluate");
      const app = await appFixture(t, { pause });
      const { runId } = await app.start();
      const held = await reachedPause(app, pause);
      const before = app.store.snapshot();
      const aborted = held.signal.aborted ? Promise.resolve() :
        new Promise((resolve) => held.signal.addEventListener("abort", resolve, { once: true }));
      const mutation = action === "stop"
        ? app.tool("cancel_auto_research", { runId })
        : action === "stage" ? app.tool("set_stage", { stage: "tools" }) : app.tool("new_newspaper");
      await aborted;
      pause.release.resolve();
      await mutation;
      await app.autoResearch.waitForIdle();
      await app.store.flush();
      const after = app.store.snapshot();
      assert.equal(events(app, "keep").length, 0);
      assert.equal(app.requests.length, 3, "No new model request may follow cancellation.");
      if (action === "reset") {
        assert.deepEqual(after.issue.stories, []);
        assert.deepEqual(after.issue.sources, []);
        assert.deepEqual(after.autoResearchRuns, []);
        assert.equal(after.documentVersion, before.documentVersion + 1);
      } else {
        assert.deepEqual(after.issue.stories, before.issue.stories);
        assert.equal(runOf(app, runId).status, "stopped");
        assert.equal(after.settings.stage, action === "stage" ? "tools" : "research");
      }
      if (action !== "stop")
        assert.equal(app.trace.summary().totalRecords, 0, "Old completion cannot repopulate a cleared archive.");
      const saved = JSON.parse(await readFile(app.stateFile, "utf8"));
      assert.deepEqual(saved.issue.stories, after.issue.stories);
    });
  });

test("a rejected trial preserves exact current copy and retains the trial and reason in Execution",
  { timeout: 10000 }, async (t) => {
    const app = await appFixture(t, {
      maxTurns: 3,
      fixtureChat({ payload }) {
        const input = inputOf(payload.messages);
        const output = fixtureAutoResearch(input);
        if (input.task === "auto_research_evaluate")
          output.candidate.goals[0] = { ...output.candidate.goals[0], met: false,
            reason: "This scripted judge reports that the concrete comparison was lost." };
        return sseResponse({ content: JSON.stringify(output) }, "stop", payload.model);
      },
    });
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    await app.store.flush();
    const run = runOf(app, runId);
    assert.equal(run.status, "completed", run.stopReason);
    assert.equal(run.kept, 0);
    assert.equal(run.reverted, 1);
    assert.deepEqual(app.store.getStory(app.story.slotId), app.story);
    assert.deepEqual(JSON.parse(await readFile(app.stateFile, "utf8")).issue.stories, [app.story]);
    const rejected = events(app, "revert")[0];
    assert.match(rejected.reason, /reader goal.*lost/i);
    assert.notEqual(rejected.candidate.body, app.story.body);
    assert.equal(rejected.before.body, app.story.body);
    assert.equal(rejected.taskId, runId);
    assert.equal(app.requests.length, 3);
  });

test("kept copy is durable before the next round; restarting interrupts without automatic research",
  { timeout: 15000 }, async (t) => {
    const pause = pauseAt("auto_research_revision", 2);
    const app = await appFixture(t, { pause });
    const { runId } = await app.start();
    await reachedPause(app, pause);
    await app.store.flush();
    const kept = app.store.getStory(app.story.slotId);
    assert.notEqual(kept.body, app.story.body);
    assert.equal(kept.contentVersion, app.story.contentVersion + 1);
    assert.deepEqual(kept.frame, app.story.frame);
    assert.equal(events(app, "keep").length, 1);
    const checkpoint = await readFile(app.stateFile, "utf8");
    assert.deepEqual(JSON.parse(checkpoint).issue.stories[0], kept);
    // Copy the real durable checkpoint into an isolated process image. The
    // original harness is still paused, so this represents abrupt interruption.
    const restored = await appFixture(t, { saved: checkpoint });
    await restored.autoResearch.waitForIdle();
    await setImmediate();
    assert.deepEqual(restored.store.getStory(kept.slotId), kept);
    assert.equal(runOf(restored, runId).status, "interrupted");
    assert.match(runOf(restored, runId).stopReason, /explicitly|not restart/i);
    assert.equal(restored.requests.length, 0);
    assert.equal(restored.store.snapshot().jobs.length, 0);
    app.autoResearch.cancel(runId);
    pause.release.resolve();
    await app.autoResearch.waitForIdle();
    assert.deepEqual(app.store.getStory(kept.slotId), kept);
  });

test("maxTurns reserves a whole experiment/evaluation pair instead of starting an unjudgeable trial",
  { timeout: 10000 }, async (t) => {
    const app = await appFixture(t, { maxTurns: 2 });
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    const run = runOf(app, runId);
    assert.equal(run.status, "completed", run.stopReason);
    assert.match(run.stopReason, /model-request limit/);
    assert.deepEqual(app.requests.map(({ input }) => input.task), ["auto_research_audit"]);
    assert.equal(events(app, "research").length, 0);
    assert.equal(events(app, "experiment").length, 0);
    assert.deepEqual(app.store.getStory(app.story.slotId), app.story);
  });

test("fresh source discoveries cannot exceed three rounds, eighteen reads or bounded evidence",
  { timeout: 15000 }, async (t) => {
    const trace = createTrace(), store = await createIssueStore({ trace, config });
    const calls = [];
    let searches = 0;
    const remember = (records) => {
      store.addSources(records);
      return { records, losses: [], fixture: true };
    };
    const sources = {
      async searchWeb(args, context) {
        context.signal.throwIfAborted();
        calls.push({ name: "search_web", args, jobId: context.jobId });
        const batch = ++searches;
        return remember(Array.from({ length: args.limit }, (_, i) => ({
          id: `search-${batch}-${i}`, title: "Synthetic search listing",
          url: `https://example.org/local-fixture/${batch}/${i}`,
          text: "An unread synthetic search snippet.", evidenceLevel: "search-snippet", origin: "fixture",
        })));
      },
      async fetchRead(args, context) {
        context.signal.throwIfAborted();
        calls.push({ name: "fetch_read", args, jobId: context.jobId });
        const index = calls.filter((call) => call.name === "fetch_read").length;
        const source = fixtureSources("fetchRead", {
          url: "https://example.org/session-02-fixture/tools", maxChars: args.maxChars, maxLinks: 0,
        }).records[0];
        return remember([
          { ...source, id: `read-${index}`, url: args.url, canonicalUrl: args.url, links: [] },
          { id: `index-${index}`, title: "Synthetic index, not evidence", url: `${args.url}/index`,
            text: "", evidenceLevel: "metadata", origin: "fixture",
            links: [{ url: `${args.url}/linked-article` }] },
        ]);
      },
    };
    const gateway = createGateway({ trace, config: {
      ...config,
      fixtureChat({ payload }) {
        const input = inputOf(payload.messages);
        const output = fixtureAutoResearch(input);
        if (input.task === "auto_research_evaluate")
          output.nextQueries = ["synthetic gap A", "synthetic gap B", "synthetic gap C"];
        return sseResponse({ content: JSON.stringify(output) }, "stop", payload.model);
      },
    } });
    const requests = observeGateway(gateway);
    const context = { store, trace, sources, gateway, config };
    const mcp = await connectMcp(createMcpServer(context), trace);
    const autoResearch = createAutoResearch({ store, trace, mcp, gateway, config });
    context.autoResearch = autoResearch;
    t.after(async () => { await autoResearch.close(); await mcp.close(); await trace.close(); });
    const story = seed(store);
    const result = await mcp.callTool("request_auto_research", {
      slotId: story.slotId, contentVersion: story.contentVersion,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    await autoResearch.waitForIdle();
    const run = store.snapshot().autoResearchRuns[0];
    assert.equal(run.status, "completed", run.stopReason);
    assert.equal(run.round, 3);
    assert.equal(run.kept, 1);
    assert.equal(run.reverted, 2);
    assert.equal(requests.length, 7);
    const reads = calls.filter((call) => call.name === "fetch_read");
    assert.equal(reads.length, 18, "Adversarially fresh links must hit the global read ceiling.");
    assert.equal(new Set(reads.map((call) => call.args.url)).size, reads.length);
    assert.ok(calls.length <= 36);
    assert.ok(calls.every((call) => call.jobId === run.id));
    assert.ok(calls.filter((call) => call.name === "search_web").every((call) => call.args.limit === 3));
    const revisions = requests.filter(({ input }) => input.task === "auto_research_revision");
    assert.equal(revisions.length, 3);
    assert.ok(revisions.every(({ input }) =>
      input.evidence.length <= 18 && input.evidence.every((source) =>
        source.text.length <= 5000 && source.evidenceLevel === "article-text")));
    assert.ok(revisions.at(-1).input.evidence.some((source) => source.id === "read-18"),
      "Later targeted evidence must reach the writer and judge, not be crowded out by the first round.");
    assert.equal(trace.entries.filter((entry) => entry.kind === "auto_research.stop")[0].sourceReads, 18);
  });

test("one format repair uses the same pair and budget; only the corrected grade reaches the next writer",
  { timeout: 10000 }, async (t) => {
    let evaluations = 0;
    const app = await appFixture(t, { maxTurns: 6, fixtureChat: fixtureReply((input, output) => {
      if (input.task !== "auto_research_evaluate") return;
      if (++evaluations === 1) output.baseline.claims[0].text = "The judge paraphrased absent text.";
      else if (input.formatFeedback) {
        for (const row of output.baseline.claims) {
          row.excerptId = input.storyExcerpts.baseline.find(({ text }) => text === row.text).id;
          delete row.text;
        }
      }
    }) });
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    const run = runOf(app, runId), judged = app.requests.filter(({ input }) => input.task === "auto_research_evaluate");
    assert.equal(run.status, "completed", run.stopReason);
    assert.equal(run.kept, 1);
    assert.equal(run.reverted, 1);
    assert.equal(run.invalidEvaluations, 1);
    assert.equal(app.requests.length, 6);
    const { formatFeedback, ...repeated } = judged[1].input;
    assert.deepEqual(repeated, judged[0].input);
    assert.equal(formatFeedback.issues[0].path, "baseline.claims.c1.text");
    const nextWriter = app.requests.filter(({ input }) => input.task === "auto_research_revision")[1].input;
    assert.equal(nextWriter.priorEvaluation.baseline.claims[0].text, original.body.split(". ")[0] + ".");
    assert.equal(Object.hasOwn(nextWriter.priorEvaluation, "formatFeedback"), false);
    const invalid = events(app, "evaluation_invalid")[0];
    assert.deepEqual(invalid.metrics, { baseline: null, candidate: null });
    assert.equal(invalid.retry, true);
    assert.equal(events(app, "revert").length, 1, "Only the subsequent valid, unchanged trial is a Revert.");
    assert.ok(events(app, "evaluate").filter((entry) => entry.status === "complete")
      .every((entry) => entry.result.baseline && entry.result.candidate), "Existing evaluation inspectors retain their shape.");
  });

test("unusable grades pause after one repair with no score, editorial revert or next writer",
  { timeout: 20000 }, async (t) => {
    for (const failure of ["excerpt", "citation", "json"]) await t.test(failure, async (t) => {
      const app = await appFixture(t, { fixtureChat: fixtureReply((input, output) => {
        if (input.task !== "auto_research_evaluate") return;
        if (failure === "json") return '{"baseline":';
        if (failure === "excerpt") output.baseline.claims[0].text = "The judge paraphrased absent text.";
        else output.candidate.claims[0].citations[0].quote = "An invented evidence quotation.";
      }) });
      const { runId } = await app.start();
      await app.autoResearch.waitForIdle();
      await app.store.flush();
      const run = runOf(app, runId);
      assert.equal(run.status, "paused", run.stopReason);
      assert.equal(run.lastDecision, undefined);
      assert.equal(run.resumable, true);
      assert.equal(run.completedRounds, 0);
      assert.equal(run.currentEvaluation, null);
      assert.equal(run.kept, 0);
      assert.equal(run.reverted, 0);
      assert.equal(run.invalidEvaluations, 2);
      assert.equal(app.requests.length, 4);
      assert.equal(events(app, "experiment").length, 1);
      assert.equal(events(app, "revert").length, 0);
      assert.equal(events(app, "keep").length, 0);
      assert.match(run.stopReason, /saved step are preserved.*Resume/u);
      assert.deepEqual(app.store.getStory(app.story.slotId), app.story);
      assert.deepEqual(JSON.parse(await readFile(app.stateFile, "utf8")).issue.stories, [app.story]);
    });
  });

test("format recovery cannot spend beyond the existing total request cap",
  { timeout: 15000 }, async (t) => {
    for (const maxTurns of [3, 10]) await t.test(String(maxTurns), async (t) => {
      const app = await appFixture(t, { maxTurns, fixtureChat: fixtureReply((input, output) => {
        if (input.task === "auto_research_evaluate" && !input.formatFeedback)
          output.baseline.claims[0].text = "Absent paraphrase.";
      }) });
      const { runId } = await app.start();
      await app.autoResearch.waitForIdle();
      const run = runOf(app, runId);
      assert.equal(app.requests.length, maxTurns);
      assert.equal(run.turn, maxTurns);
      if (maxTurns === 3) {
        assert.equal(run.status, "paused");
        assert.equal(run.resumable, false);
        assert.equal(events(app, "evaluation_invalid")[0].retry, false);
        assert.equal(run.reverted, 0);
      } else {
        assert.equal(run.status, "completed", run.stopReason);
        assert.equal(run.round, 3);
        assert.equal(run.kept, 1);
        assert.equal(run.reverted, 2);
        assert.equal(run.invalidEvaluations, 3);
      }
    });
  });

test("a late repaired grade respects Stop and human edits without further requests",
  { timeout: 15000 }, async (t) => {
    for (const action of ["stop", "edit"]) await t.test(action, async (t) => {
      const pause = pauseAt("auto_research_evaluate", 2);
      const app = await appFixture(t, { pause, fixtureChat: fixtureReply((input, output) => {
        if (input.task === "auto_research_evaluate" && !input.formatFeedback)
          output.baseline.claims[0].text = "Absent paraphrase.";
      }) });
      const { runId } = await app.start();
      const held = await reachedPause(app, pause);
      assert.equal(runOf(app, runId).currentEvaluation, null);
      assert.equal(runOf(app, runId).reverted, 0);
      assert.equal(runOf(app, runId).recovery.status, "repairing");
      assert.match(runOf(app, runId).summary, /Repairing the response format/);
      if (action === "edit") app.store.editStory(app.story.slotId, { body: "Preserve the human's complete new copy." });
      else app.autoResearch.cancel(runId);
      const preserved = app.store.getStory(app.story.slotId);
      assert.equal(held.signal.aborted, true);
      pause.release.resolve();
      await app.autoResearch.waitForIdle();
      assert.deepEqual(app.store.getStory(app.story.slotId), preserved);
      assert.equal(app.requests.length, 4);
      assert.equal(events(app, "keep").length, 0);
      assert.equal(events(app, "revert").length, 0);
      assert.equal(runOf(app, runId).status, action === "edit" ? "superseded" : "stopped");
    });
  });

test("exhausted evaluator recovery retains the complete earlier kept copy and its durable checkpoint",
  { timeout: 10000 }, async (t) => {
    let evaluations = 0;
    const app = await appFixture(t, { fixtureChat: fixtureReply((input, output) => {
      if (input.task === "auto_research_evaluate" && ++evaluations > 1)
        output.candidate.claims[0].text = "Absent paraphrase.";
    }) });
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    await app.store.flush();
    const run = runOf(app, runId), kept = app.store.getStory(app.story.slotId);
    assert.equal(run.status, "paused");
    assert.equal(run.kept, 1);
    assert.equal(run.reverted, 0);
    assert.equal(run.completedRounds, 1);
    assert.deepEqual(run.currentEvaluation, events(app, "keep")[0].metrics.candidate);
    assert.equal(run.lastDecision.decision, "keep");
    assert.match(run.summary, /1 completed round.*Round 2 is incomplete/);
    assert.equal(app.requests.length, 6);
    assert.notEqual(kept.body, app.story.body);
    assert.deepEqual({ headline: kept.headline, body: kept.body, sourceIds: kept.sourceIds },
      events(app, "keep")[0].after);
    assert.equal(kept.contentVersion, app.story.contentVersion + 1);
    assert.deepEqual(kept.frame, app.story.frame);
    assert.deepEqual(JSON.parse(await readFile(app.stateFile, "utf8")).issue.stories, [kept]);
  });

test("provider failures do not trigger evaluator retries; context limits retain their distinct error",
  { timeout: 15000 }, async (t) => {
    for (const code of ["HTTP_503", "CONTEXT_LIMIT"]) await t.test(code, async (t) => {
      const app = await appFixture(t);
      const complete = app.gateway.completeText.bind(app.gateway);
      let calls = 0;
      app.gateway.completeText = async (args) => {
        calls++;
        if (inputOf(args.messages).task === "auto_research_evaluate")
          throw Object.assign(new Error("Synthetic request refusal."), { code });
        return complete(args);
      };
      const { runId } = await app.start();
      await app.autoResearch.waitForIdle();
      const run = runOf(app, runId);
      assert.equal(run.status, code === "CONTEXT_LIMIT" ? "failed" : "stopped");
      assert.equal(run.error.code, code);
      assert.equal(calls, 3);
      assert.equal(run.reverted, 0);
      assert.equal(run.kept, 0);
      assert.equal(events(app, "evaluation_invalid").length, 0);
      assert.match(run.stopReason, /Synthetic request refusal.*copy is preserved/u);
      assert.deepEqual(app.store.getStory(app.story.slotId), app.story);
    });
  });

test("failed searches and reads retain successful sibling evidence without retrying failed sources",
  { timeout: 10000 }, async (t) => {
    const app = await appFixture(t, { maxTurns: 3 });
    const callTool = app.mcp.callTool.bind(app.mcp), fetched = [];
    let searches = 0;
    app.mcp.callTool = async (name, args, caller) => {
      if (name === "search_web") {
        if (++searches === 1) throw Object.assign(new Error("Synthetic search unavailable."), { code: "HTTP_503" });
        return { structuredContent: { records: ["failed", "broken", "good"].map((id) => ({
          id, url: `https://example.org/${id}`,
        })), losses: [] } };
      }
      if (name === "fetch_read") {
        fetched.push(args.url);
        if (args.url.endsWith("/failed")) throw new Error("Synthetic read unavailable.");
        if (args.url.endsWith("/broken")) return { structuredContent: { records: null } };
        const batch = fixtureSources("fetchRead", {
          url: "https://example.org/session-02-fixture/tools", maxChars: 8000, maxLinks: 0,
        });
        batch.records.push(...[{ status: "failed" }, { read: false }, { metadataOnly: true }]
          .map((patch, index) => ({ ...batch.records[0], ...patch, id: `unread-${index}`, links: [] })));
        app.store.addSources(batch.records);
        return { structuredContent: batch };
      }
      return callTool(name, args, caller);
    };
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    const run = runOf(app, runId);
    assert.equal(run.status, "completed", run.stopReason);
    assert.equal(run.kept, 1);
    assert.equal(events(app, "source_gap").length, 3);
    assert.equal(fetched.length, 3);
    assert.equal(new Set(fetched).size, 3);
    const evaluated = app.requests.find(({ input }) => input.task === "auto_research_evaluate").input;
    assert.equal(evaluated.evidence.length, 1);
    assert.equal(evaluated.evidence[0].evidenceLevel, "article-text");
  });

test("audit and candidate schema failures each use one format-only repair with unchanged inputs",
  { timeout: 15000 }, async (t) => {
    for (const task of ["auto_research_audit", "auto_research_revision"]) await t.test(task, async (t) => {
      let matching = 0;
      const app = await appFixture(t, { maxTurns: 4, fixtureChat: fixtureReply((input, output) => {
        if (input.task !== task || ++matching > 1) return;
        if (task === "auto_research_audit") output.goals = [];
        else output.sourceIds = ["unknown-source"];
      }) });
      const { runId } = await app.start();
      await app.autoResearch.waitForIdle();
      const run = runOf(app, runId);
      assert.equal(run.status, "completed", run.stopReason);
      assert.equal(run.kept, 1);
      assert.equal(run.turn, 4);
      assert.equal(events(app, "research").length, 1, "Format repair does not repeat source work.");
      assert.equal(events(app, "repair").length, 1);
      assert.equal(events(app, "format_recovered").length, 1);
      const [first, repair] = app.requests.filter(({ input }) => input.task === task);
      const { formatFeedback, ...sameInput } = repair.input;
      assert.deepEqual(sameInput, first.input);
      assert.ok(formatFeedback.response, "Repair receives the actual rejected output.");
      assert.ok(formatFeedback.operationId);
      const repairEvent = events(app, "repair")[0];
      assert.equal(repairEvent.sourceOperationId, formatFeedback.operationId);
      assert.equal(repairEvent.logicalStepId, `${runId}:${task === "auto_research_audit" ? "0:audit" : "1:experiment"}`);
      const rows = app.trace.list({ taskId: runId, view: "teaching", limit: 200 }).records;
      const originalRow = rows.find((row) => row.exchangeKind && row.operationId === repairEvent.sourceOperationId);
      const repairRow = rows.find((row) => row.exchangeKind && row.operationId === repairEvent.operationId);
      assert.ok(originalRow && repairRow, "Both actual model exchanges remain visible.");
      assert.equal(repairRow.jsonRecovery, true);
      assert.equal(repairRow.recoveryOfRecordId, originalRow.id);
      assert.equal(repairRow.logicalStepId, repairEvent.logicalStepId);
      assert.equal(app.store.getAutoResearchCheckpoint(runId), null, "Completed runs release the resumable working copy.");
    });
  });

test("a malformed response follows the same one-repair path, retaining its raw capture",
  { timeout: 10000 }, async (t) => {
    let revisions = 0;
    const broken = '{"headline":"A cut-off candidate","body":';
    const app = await appFixture(t, { maxTurns: 4, fixtureChat: fixtureReply((input) => {
      if (input.task === "auto_research_revision" && ++revisions === 1) return broken;
    }) });
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    assert.equal(runOf(app, runId).status, "completed");
    assert.equal(app.requests.length, 4);
    const repaired = app.requests.find(({ input }) => input.formatFeedback)?.input;
    assert.equal(repaired.formatFeedback.response, broken);
    assert.ok(app.trace.entries.some((entry) =>
      entry.kind === "model.response" && JSON.stringify(entry).includes("A cut-off candidate")));
    assert.equal(events(app, "format_invalid").length, 1);
  });

test("an exhausted candidate repair resumes after restart without redoing research or resetting limits",
  { timeout: 15000 }, async (t) => {
    const app = await appFixture(t, { maxTurns: 7, fixtureChat: fixtureReply((input, output) => {
      if (input.task === "auto_research_revision" && input.round === 2) output.sourceIds = ["not-read"];
    }) });
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    await app.store.flush();
    const paused = runOf(app, runId);
    assert.equal(paused.status, "paused", paused.stopReason);
    assert.equal(paused.completedRounds, 1);
    assert.equal(paused.kept, 1);
    assert.equal(paused.reverted, 0);
    assert.equal(paused.turn, 5);
    assert.equal(paused.resumable, true);
    assert.equal(paused.remainingRequests, 2);
    assert.equal(paused.phase, "experiment");
    assert.deepEqual(paused.currentEvaluation, events(app, "keep")[0].metrics.candidate);
    assert.deepEqual(await app.mcp.listTools({ actor: "agent", jobId: runId }), [],
      "Paused runs have no source-tool authority.");
    assert.equal(Object.hasOwn(app.store.snapshot(), "autoResearchCheckpoints"), false,
      "The editor state must not duplicate frozen evidence and failed responses.");
    const saved = await readFile(app.stateFile, "utf8");
    const checkpoint = JSON.parse(saved).autoResearchCheckpoints[runId];
    assert.equal(checkpoint.step.automaticRepairUsed, true);
    assert.equal(checkpoint.nextStep, "experiment");
    assert.equal(checkpoint.maxTurns, 7);
    assert.ok(checkpoint.evidence.length > 0);

    const restored = await appFixture(t, { saved, maxTurns: 10 });
    assert.equal(restored.requests.length, 0, "Restoring state does not dispatch inference.");
    const resumed = await restored.start();
    assert.equal(resumed.runId, runId);
    assert.equal(resumed.resumed, true);
    await restored.autoResearch.waitForIdle();
    const finished = runOf(restored, runId);
    assert.equal(finished.status, "completed", finished.stopReason);
    assert.equal(finished.turn, 7);
    assert.equal(finished.maxTurns, 7, "A new process must not enlarge the saved request allowance.");
    assert.equal(finished.completedRounds, 2);
    assert.equal(finished.kept, 1);
    assert.equal(finished.reverted, 1);
    assert.deepEqual(restored.requests.map(({ input }) => input.task),
      ["auto_research_revision", "auto_research_evaluate"]);
    assert.equal(events(restored, "research").length, 0);
    const before = app.requests.filter(({ input }) =>
      input.task === "auto_research_revision" && input.round === 2)[0].input;
    const { formatFeedback, ...resumedInput } = restored.requests[0].input;
    assert.deepEqual(resumedInput, before);
    assert.ok(formatFeedback.response);
    const stop = events(restored, "stop")[0];
    assert.equal(stop.sourceReads, checkpoint.reads);
    assert.equal(stop.toolCalls, checkpoint.tools);
    assert.equal(restored.store.getStory(app.story.slotId).body, app.store.getStory(app.story.slotId).body);
  });

test("explicit Resume retries only the saved evaluation once and never resets automatic repair",
  { timeout: 10000 }, async (t) => {
    const app = await appFixture(t, { fixtureChat: fixtureReply((input, output) => {
      if (input.task === "auto_research_evaluate") output.candidate.claims[0].citations[0].quote = "Invented citation.";
    }) });
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    const initial = app.store.getAutoResearchCheckpoint(runId);
    assert.equal(runOf(app, runId).turn, 4);
    const resumed = await app.start();
    assert.equal(resumed.runId, runId);
    await app.autoResearch.waitForIdle();
    const run = runOf(app, runId);
    assert.equal(run.status, "paused");
    assert.equal(run.turn, 5, "One explicit recovery attempt, without a fresh automatic retry pair.");
    assert.equal(run.reverted, 0);
    assert.equal(events(app, "research").length, 1);
    const latest = app.store.getAutoResearchCheckpoint(runId);
    assert.deepEqual(latest.candidate, initial.candidate);
    assert.deepEqual(latest.evidence, initial.evidence);
    assert.equal(latest.tools, initial.tools);
    assert.equal(latest.reads, initial.reads);
    app.store.editStory(app.story.slotId, { body: "A newly edited story is authoritative." });
    assert.equal(runOf(app, runId).resumable, false);
  });

test("Resume after visible or stage clearing keeps its budget and records new work in the current generation",
  { timeout: 15000 }, async (t) => {
    for (const clearing of ["visible", "stage"]) await t.test(clearing, async (t) => {
      let broken = true;
      const pause = pauseAt("auto_research_evaluate", 2);
      const app = await appFixture(t, { pause, maxTurns: 6, fixtureChat: fixtureReply((input, output) => {
        if (input.task !== "auto_research_evaluate") return;
        output.nextQueries = [];
        if (broken) output.candidate.claims[0].citations[0].quote = "Invented citation.";
      }) });
      const oldGeneration = app.trace.generation;
      const started = await app.start();
      await reachedPause(app, pause);
      if (clearing === "visible") {
        await app.tool("clear_execution");
        assert.equal(app.trace.list({ taskId: started.runId }).total, 0);
      }
      // In-flight completion must stay in its original generation even when
      // clearing happened while the response was awaiting validation.
      pause.release.resolve();
      await app.autoResearch.waitForIdle();
      assert.equal(runOf(app, started.runId).status, "paused");
      const checkpoint = app.store.getAutoResearchCheckpoint(started.runId);
      assert.equal(checkpoint.requests, 4);
      if (clearing === "stage") {
        await app.tool("set_stage", { stage: "tools" });
        await app.tool("set_stage", { stage: "research" });
      }
      const currentGeneration = app.trace.generation;
      assert.ok(currentGeneration > oldGeneration);
      assert.equal(app.trace.list({ taskId: started.runId }).total, 0,
        "Neither old spans nor their late completion may repopulate cleared logs.");
      const oldRoot = await app.trace.get(started.executionId);
      const oldRepair = events(app, "repair")[0];
      assert.equal(oldRoot.generation, oldGeneration);
      assert.equal(oldRepair.generation, oldGeneration);
      assert.equal(oldRepair.status, "incomplete");
      assert.equal(runOf(app, started.runId).resumable, true);

      broken = false;
      const resumed = await app.start();
      await app.autoResearch.waitForIdle();
      assert.equal(resumed.runId, started.runId, "Resume retains the logical run/job identity.");
      const run = runOf(app, resumed.runId);
      assert.equal(run.status, "completed", run.stopReason);
      assert.equal(run.maxTurns, 6);
      assert.equal(run.turn, checkpoint.requests + 1);
      const job = app.store.snapshot().jobs.find((item) => item.id === resumed.runId);
      assert.equal(job.maxTurns, 6);
      assert.equal(job.turn, 5);
      const rows = app.trace.list({ taskId: resumed.runId, view: "teaching", limit: 200 }).records;
      assert.ok(rows.some((row) => row.id === resumed.executionId));
      assert.ok(rows.every((row) => row.generation === currentGeneration));
      const exchanges = rows.filter((row) => row.exchangeKind);
      assert.equal(exchanges.length, 1, "The resumed model exchange is visible in the current log.");
      assert.equal(exchanges[0].jsonRecovery, true);
      assert.equal(exchanges[0].logicalStepId, `${resumed.runId}:1:evaluate`);
      assert.equal(rows.some((row) => row.kind === "auto_research.research"), false);
      const stopped = events(app, "stop").at(-1);
      assert.equal(stopped.sourceReads, checkpoint.reads);
      assert.equal(stopped.toolCalls, checkpoint.tools);
      assert.equal(stopped.generation, currentGeneration);
      assert.deepEqual(await app.trace.get(started.executionId), oldRoot, "The original root remains archived unchanged.");
      assert.deepEqual(await app.trace.get(oldRepair.id), oldRepair, "The original repair span remains archived unchanged.");
    });
  });

test("OUTPUT_LIMIT repairs the current step; it is not reported as context overflow",
  { timeout: 10000 }, async (t) => {
    const app = await appFixture(t, { maxTurns: 4 });
    const complete = app.gateway.completeText.bind(app.gateway);
    let attempts = 0;
    app.gateway.completeText = async (args) => {
      if (inputOf(args.messages).task === "auto_research_revision" && ++attempts === 1)
        throw Object.assign(new Error("The model stopped at its output limit."), {
          code: "OUTPUT_LIMIT", text: '{"headline":"Incomplete', stopReason: "length",
          rawStopReason: "length", operationId: "truncated-fixture", outputLimitReached: true, maxOutputTokens: 4096,
        });
      return complete(args);
    };
    const { runId } = await app.start();
    await app.autoResearch.waitForIdle();
    assert.equal(runOf(app, runId).status, "completed");
    const repair = app.requests.find(({ input }) => input.formatFeedback)?.input.formatFeedback;
    assert.equal(repair.code, "OUTPUT_LIMIT");
    assert.equal(repair.stopReason, "length");
    assert.equal(repair.outputLimitReached, true);
    assert.equal(repair.maxOutputTokens, 4096, "Observed metadata, not a new configured cap.");
    assert.equal(runOf(app, runId).turn, 4);
  });
