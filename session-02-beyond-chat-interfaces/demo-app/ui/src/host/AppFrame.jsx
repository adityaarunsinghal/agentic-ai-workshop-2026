// LEARNING: Start with AppFrame(): load the MCP resource and connect the host side of the App bridge.
// Next: ui/src/editor/useEditor.jsx for the editor side of that connection.

import React, { useEffect, useRef, useState } from "react";
import {
  AppBridge,
  buildAllowAttribute,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  appResource,
  readResource,
  sandboxUrl,
  snapshotNotification,
} from "./transport.mjs";
import { connectSandbox, HOSTED_SANDBOX_PATH } from "./frame-transport.mjs";
import { OpenExecutionNotification } from "../shared/host-actions.mjs";
import {
  RpcLifecycleTransport,
  transportError,
  transportFailure,
  transportLogParts,
} from "../shared/rpc-transport.mjs";

// LEARNING: MAIN BEHAVIOR
export function AppFrame({
  uri,
  initialTool,
  snapshot,
  callTool,
  openLink,
  onExecution,
  onRecord,
  onError,
  controllerRef,
}) {
  const iframeRef = useRef(null);
  const bridgeRef = useRef(null);
  const latest = useRef(null);
  latest.current = {
    initialTool,
    snapshot,
    callTool,
    openLink,
    onExecution,
    onRecord,
    onError,
  };
  const lastTool = useRef(null);
  const failureRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [frameProblem, setFrameProblem] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    const iframe = iframeRef.current;
    let bridge;
    let transport;
    let observer;
    let timeout;
    let disposed = false;
    let closing = false;
    let resourceParent = {};
    setReady(false);
    setFrameProblem(null);
    lastTool.current = null;
    const recordTransport = (diagnostic) => {
      for (const params of transportLogParts(diagnostic)) {
        latest.current.onRecord({
          id: crypto.randomUUID(),
          kind: "app.log",
          actor: "host",
          status: diagnostic.level === "error" ? "failed" : "complete",
          startedAt: new Date().toISOString(),
          ...resourceParent,
          payload: params,
        });
      }
    };
    const fail = (error) => {
      if (disposed) {
        return;
      }
      const diagnostic = transportFailure(error);
      recordTransport(diagnostic);
      setFrameProblem(diagnostic.message);
      latest.current.onError(diagnostic.message);
    };
    failureRef.current = fail;
    async function initialize() {
      const startedAt = new Date().toISOString();
      const resource = await readResource(uri, abort.signal);
      const { html, csp, permissions } = appResource(resource, uri);
      resourceParent =
        typeof resource._meta?.executionRecordId === "string"
          ? { parentId: resource._meta.executionRecordId }
          : {};
      latest.current.onRecord({
        id: crypto.randomUUID(),
        kind: "mcp.resource",
        actor: "host",
        status: "complete",
        startedAt,
        ...resourceParent,
        payload: { method: "resources/read", uri },
        result: {
          uri,
          bytes: new TextEncoder().encode(html).length,
          mimeType: "text/html;profile=mcp-app",
          csp,
          permissions,
        },
      });
      const sandbox = sandboxUrl(
        window.location.origin,
        import.meta.env.VITE_MCP_SANDBOX_ORIGIN,
      );
      const hosted =
        sandbox.pathname === HOSTED_SANDBOX_PATH &&
        sandbox.origin === window.location.origin;
      if (!hosted) {
        sandbox.searchParams.set("csp", JSON.stringify(csp));
      }
      const allow = buildAllowAttribute(permissions);
      if (allow) {
        iframe.setAttribute("allow", allow);
      }
      transport = new RpcLifecycleTransport(
        await connectSandbox(iframe, sandbox, abort.signal),
        {
          onDiagnostic: recordTransport,
        },
      );
      if (disposed) {
        await transport.close();
        return;
      }
      bridge = new AppBridge(
        null,
        { name: "Session 2 workshop host", version: "2.0.0" },
        {
          serverTools: {},
          serverResources: {},
          openLinks: {},
          updateModelContext: { text: {} },
          logging: {},
        },
        {
          hostContext: {
            theme: "light",
            platform: "web",
            locale: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            displayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
            containerDimensions: {
              width: iframe.clientWidth,
              height: iframe.clientHeight,
            },
          },
        },
      );
      // LEARNING: Register every host handler before the handshake; App calls cross this boundary.
      // All handlers are registered before the initialization handshake.
      bridge.setNotificationHandler(OpenExecutionNotification, ({ params }) => {
        setFullscreen(false);
        void bridge.sendHostContextChange({ displayMode: "inline" }).catch(() => {});
        latest.current.onExecution(params.recordId, params.taskId);
      });
      bridge.oncalltool = (params, extra) => {
        return latest.current.callTool(
          params.name,
          params.arguments ?? {},
          extra.signal,
        );
      };
      bridge.onreadresource = (params, extra) => {
        return readResource(params.uri, extra.signal);
      };
      bridge.onopenlink = (params) => {
        return latest.current.openLink(params.url);
      };
      bridge.onupdatemodelcontext = async (params) => {
        latest.current.onRecord({
          id: crypto.randomUUID(),
          kind: "app.context",
          actor: "app",
          status: "complete",
          startedAt: new Date().toISOString(),
          ...resourceParent,
          payload: params,
        });
        return {};
      };
      bridge.onmessage = async (params) => {
        latest.current.onRecord({
          id: crypto.randomUUID(),
          kind: "app.message",
          actor: "app",
          status: "complete",
          startedAt: new Date().toISOString(),
          ...resourceParent,
          payload: params,
        });
        return {};
      };
      bridge.onloggingmessage = (params) => {
        latest.current.onRecord({
          id: crypto.randomUUID(),
          kind: "app.log",
          actor: "app",
          status: params.level === "error" ? "failed" : "complete",
          startedAt: new Date().toISOString(),
          ...resourceParent,
          payload: params,
        });
        if (
          params.logger === "workshop.mcp.transport" &&
          params.level === "error" &&
          params.data?.part === 1
        ) {
          const diagnostic = transportFailure(
            transportError(params.data.code, params.data.message),
          );
          latest.current.onError(diagnostic.message);
        }
      };
      bridge.onerror = fail;
      bridge.onclose = () => {
        if (disposed || closing) {
          return;
        }
        bridgeRef.current = null;
        setReady(false);
        fail(
          transportError("MCP_CONNECTION_CLOSED", "The MCP frame connection closed."),
        );
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        const actual = mode === "fullscreen" ? "fullscreen" : "inline";
        setFullscreen(actual === "fullscreen");
        await bridge.sendHostContextChange({ displayMode: actual });
        return { mode: actual };
      };
      bridge.onsizechange = ({ height }) => {
        if (Number.isFinite(height)) {
          iframe.style.height = `${Math.min(1800, Math.max(580, height))}px`;
        }
      };
      const initialized = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          return reject(new Error("Interactive Editor View initialization timed out."));
        }, 20000);
        bridge.oninitialized = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      // If connect fails first, its cleanup still owns this deferred rejection.
      void initialized.catch(() => {});
      // LEARNING: Connect, deliver the resource, then wait for initialization before sending tool results.
      await bridge.connect(transport);
      await bridge.sendSandboxResourceReady({ html, csp, permissions });
      await initialized;
      if (disposed) {
        return;
      }
      bridgeRef.current = bridge;
      controllerRef.current = {
        // The host awaits this before changing teaching stages or replacing the
        // resource, giving the App a chance to persist debounced local changes.
        prepare: () => {
          return bridge.transport
            ? bridge.teardownResource({})
            : Promise.reject(
                new Error(
                  "The editor connection closed. Copy any unsaved text, then reload the page.",
                ),
              );
        },
      };
      observer = new ResizeObserver(([entry]) => {
        void bridge
          .sendHostContextChange({
            containerDimensions: {
              width: Math.round(entry.contentRect.width),
              height: Math.round(entry.contentRect.height),
            },
          })
          .catch(() => {});
      });
      observer.observe(iframe);
      latest.current.onRecord({
        id: crypto.randomUUID(),
        kind: "mcp.app.initialize",
        actor: "host",
        status: "complete",
        startedAt,
        ...resourceParent,
        payload: {
          uri,
          sandboxOrigin: hosted ? "null" : sandbox.origin,
          hostOrigin: window.location.origin,
          isolation: hosted ? "opaque-message-channel" : "separate-origin",
        },
        result: { protocol: "MCP Apps", app: bridge.getAppVersion?.() },
      });
      const tool = latest.current.initialTool;
      if (tool) {
        await bridge.sendToolInput({ arguments: tool.arguments });
        await bridge.sendToolResult(tool.result);
        lastTool.current = tool.id;
      }
      if (latest.current.snapshot) {
        await bridge.sendToolResult(snapshotNotification(latest.current.snapshot));
      }
      setReady(true);
    }
    initialize().catch((error) => {
      clearTimeout(timeout);
      closing = true;
      observer?.disconnect();
      void bridge?.close();
      void transport?.close();
      if (!disposed) {
        controllerRef.current = null;
        bridgeRef.current = null;
        setReady(false);
        if (error.name !== "AbortError") {
          fail(error);
        }
      }
    });
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timeout);
      observer?.disconnect();
      controllerRef.current = null;
      bridgeRef.current = null;
      if (failureRef.current === fail) {
        failureRef.current = null;
      }
      void bridge?.close();
      void transport?.close();
    };
  }, [uri]);

  // LEARNING: Once connected, observations reuse the bridge rather than reloading the App.
  useEffect(() => {
    if (ready && snapshot) {
      void bridgeRef.current
        ?.sendToolResult(snapshotNotification(snapshot))
        .catch((error) => {
          return failureRef.current?.(error);
        });
    }
  }, [ready, snapshot]);
  useEffect(() => {
    if (!ready || !initialTool || lastTool.current === initialTool.id) {
      return;
    }
    lastTool.current = initialTool.id;
    void (async () => {
      await bridgeRef.current.sendToolInput({ arguments: initialTool.arguments });
      await bridgeRef.current.sendToolResult(initialTool.result);
    })().catch((error) => {
      return failureRef.current?.(error);
    });
  }, [ready, initialTool]);

  return (
    <section
      className={`app-frame-wrap ${fullscreen ? "app-fullscreen" : ""}`}
      aria-label="Interactive Editor View MCP App"
    >
      {!ready && (
        <div className="app-frame-loading" role={frameProblem ? "alert" : "status"}>
          {frameProblem || "Opening Interactive Editor View…"}
        </div>
      )}
      {fullscreen && (
        <button
          type="button"
          className="quiet exit-fullscreen"
          onClick={() => {
            setFullscreen(false);
            void bridgeRef.current
              ?.sendHostContextChange({ displayMode: "inline" })
              .catch((error) => {
                return failureRef.current?.(error);
              });
          }}
        >
          Exit fullscreen
        </button>
      )}
      <iframe
        ref={iframeRef}
        title="Interactive Editor View · sandboxed MCP App"
        className="app-frame"
      />
    </section>
  );
}
