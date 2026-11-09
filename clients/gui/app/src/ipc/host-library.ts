type ProtocolFlags = { library: boolean; backend: boolean; rustDomains: string[] };
/** 界面只选择领域实现；后台所有权由启动客户端固定为 Host。 */
export async function enableHostLibrary(
  window: { webContents: { executeJavaScript(code: string): Promise<unknown> } } | null,
  backend: { setOneProtocol(flags: ProtocolFlags): void },
) {
  try {
    const enabled = await window?.webContents.executeJavaScript(
      `(() => { const domains = (localStorage.getItem("areal.oneProtocol.domains") ?? "").split(",").map((v) => v.trim()); return { library: localStorage.getItem("areal.oneProtocol.reads") === "1" && domains.includes("library"), backend: true, rustDomains: domains.filter((v) => ["library-rust","execution-rust","tasks-rust","worktree-rust"].includes(v)) }; })()`,
    );
    if (enabled && typeof enabled === "object" && "library" in enabled && "backend" in enabled)
      backend.setOneProtocol({
        library: enabled.library === true,
        backend: true,
        rustDomains:
          "rustDomains" in enabled && Array.isArray(enabled.rustDomains)
            ? enabled.rustDomains.filter((v): v is string => typeof v === "string")
            : [],
      });
  } catch (error) {
    console.error("资料库切换到 Host 失败", error);
  }
}
