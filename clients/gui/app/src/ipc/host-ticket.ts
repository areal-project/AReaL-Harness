import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { HostClient } from "@areal/client/node";
import { readHostBootstrap } from "../../../packages/client/src/bootstrap.js";

export const hostTicketChannel = "areal-native:host-ticket";
export const hostTicketSchema = {
  input: { type: "array", maxItems: 0 },
  output: "HostBootstrap",
} as const;

export function registerHostTicket(options: {
  home: string;
  profile: string;
  trusted(event: IpcMainInvokeEvent): unknown;
}) {
  ipcMain.handle(hostTicketChannel, async (event, ...args: unknown[]) => {
    options.trusted(event);
    if (args.length) throw new Error("Host ticket takes no arguments");
    // 读取票据不能绕过 Main 对原停止回执的核查并启动后继 Host。
    const client = new HostClient();
    try {
      await client.connect(options.home);
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
