// LEARNING: Start with createApplication to see the whole app assembled.
// Follow MCP calls into mcp/server.mjs and model work into agent/runtime.mjs.
import { resolve, dirname, extname, sep } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { configuration } from "./config.mjs";
import { createTrace } from "./trace.mjs";
import { createIssueStore } from "./domain/store.mjs";
import { createHostedStorage } from "./hosted-storage.mjs";
import { createEditorial } from "./editorial.mjs";
import { createExporter } from "./exporter.mjs";
import { connectMcp } from "./mcp/client.mjs";
import { createMcpServer } from "./mcp/server.mjs";
import { createSources } from "./sources/service.mjs";
import { createGateway } from "./agent/gateway.mjs";
import { createResearchAgent } from "./agent/runtime.mjs";
import { createAutoResearch } from "./auto-research.mjs";
import { createFactCheck } from "./fact-check.mjs";
import { createUiReload } from "./ui-reload.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserKinds = new Set([
  "mcp.resource",
  "mcp.app.initialize",
  "app.context",
  "app.message",
  "app.log",
  "app.open-link",
  "export.download",
]);

export async function createApplication(config = configuration()) {
  // MAIN BEHAVIOR: restore one newspaper, compose its services, expose the routes.
  const hostedStorage =
    config.mode === "hosted" ? await createHostedStorage(config) : null;
  if (hostedStorage?.readiness) {
    config = { ...config, readiness: true };
  }
  const persistence = hostedStorage?.readiness ? null : hostedStorage;
  const restored = persistence ? await persistence.load() : null;
  // Keep budget/Execution files within this runtime visit. Reusing a cache
  // path for another visitor or run must not restore someone else's ledger.
  const stateFile =
    !config.readiness && config.stateFile
      ? resolve(
          root,
          persistence
            ? `${config.stateFile}.hosted/${persistence.runId}/issue.json`
            : config.stateFile,
        )
      : undefined;
  const historyFile = stateFile ? `${stateFile}.execution.json` : undefined;
  let historyError = null;
  let history = historyFile
    ? await readFile(historyFile, "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === "ENOENT") {
            return null;
          }
          historyError =
            "The original Execution history could not be read. Its file has been preserved.";
          return null;
        })
    : null;
  if (
    history &&
    (history.schemaVersion !== "session2.execution.v1" ||
      !Array.isArray(history.entries))
  ) {
    historyError =
      "The original Execution history has an unsupported format. Its file has been preserved.";
    history = null;
  }
  const saved = persistence
    ? restored
    : stateFile
      ? await readFile(stateFile, "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === "ENOENT") {
              return null;
            }
            throw error;
          })
      : null;
  const issueId =
    saved?.issue?.id ?? (persistence ? null : history?.issueId) ?? randomUUID();
  if (history && history.issueId !== issueId) {
    historyError =
      "The original Execution history belongs to another issue and was not loaded.";
    history = null;
  }
  config = {
    ...config,
    issueId,
    inferenceLedgerFile: stateFile ? `${stateFile}.inference.json` : undefined,
    initialInferenceEntries: history?.entries ?? [],
    initialInferenceHistoryUnavailable: Boolean(historyError),
  };
  const trace = createTrace({
    ...config.executionArchive,
    secrets: [config.apiKey, config.token],
    scopeId: issueId,
    directory: stateFile ? `${stateFile}.execution` : undefined,
  });
  try {
    await trace.restore(history?.entries ?? []);
  } catch {
    historyError =
      "The original Execution history contains invalid records. Its file has been preserved.";
    config.initialInferenceHistoryUnavailable = true;
    config.initialInferenceEntries = [];
  }
  if (historyError) {
    trace.record("storage", {
      action: "execution_history_unavailable",
      error: historyError,
    });
  }
  const store = await createIssueStore({
    trace,
    config,
    file: stateFile,
    persistence,
    restored,
  });
  trace.setClearHandler(async () => {
    const current = store.snapshot();
    const terminal = new Set([
      "completed",
      "complete",
      "done",
      "incomplete",
      "failed",
      "error",
      "cancelled",
      "canceled",
      "stopped",
      "superseded",
      "interrupted",
    ]);
    const previous = Date.parse(current.executionClearedAt ?? "");
    const executionClearedAt = new Date(
      Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0),
    ).toISOString();
    store.updateActivity({
      executionClearedAt,
      jobs: current.jobs.filter((job) => {
        return !terminal.has(job.status);
      }),
      editorial: current.editorial?.status === "running" ? current.editorial : null,
      editorialHistory: (current.editorialHistory ?? []).filter((entry) => {
        return entry.status === "running";
      }),
    });
    await store.flush();
    if (
      stateFile &&
      !persistence &&
      JSON.parse(await readFile(stateFile, "utf8")).executionClearedAt !==
        executionClearedAt
    ) {
      throw new Error(
        "Execution was cleared, but its browser reset marker could not be persisted.",
      );
    }
    return store.snapshot();
  });
  if (
    !config.readiness &&
    (stateFile || persistence) &&
    !saved &&
    !store.snapshot().persistence.error
  ) {
    // Bind the empty issue before creating its funding journal. A restart
    // before the first user action must retain the same issue/archive scope.
    store.updateActivity({});
    await store.flush();
    const checkpoint = persistence
      ? store.snapshot()
      : JSON.parse(await readFile(stateFile, "utf8"));
    if (checkpoint.issue?.id !== issueId) {
      throw new Error("The new issue checkpoint could not be established.");
    }
  }
  const sources = createSources({ store, trace, config });
  const onSelection = config.onSelection;
  config.onSelection = (selection) => {
    store.applyInferenceSelection(selection);
    return onSelection?.(selection);
  };
  config.onInferenceActivity = (inferenceActivity) => {
    return store.updateActivity({ inferenceActivity });
  };
  const gateway = createGateway({ trace, config });
  delete config.initialInferenceEntries;
  trace.setBudgetSource(() => {
    return gateway.budget;
  });
  const editorial = createEditorial({ store, trace, gateway, config });
  const exporter = createExporter({
    store,
    trace,
    directory: resolve(root, config.exportsDirectory || ".local/exports"),
  });
  const context = { store, trace, sources, gateway, editorial, exporter, config };
  const server = createMcpServer(context);
  const mcp = await connectMcp(server, trace);
  config.onDraftComplete = ({
    slotId,
    parentId,
    reason,
    origin,
    layoutOperationId,
  } = {}) => {
    return trace.withContext({ actor: "editor", parentId }, () => {
      return editorial.reviewDraft({
        reason: reason || "New story fact-checking and placement",
        movedStoryId: slotId,
        origin,
        layoutOperationId,
      });
    });
  };
  const agent = createResearchAgent({ store, mcp, trace, gateway, config });
  context.agent = agent;
  const autoResearch = createAutoResearch({ store, mcp, trace, gateway, config });
  context.autoResearch = autoResearch;
  // Session 3: the same bounded machinery, with the fact-check arrangement made
  // selectable. A fact-check run reuses the auto-research run store and commit path.
  const factCheck = createFactCheck({ store, mcp, trace, gateway, config });
  context.factCheck = factCheck;
  if (!config.readiness && ["development", "hosted"].includes(config.mode)) {
    void gateway.ready().catch(() => {
      // Bootstrap is a free read. A later explicit action can try that read
      // again without changing the paid provider's single-attempt policy.
    });
  }
  const app = new Hono();
  const uiReload =
    config.uiHotReload && ["local", "development"].includes(config.mode)
      ? createUiReload({ root, script: "scripts/build.mjs" })
      : null;
  app.onError((error, c) => {
    const storageStatus = {
      STORAGE_CONFLICT: 409,
      STORAGE_QUOTA: 413,
      STORAGE_SESSION: 403,
      STORAGE_UNAVAILABLE: 503,
      STORAGE_RESPONSE: 503,
      READINESS_ONLY: 403,
    }[error.code];
    return c.json(
      {
        error: trace.safe(error.message),
        ...(storageStatus
          ? { code: error.code, persistence: store.snapshot().persistence }
          : {}),
      },
      storageStatus ?? 400,
    );
  });
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      const expected = new URL(c.req.url).origin;
      if (origin && origin !== expected) {
        return c.json({ error: "Use the host MCP bridge." }, 403);
      }
    }
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    const url = new URL(c.req.url);
    const alternate = `${url.protocol}//${url.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${url.port}`;
    c.header(
      "Content-Security-Policy",
      c.req.path === "/sandbox.html"
        ? "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data: blob:; frame-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'"
        : `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; frame-src 'self' ${alternate}; connect-src 'self'; object-src 'none'; base-uri 'self'`,
    );
  });
  app.get("/healthz", (c) => {
    return c.text("ok");
  });
  app.get("/api/state", (c) => {
    return c.json(store.snapshot());
  });
  app.post("/api/persistence/retry", async (c) => {
    return c.json(await store.retryPersistence());
  });
  app.post("/api/inference/recover", async (c) => {
    await gateway.recover();
    return c.json(store.snapshot());
  });
  app.post("/api/execution/clear", async (c) => {
    const state = await trace.clear();
    return c.json({ cleared: true, state, summary: trace.summary() });
  });
  app.get("/api/execution", (c) => {
    const view = c.req.query("view") || "teaching";
    const order = c.req.query("order") || "desc";
    if (!["teaching", "protocol"].includes(view)) {
      return c.json({ error: "Choose teaching or protocol records." }, 400);
    }
    if (!["asc", "desc"].includes(order)) {
      return c.json({ error: "Choose ascending or descending execution order." }, 400);
    }
    return c.json(
      trace.list({
        view,
        order,
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
        query: c.req.query("query"),
        taskId: c.req.query("taskId"),
      }),
    );
  });
  app.get("/api/execution/:id", async (c) => {
    const record = await (c.req.query("includeExchange") === "true"
      ? trace.getExchange(c.req.param("id"))
      : trace.get(c.req.param("id")));
    return record
      ? c.json({ record })
      : c.json(
          {
            error: "This execution record is unavailable in the current issue.",
          },
          404,
        );
  });
  app.post("/api/execution/browser", async (c) => {
    let event;
    try {
      event = await smallJson(c.req.raw);
    } catch {
      return c.json(
        { error: "Send one browser diagnostic record of at most 64 KiB." },
        400,
      );
    }
    if (
      !event ||
      !browserKinds.has(event.kind) ||
      typeof event.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(event.id)
    ) {
      return c.json(
        { error: "This browser diagnostic kind or identity is unsupported." },
        400,
      );
    }
    const clearedAt = Date.parse(store.snapshot().executionClearedAt ?? "");
    const startedAt = Date.parse(event.startedAt ?? "");
    if (
      Number.isFinite(clearedAt) &&
      (!Number.isFinite(startedAt) || startedAt <= clearedAt)
    ) {
      return c.json({
        ignored: true,
        cleared: true,
        executionClearedAt: new Date(clearedAt).toISOString(),
        record: null,
      });
    }
    // Browser observations cannot overwrite server records or supply authority.
    const id = `browser:${event.id}`;
    let record = trace.describe(id);
    if (!record) {
      trace.record(event.kind, {
        id,
        actor: "host",
        reportedBy: "browser",
        status: event.status === "failed" ? "failed" : "complete",
        ...(typeof event.parentId === "string" && event.parentId.length <= 128
          ? { parentId: event.parentId }
          : {}),
        ...(typeof event.startedAt === "string"
          ? { browserStartedAt: event.startedAt.slice(0, 80) }
          : {}),
        payload: event.payload ?? null,
        result: event.result ?? null,
      });
      record = trace.describe(id);
    }
    return c.json({ record });
  });
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let open = true,
        writing = Promise.resolve(),
        timer;
      const send = (state) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!open) {
            return;
          }
          writing = writing
            .then(() => {
              return stream.writeSSE({
                event: "state",
                data: JSON.stringify(state),
              });
            })
            .catch(() => {
              open = false;
            });
        }, 100);
      };
      const unsubscribe = store.subscribe(send);
      stream.onAbort(() => {
        open = false;
        clearTimeout(timer);
        unsubscribe();
      });
      await stream.writeSSE({ event: "state", data: JSON.stringify(store.snapshot()) });
      while (open) {
        await stream.sleep(1000);
        if (open) {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
        }
      }
    });
  });
  app.get("/api/mcp/tools", async (c) => {
    return c.json(await mcp.listTools());
  });
  app.post("/api/mcp/tools/:name", async (c) => {
    const body = await c.req.json();
    if (
      !config.readiness &&
      ["development", "hosted"].includes(config.mode) &&
      !gateway.model &&
      ["request_briefing", "request_story", "request_auto_research"].includes(
        c.req.param("name"),
      )
    ) {
      await gateway.ready();
    }
    const { result, changed } = await store.trackAction(() => {
      return mcp.callTool(c.req.param("name"), body.arguments || {}, { actor: "app" });
    });
    // Background research cannot make an observer read inherit a save failure.
    // Actual mutations still require their covering save acknowledgement.
    if (changed) {
      await store.flush();
    }
    return c.json(result);
  });
  app.get("/api/mcp/resource", async (c) => {
    const uri = c.req.query("uri") || "ui://session-02/editor-view.html";
    return c.json(await mcp.readResource(uri));
  });
  app.get("/api/artifacts/:id", async (c) => {
    const artifact = exporter.getArtifact(c.req.param("id"));
    if (!artifact) {
      return c.json({ error: "That download is no longer available." }, 404);
    }
    const request = trace.start("download", {
      actor: "app",
      url: c.req.path,
      purpose: artifact.filename,
    });
    const bytes = await readFile(artifact.path);
    request.finish({
      result: {
        filename: artifact.filename,
        bytes: bytes.length,
        sha256: artifact.sha256,
      },
    });
    return new Response(bytes, {
      headers: {
        "content-type": artifact.mimeType,
        "content-disposition": `attachment; filename="${artifact.filename}"`,
      },
    });
  });
  app.get("/api/sources", async (c) => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(resolve(root, "src"), { recursive: true }))
      .filter((name) => {
        return name.endsWith(".mjs");
      })
      .map((name) => {
        return `src/${name}`;
      });
    return c.json({ files });
  });
  app.get("/api/source", async (c) => {
    const name = c.req.query("path") || "";
    if (!/^src\/[a-zA-Z0-9_./-]+\.mjs$/.test(name) || name.includes("..")) {
      return c.json({ error: "Choose a declared source module." }, 400);
    }
    return c.text(await readFile(resolve(root, name), "utf8"));
  });
  app.get("*", async (c) => {
    const reloadResponse = uiReload?.response(c.req.path);
    if (reloadResponse) {
      return new Response(reloadResponse.body, {
        headers: { "content-type": reloadResponse.type, "cache-control": "no-store" },
      });
    }
    const requested = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    const path = resolve(root, "dist", requested);
    if (
      !path.startsWith(`${resolve(root, "dist")}${sep}`) ||
      !(
        await stat(path).catch(() => {
          return null;
        })
      )?.isFile()
    ) {
      return c.text("Build the editor with npm run build.", 404);
    }
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      }[extname(path)] || "application/octet-stream";
    const body = await readFile(path);
    return new Response(
      requested === "index.html" && uiReload ? uiReload.inject(body) : body,
      {
        headers: {
          "content-type": type,
          ...(uiReload ? { "cache-control": "no-store" } : {}),
        },
      },
    );
  });
  return {
    app,
    store,
    trace,
    mcp,
    agent,
    autoResearch,
    factCheck,
    gateway,
    config,
    async close() {
      uiReload?.close();
      await autoResearch.close();
      await factCheck.close();
      await agent.close?.();
      try {
        await store.flush();
      } finally {
        await mcp.close();
        await trace.close();
      }
    },
  };
}

// Start the HTTP listener only when this file is run as the entry point.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const application = await createApplication();
  const server = serve(
    {
      fetch: application.app.fetch,
      port: application.config.port,
      hostname: application.config.host,
    },
    (info) => {
      console.info(
        `Session 3 multi-agent fact-checker: http://${application.config.host}:${info.port}`,
      );
      console.info(
        `Mode: ${application.config.mode}. Model credentials stay on the server.`,
      );
    },
  );
  const stop = async () => {
    await application.close();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

// SUPPORTING HELPERS: declarations stay in the same scope.

async function smallJson(request, maximum = 64 * 1024) {
  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("A diagnostic record is required.");
  }
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      bytes += item.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error("This diagnostic record is too large.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
