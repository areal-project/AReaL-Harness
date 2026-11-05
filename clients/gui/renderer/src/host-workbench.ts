import type { HostClient } from "@areal/client";
import type { PlatformServices } from "./services.js";

const ACTIVITY_MS = 5000;
const IDLE_CAP_SECONDS = 24 * 60 * 60;
/** 服务没起来或方法未开放时退回桌面原路径；其它错误照常报给界面。 */
const FALLBACK = new Set(["CAPABILITY_UNAVAILABLE", "methodNotFound", "FORBIDDEN"]);

/** 按领域切到工作台服务的开关，逗号分隔，如 `analytics`。只在 reads 开着时生效。 */
export function hostDomains(): Set<string> {
  try {
    if (localStorage.getItem("areal.oneProtocol.reads") !== "1") return new Set();
    return new Set(
      (localStorage.getItem("areal.oneProtocol.domains") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function declined(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    FALLBACK.has(String((error as { code?: unknown }).code))
  );
}

/**
 * 使用统计切到 Host 的工作台服务：读与同步走 Host；本窗口每 5 秒上报前台与空闲状态，
 * 服务对所有客户端取并集；首次连上时把桌面原有的每日活跃时间合并过去。
 */
export function createWorkbenchRoutes(
  client: HostClient,
  desktop: PlatformServices | undefined,
  domains: Set<string>,
  events: Pick<Window, "addEventListener"> | undefined,
  document: Document | undefined,
): PlatformServices["workbench"] {
  if (!domains.has("analytics")) return undefined;
  let lastInput = Date.now();
  for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
    events?.addEventListener(name, () => (lastInput = Date.now()), { passive: true });
  let imported: Promise<void> | undefined;
  const importDesktop = () =>
    (imported ??= (async () => {
      if (!desktop) return;
      const result = await desktop.command("analytics", { operation: "read" });
      if (!result.ok) return;
      const summary = result.value as { since: number; days: Record<string, { activeMs: number }> };
      const days = Object.fromEntries(
        Object.entries(summary.days)
          .filter(([, day]) => day.activeMs > 0)
          .map(([date, day]) => [date, day.activeMs]),
      );
      await client.workbench("analytics.import", {
        state: { version: 1, since: summary.since, days, turns: {}, skills: {} },
      });
    })().catch((error) => {
      imported = undefined;
      throw error;
    }));
  const report = () => {
    if (!client.writable("analytics.activity")) return;
    void importDesktop().catch(() => {});
    const focused = document
      ? document.hasFocus() && document.visibilityState === "visible"
      : false;
    const idleSeconds = Math.min(IDLE_CAP_SECONDS, Math.floor((Date.now() - lastInput) / 1000));
    void client.workbench("analytics.activity", { focused, idleSeconds }).catch(() => {});
  };
  setInterval(report, ACTIVITY_MS);
  for (const name of ["focus", "blur"]) events?.addEventListener(name, report);
  return {
    async call(name, params) {
      if (name !== "analytics" || !client.writable("analytics.read")) return undefined;
      const method = params.operation === "sync" ? "analytics.sync" : "analytics.read";
      try {
        await importDesktop().catch(() => {});
        return { value: await client.workbench(method) };
      } catch (error) {
        if (declined(error)) return undefined;
        throw error;
      }
    },
  };
}
