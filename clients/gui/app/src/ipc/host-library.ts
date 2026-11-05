import { HostClient } from "@areal/client/node";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 资料库切到 Host 单写后，Main 只把下一份内容写到同目录暂存文件，由 Host 比较摘要后替换 library.json。
 * 返回新摘要；摘要不符时 Host 回 conflict，调用方重读磁盘再重算。
 */
export function createHostLibraryStore(options: {
  home: string;
  binary: string;
  profile: string;
  library: string;
}) {
  let client: InstanceType<typeof HostClient> | undefined;
  return {
    async write(value: unknown, expectedDigest: string | null): Promise<string> {
      const staged = `.library-next-${randomUUID()}.json`;
      const path = join(options.library, staged);
      await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      try {
        if (!client) {
          client = new HostClient();
          await client.connectOrStart(options.home, options.binary);
        }
        const result: unknown = await client
          .request("library.write", { profile: options.profile, expectedDigest, staged })
          .catch((error: unknown) => {
            if (!(error && typeof error === "object" && "code" in error)) {
              client?.close();
              client = undefined;
            }
            throw error;
          });
        if (!result || typeof result !== "object" || !("digest" in result))
          throw new Error("Invalid Host library result");
        return String(result.digest);
      } finally {
        await rm(path, { force: true });
      }
    },
    close() {
      client?.close();
      client = undefined;
    },
  };
}

/** 一套协议过渡开关在界面的 localStorage 里；后台进程按它切换资料库写入口，关掉开关即回到自己写。 */
export async function enableHostLibrary(
  window: { webContents: { executeJavaScript(code: string): Promise<unknown> } } | null,
  backend: { setOneProtocol(flags: { library: boolean }): void },
) {
  try {
    const enabled = await window?.webContents.executeJavaScript(
      `localStorage.getItem("areal.oneProtocol.reads") === "1" && (localStorage.getItem("areal.oneProtocol.domains") ?? "").split(",").map((v) => v.trim()).includes("library")`,
    );
    backend.setOneProtocol({ library: enabled === true });
  } catch (error) {
    console.error("资料库切换到 Host 失败", error);
  }
}
