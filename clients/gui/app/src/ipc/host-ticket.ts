import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { HostClient } from "@areal/client/node";
import { readHostBootstrap } from "../../../packages/client/src/bootstrap.js";
import pageProxyHtml from "../../../../../core/host/src/page_proxy.html";

export const hostTicketChannel = "areal-native:host-ticket";
export const hostTicketSchema = {
  input: { type: "array", maxItems: 0 },
  output: "HostBootstrap",
} as const;

export function registerHostTicket(options: {
  home: string;
  binary: string;
  profile: string;
  trusted(event: IpcMainInvokeEvent): unknown;
}) {
  ipcMain.handle(hostTicketChannel, async (event, ...args: unknown[]) => {
    options.trusted(event);
    if (args.length) throw new Error("Host ticket takes no arguments");
    // 票据只依赖 Rust Host；工作台初始化在后台进行，不能阻塞首屏拿到 shell 快照。
    const client = new HostClient();
    try {
      await client.connectOrStart(options.home, options.binary);
      const value = readHostBootstrap(
        await client.request("web.ticket", {
          origin: "areal-ui://app",
          expectedGeneration: client.generation,
          profile: options.profile,
        }),
      );
      options.trusted(event);
      if (value.hostId !== client.hostId || value.generation !== client.generation)
        throw new Error("Host identity changed");
      return value;
    } finally {
      client.close();
    }
  });
}

/** 桌面只提供固定沙箱代理，页面内容和资源仍由当前已鉴权 Host 会话提供。 */
export function hostPageProxy(request: Request) {
  if (request.url !== "areal-mcp://host-pages/proxy" || request.method !== "GET") return undefined;
  return new Response(pageProxyHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline' http: https: data: blob:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src http: https: wss:; frame-src http: https: data: blob:; base-uri http: https:; object-src 'none'; form-action 'none'; worker-src 'none'; sandbox allow-scripts",
    },
  });
}
