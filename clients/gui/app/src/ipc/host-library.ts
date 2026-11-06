type ProtocolFlags = { library: boolean; backend: boolean; rustDomains: string[] };
/** 一套协议过渡开关在界面的 localStorage 里；后台进程按它切换资料库写入口，关掉开关即回到自己写。 */
export async function enableHostLibrary(
  window: { webContents: { executeJavaScript(code: string): Promise<unknown> } } | null,
  backend: { setOneProtocol(flags: ProtocolFlags): void },
) {
  try {
    const enabled = await window?.webContents.executeJavaScript(
      `(() => { const domains = (localStorage.getItem("areal.oneProtocol.domains") ?? "").split(",").map((v) => v.trim()); return { library: localStorage.getItem("areal.oneProtocol.reads") === "1" && domains.includes("library"), backend: domains.includes("backend"), rustDomains: domains.filter((v) => ["library-rust","execution-rust","tasks-rust","worktree-rust"].includes(v)) }; })()`,
    );
    if (enabled && typeof enabled === "object" && "library" in enabled && "backend" in enabled)
      backend.setOneProtocol({
        library: enabled.library === true,
        backend: enabled.backend === true,
        rustDomains:
          "rustDomains" in enabled && Array.isArray(enabled.rustDomains)
            ? enabled.rustDomains.filter((v): v is string => typeof v === "string")
            : [],
      });
  } catch (error) {
    console.error("资料库切换到 Host 失败", error);
  }
}
