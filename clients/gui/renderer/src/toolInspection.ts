import { recordItems } from "./data-shapes.js";
import type { Data } from "./services.js";
import { rawText } from "./errors/errorCopy.js";

export function hasUnknownToolOutcome(item: Data): boolean {
  return (
    item.type === "dynamicToolCall" &&
    (item.execution?.outcome === "unknown" ||
      recordItems(item.execution?.hooks).some((hook: Data) => hook.outcome === "unknown") ||
      recordItems(item.execution?.plugin?.operations).some(
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
    !(rawText(turn.error)?.includes("UNKNOWN") && turn.items?.some(hasUnknownToolOutcome))
  );
}
