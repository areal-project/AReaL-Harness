const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
const recorded = new Set<string>();

/** 记录渲染端一次性启动阶段耗时，供本地性能定位与主进程日志汇总。 */
export function markRendererStartup(
  stage: string,
  detail?: Record<string, string | number | boolean>,
) {
  if (recorded.has(stage)) return;
  recorded.add(stage);
  const elapsedMs =
    Math.round(
      ((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt) * 1000,
    ) / 1000;
  try {
    performance?.mark?.(`areal:startup:${stage}`);
    console.info(
      `[startup-renderer] ${JSON.stringify({
        event: "startup_renderer",
        stage,
        elapsedMs,
        at: new Date().toISOString(),
        ...(detail ? { detail } : {}),
      })}`,
    );
  } catch {}
}
