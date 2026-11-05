import type { HostClient } from "@areal/client";
import type { WorkbenchPageResourceResult } from "../../packages/remote-client/generated/host-protocol.js";
import type { McpAppEvent } from "./mcp-app-services.js";
import { createMcpAppCommand, readMcpAppEvent } from "./mcp-app-response.js";

type Client = Pick<HostClient, "workbench" | "snapshot" | "subscribe"> & {
  subscribePageEvents(listener: (event: unknown) => void): () => void;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** 资源只从原连接读取；浏览器仅把内容交给不具有同源权限的固定代理。 */
export function createHostPages(client: Client) {
  const listeners = new Set<(event: McpAppEvent) => void>();
  const tokens = new Set<string>();
  let disposed = false;
  const identity = () => {
    const state = client.snapshot();
    if (state.connection !== "ready") return undefined;
    return `${state.identity.connectionId}:${state.identity.gatewayGeneration}`;
  };
  let owner = identity();
  const emit = (event: McpAppEvent) => {
    for (const listener of listeners) listener(event);
  };
  const revoke = () => {
    for (const token of tokens)
      emit({ token, notification: { jsonrpc: "2.0", method: "ui/notifications/closed" } });
    tokens.clear();
  };
  const offState = client.subscribe(() => {
    const next = identity();
    if (next !== owner) revoke();
    owner = next;
  });
  const offEvents = client.subscribePageEvents((value) => {
    try {
      const event = readMcpAppEvent(value);
      if (!disposed && tokens.has(event.token)) {
        emit(event);
        if (
          "method" in event.notification &&
          event.notification.method === "ui/notifications/closed"
        )
          tokens.delete(event.token);
      }
    } catch {
      revoke();
    }
  });
  const current = (expected: string | undefined) => {
    if (disposed || !expected || identity() !== expected) throw Error("Page owner disconnected");
  };
  async function resource(token: string, path: string, expected: string) {
    const parts: Uint8Array[] = [];
    let offset = 0,
      total: number | undefined,
      headers: Record<string, string> = {};
    do {
      current(expected);
      const value = await client.workbench("pages.resource", { token, path, offset });
      current(expected);
      if (
        !record(value) ||
        value.status !== 200 ||
        value.offset !== offset ||
        !Number.isSafeInteger(value.total) ||
        typeof value.total !== "number" ||
        value.total < offset ||
        value.total > 8 * 1024 * 1024 ||
        (total !== undefined && total !== value.total) ||
        typeof value.body !== "string" ||
        value.body.length > 262144 ||
        !record(value.headers) ||
        Object.values(value.headers).some((item) => typeof item !== "string")
      )
        throw Error("Page resource unavailable");
      const chunk = value as WorkbenchPageResourceResult;
      const bytes = Uint8Array.from(atob(chunk.body), (character) => character.charCodeAt(0));
      total = chunk.total;
      if (offset + bytes.length > total || (!bytes.length && offset < total))
        throw Error("Invalid page resource chunk");
      parts.push(bytes);
      offset += bytes.length;
      headers = chunk.headers;
    } while (offset < total);
    const bytes = new Uint8Array(total);
    let position = 0;
    for (const part of parts) {
      bytes.set(part, position);
      position += part.length;
    }
    return { text: new TextDecoder().decode(bytes), headers };
  }
  async function prepare(app: Record<string, unknown>, expected: string) {
    if (typeof app.token !== "string" || typeof app.frameUrl !== "string")
      throw Error("Invalid page descriptor");
    const token = app.token;
    tokens.add(token);
    try {
      const view = await resource(token, "/view", expected);
      let html = view.text;
      if (app.kind === "genUi") {
        // Gen-UI 的已打包资源仍由原宿主白名单解析，不扩大到任意磁盘或网络资源。
        const scripts = [...html.matchAll(/<script\b([^>]*?)\bsrc="(\/[^"]+)"([^>]*)><\/script>/g)];
        for (const match of scripts) {
          const source = await resource(token, match[2], expected);
          html = html.replace(
            match[0],
            () =>
              `<script${match[1]}${match[3]}>${source.text.replace(/<\/script/gi, "<\\/script")}</script>`,
          );
        }
        const styles = [...html.matchAll(/<link rel="stylesheet" href="(\/[^"]+)">/g)];
        for (const match of styles) {
          const source = await resource(token, match[1], expected);
          html = html.replace(
            match[0],
            () => `<style>${source.text.replace(/<\/style/gi, "<\\/style")}</style>`,
          );
        }
      }
      current(expected);
      const csp = view.headers["content-security-policy"];
      if (!csp) throw Error("Page CSP unavailable");
      app.frameHtml =
        `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp.replaceAll("'self'", ""))}">` +
        html;
      return app;
    } catch (error) {
      tokens.delete(token);
      if (identity() === expected)
        void client.workbench("pages.command", { operation: "close", token }).catch(() => {});
      throw error;
    }
  }
  const mcpApp = createMcpAppCommand(async (request) => {
    const expected = identity();
    current(expected);
    if (!record(request)) throw Error("Invalid page command");
    const value = await client.workbench("pages.command", request);
    current(expected);
    if (record(value) && (value.kind === "mcp" || value.kind === "genUi"))
      return prepare(value, expected!);
    if (record(value) && value.status === "open" && record(value.app))
      return { ...value, app: await prepare(value.app, expected!) };
    if (request.operation === "close" && typeof request.token === "string")
      tokens.delete(request.token);
    return value;
  });
  return {
    mcpApp,
    onMcpAppEvent(listener: (event: McpAppEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      for (const token of tokens)
        void client.workbench("pages.command", { operation: "close", token }).catch(() => {});
      disposed = true;
      revoke();
      offEvents();
      offState();
      listeners.clear();
    },
  };
}
