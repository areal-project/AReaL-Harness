import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { HostClient } from "@areal/client/node";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { readHostBootstrap, record } from "../../../packages/client/src/bootstrap.js";

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
  return async () => {
    const client = new HostClient();
    try {
      await client.connectOrStart(options.home, options.binary);
      const file = await open(
        join(options.home, "host/endpoint.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > 4096
        )
          throw new Error("Invalid Host endpoint file");
        const endpoint: unknown = JSON.parse(await file.readFile("utf8"));
        if (
          !record(endpoint) ||
          endpoint.hostId !== client.hostId ||
          endpoint.generation !== client.generation ||
          typeof endpoint.websocketUrl !== "string"
        )
          throw new Error("Host endpoint identity changed");
        const url = new URL(endpoint.websocketUrl);
        if (
          url.protocol !== "ws:" ||
          url.hostname !== "127.0.0.1" ||
          !url.port ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Invalid Host endpoint");
        // Host 换代时端口会变，文档只授权同一回环主机；连接仍须新代一次性票据。
        return {
          connectSource: `${url.protocol}//${url.hostname}:*`,
          frameSource: `http://${url.host}/host/pages/proxy`,
        };
      } finally {
        await file.close();
      }
    } finally {
      client.close();
    }
  };
}
