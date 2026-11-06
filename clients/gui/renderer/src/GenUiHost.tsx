import { useEffect, useRef } from "react";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import {
  GEN_UI_STATE_METHOD,
  GEN_UI_FOLLOW_UP_METHOD,
  GEN_UI_PRESENTATION_METHOD,
  genUiWidgetStateSchema,
  genUiFollowUpSchema,
} from "@areal/gen-ui/contract";
import { AppTransport } from "./McpAppHost.js";
import { currentEntry, type Owner, type Entry } from "./GenUiWorkspace.js";
export function GenUiHost({ owner, entry }: { owner: Owner; entry: Entry }) {
  const frame = useRef<HTMLIFrameElement>(null),
    bridgeRef = useRef<AppBridge | null>(null);
  const app = entry.app!;
  useEffect(() => {
    const target = frame.current?.contentWindow,
      command = owner.services.mcpApp;
    if (!target || !command) return;
    let active = true,
      sequence = 0;
    const transport = new AppTransport(target, target);
    transport.boundedRequests = true;
    const bridge = new AppBridge(
      null,
      { name: "AReaL Gen UI", version: "1" },
      { experimental: { "zcode/gen-ui": {} }, sandbox: { permissions: {} } },
      { hostContext: { ...app.hostContext, theme: entry.binding?.dark ? "dark" : "light" } },
    );
    bridgeRef.current = bridge;
    const current = () => {
      if (!active || entry.app !== app) throw Error("Generated page is stale");
      currentEntry(owner, entry);
    };
    const request = async (method: string, params: Record<string, unknown>) => {
      current();
      const reply = await command({
        operation: "request",
        token: app.token,
        request: { jsonrpc: "2.0", id: ++sequence, method, params },
      });
      current();
      if (reply.error) throw Error("Generated request failed");
      return reply.result ?? {};
    };
    bridge.setRequestHandler(
      GEN_UI_STATE_METHOD,
      { params: z.object({ state: genUiWidgetStateSchema }).strict() },
      async (params) => request(GEN_UI_STATE_METHOD, params),
    );
    bridge.setRequestHandler(
      GEN_UI_FOLLOW_UP_METHOD,
      { params: genUiFollowUpSchema },
      async (params) => {
        await request(GEN_UI_FOLLOW_UP_METHOD, params);
        await owner.confirm(entry, params.prompt);
        return {};
      },
    );
    bridge.setRequestHandler(
      GEN_UI_PRESENTATION_METHOD,
      {
        params: z
          .object({ hovered: z.boolean().optional(), escape: z.literal(true).optional() })
          .strict(),
      },
      async (params) => {
        await request(GEN_UI_PRESENTATION_METHOD, params);
        if (params.escape && entry.pending) {
          entry.pending.reject(Error("Cancelled"));
          entry.pending = undefined;
          owner.changed();
        }
        return {};
      },
    );
    bridge.onsandboxready = () => {
      void bridge.sendSandboxResourceReady({ html: app.frameHtml ?? "" });
    };
    bridge.onsizechange = ({ height }) => {
      if (active && Number.isFinite(height)) {
        entry.height = Math.max(120, Math.min(10000, Math.ceil(height!)));
        owner.changed();
      }
    };
    bridge.onerror = () => {
      if (active) {
        entry.error = "unavailable";
        owner.changed();
      }
    };
    const off = owner.services.onMcpAppEvent?.((event) => {
      if (!active || event.token !== app.token || !("method" in event.notification)) return;
      if (event.notification.method === "ui/notifications/closed") {
        entry.pending?.reject(Error("Generated answer closed"));
        entry.pending = undefined;
        entry.app = undefined;
        entry.phase = "closed";
        owner.changed();
      } else if (transport.initialized) {
        if (event.notification.method === "ui/notifications/host-context-changed")
          Object.assign(app.hostContext, event.notification.params);
        void transport.send(event.notification);
      }
    });
    void bridge
      .connect(transport)
      .then(() => {
        if (active && frame.current) frame.current.src = app.frameUrl;
      })
      .catch(() => {
        entry.error = "unavailable";
        owner.changed();
      });
    return () => {
      active = false;
      off?.();
      bridgeRef.current = null;
      void bridge.close();
    };
  }, [app.token, owner]);
  useEffect(() => {
    bridgeRef.current?.setHostContext({
      ...app.hostContext,
      theme: entry.binding?.dark ? "dark" : "light",
    });
  }, [entry.binding?.dark, app.hostContext]);
  return (
    <div
      aria-hidden={!entry.placement}
      inert={!entry.placement}
      data-gen-ui-token={app.token}
      data-gen-ui-thread={app.threadId}
      style={{
        position: "fixed",
        ...entry.placement,
        display: entry.placement ? "block" : "none",
        zIndex: 10,
        clipPath: entry.clip,
      }}
    >
      <iframe
        ref={frame}
        title={entry.title}
        sandbox={app.frameHtml === undefined ? "allow-scripts allow-same-origin" : "allow-scripts"}
        referrerPolicy="no-referrer"
        style={{ border: 0, width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
}
