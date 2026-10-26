import type { Data } from "./services.js";

export function hasUnknownToolOutcome(item: Data): boolean {
  return (
    item.type === "dynamicToolCall" &&
    (item.execution?.outcome === "unknown" ||
      item.execution?.hooks?.some((hook: Data) => hook.outcome === "unknown") ||
      item.execution?.plugin?.operations?.some(
        (operation: Data) => operation.outcome === "unknown",
      ))
  );
}

export function uninspectedToolCalls(thread: Data): Data[] {
  return (thread.turns ?? [])
    .flatMap((turn: Data) => turn.items ?? [])
    .filter((item: Data) => hasUnknownToolOutcome(item) && !item.execution?.inspection);
}

/** UNKNOWN 已有核对卡片，主状态不重复展示同一内部错误；其他失败继续可见。 */
export function showTurnStatus(turn: Data, interrupted: boolean, readingSummary: boolean): boolean {
  return (
    turn.status !== "inProgress" &&
    !interrupted &&
    !(turn.status === "completed" && readingSummary) &&
    !(turn.error?.message?.includes("UNKNOWN") && turn.items?.some(hasUnknownToolOutcome))
  );
}
