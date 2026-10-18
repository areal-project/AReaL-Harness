export type SideRestoreState = "idle" | "loading" | "ready" | "error";

// 每个 owner/connectionGeneration 拥有一次恢复；确定失败等待显式重试。
export function createSideRestore() {
  let state: SideRestoreState = "idle";
  let disposed = false;
  let revision = 0;
  return {
    retry() {
      if (state !== "error" || disposed) return false;
      state = "idle";
      return true;
    },
    dispose() {
      disposed = true;
      revision++;
    },
    async load(
      request: () => Promise<unknown>,
      update: (state: SideRestoreState, error?: string) => void,
    ) {
      if (disposed || state !== "idle") return;
      const token = ++revision;
      state = "loading";
      update(state);
      try {
        await request();
        if (disposed || revision !== token) return;
        state = "ready";
        update(state);
      } catch (error) {
        if (disposed || revision !== token) return;
        state = "error";
        update(state, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
