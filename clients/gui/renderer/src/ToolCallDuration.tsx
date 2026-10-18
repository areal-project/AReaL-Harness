import type { Data } from "./services.js";

/** A durable Core call receipt, not a client timer or process/turn duration. */
export function ToolCallDuration({ item }: { item: Data }) {
  const milliseconds = item.execution?.durationMs;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  const value = milliseconds < 1000 ? `${milliseconds} 毫秒`
    : `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(milliseconds / 1000)} 秒`;
  return <span className="tool-call-duration" aria-label="调用用时" data-tool-duration-ms={milliseconds}
    title="本次工具调用的耗时，不代表进程或整轮总耗时。">调用用时 {value}</span>;
}
