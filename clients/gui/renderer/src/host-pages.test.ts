import { describe, expect, it } from "vite-plus/test";
import type { HostReadState } from "@areal/client";
import { createHostPages } from "./host-pages.js";

const descriptor = {
  kind: "genUi", token: "page-a", frameUrl: "http://127.0.0.1:1234/host/pages/proxy",
  projectId: "project", threadId: "thread",
  source: { projectId: "project", threadId: "thread", turnId: "turn", itemId: "item", referenceOffset: 0 },
  artifact: { artifactId: "artifact", path: "/artifacts/widget.html", digest: "digest" },
  title: "Widget", readOnly: false, hostContext: {},
};
const open = { operation: "openGenUi" as const, ...descriptor.source };
function setup(resources: Record<string, string>) {
  let state: HostReadState = { connection: "ready", freshness: "fresh", identity: {
    hostId: "host", hostGeneration: "generation", connectionId: "connection", gatewayGeneration: "generation",
  } };
  const states = new Set<() => void>(), events = new Set<(value: unknown) => void>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let gate: Promise<unknown> | undefined;
  const client = {
    snapshot: () => state,
    subscribe(listener: () => void) { states.add(listener); return () => { states.delete(listener); }; },
    subscribePageEvents(listener: (value: unknown) => void) { events.add(listener); return () => { events.delete(listener); }; },
    async workbench(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "pages.command") return params.operation === "openGenUi" ? { ...descriptor } : {};
      await gate;
      const text = resources[String(params.path)];
      if (text === undefined) throw Error("Forbidden");
      const bytes = new TextEncoder().encode(text), offset = Number(params.offset);
      return { status: 200, offset, total: bytes.length,
        body: btoa(String.fromCharCode(...bytes.slice(offset, offset + 11))),
        headers: { "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none'" } };
    },
  };
  return {
    pages: createHostPages(client), calls,
    gate(value: Promise<unknown>) { gate = value; },
    disconnect() { state = { connection: "offline", freshness: "stale" }; for (const listener of states) listener(); },
    event(value: unknown) { for (const listener of events) listener(value); },
  };
}
describe("Host page resources", () => {
  it("assembles UTF-8 chunks and embeds only authorized Gen-UI resources under the returned CSP", async () => {
    const f = setup({ "/view": '<script src="/runtime.js"></script><p>中文🙂</p>', "/runtime.js": 'document.body.dataset.ready="yes";' });
    const app = await f.pages.mcpApp(open);
    expect(app.frameHtml).toContain("中文🙂");
    expect(app.frameHtml).toContain('document.body.dataset.ready="yes";');
    expect(app.frameHtml).toContain("Content-Security-Policy");
    expect(app.frameHtml).toContain("connect-src 'none'");
    expect(app.frameHtml).not.toContain('src="/runtime.js"');
    expect(app.frameHtml).not.toContain("'self'");
    expect(app.frameUrl).toBe(descriptor.frameUrl);
    f.pages.dispose();
  });
  it("does not deliver resource bytes received after the owner disconnects", async () => {
    const f = setup({ "/view": "<p>private</p>" });
    let release!: () => void;
    f.gate(new Promise<void>((resolve) => { release = resolve; }));
    const loading = f.pages.mcpApp(open);
    const rejected = expect(loading).rejects.toThrow("disconnected");
    await Promise.resolve();
    f.disconnect();
    release();
    await rejected;
    expect(f.calls.filter((call) => call.params.operation === "close")).toHaveLength(0);
    f.pages.dispose();
  });
  it("filters unrelated tokens and revokes the current page on disconnect", async () => {
    const f = setup({ "/view": "<p>page</p>" });
    await f.pages.mcpApp(open);
    const received: unknown[] = [];
    f.pages.onMcpAppEvent((event) => received.push(event));
    f.event({ token: "another-page", notification: { jsonrpc: "2.0", method: "ui/notifications/closed" } });
    expect(received).toHaveLength(0);
    f.disconnect();
    expect(received).toEqual([{ token: "page-a", notification: { jsonrpc: "2.0", method: "ui/notifications/closed" } }]);
    f.pages.dispose();
  });
});
