import type { Data } from "./services.js";
import type { TrajectoryVisualRole } from "./ModelTrajectoryRoleStyles.js";
export type TrajectoryEntry = {
  id: string;
  role: TrajectoryVisualRole;
  label: string;
  text: string;
};
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
/** Canonical turn projection, deliberately not reconstructed HTTP requests. */
export function trajectoryEntries(turn: Data): TrajectoryEntry[] {
  const rows: TrajectoryEntry[] = [];
  const add = (
    id: string,
    role: TrajectoryVisualRole,
    label: string,
    text: string,
  ) => rows.push({ id, role, label, text });
  if (turn.instructionSnapshot)
    add(
      `${turn.id}:system`,
      "system",
      "系统指令快照",
      turn.instructionSnapshot,
    );
  for (const item of turn.items ?? []) {
    if (item.type === "userMessage")
      add(
        item.id,
        "user",
        "用户消息",
        (item.content ?? [])
          .map((p: Data) => (p.type === "text" ? p.text : `[${p.type}]`))
          .join("\n"),
      );
    if (item.type === "agentMessage")
      add(item.id, "assistant", "助手消息", item.text ?? "");
    if (item.type === "agentMedia")
      add(
        item.id,
        "assistant",
        "助手附件",
        json({ modality: item.modality, media: item.media }),
      );
    if (item.type === "reasoning") {
      for (const [field, label] of [["summary", "思考摘要"], ["content", "模型返回的思考"]]) {
        (item[field] ?? []).forEach((text: unknown, index: number) => {
          if (typeof text === "string" && text.trim())
            add(`${item.id}:${field}:${index}`, "reasoning", label, text);
        });
      }
    }
    if (item.type === "modelContext") {
      const v = item.value;
      // Only display explicit, provider-emitted reasoning. Never dump opaque/encrypted context.
      const text =
        v?.type === "chat_reasoning" ? v.reasoning_content : undefined;
      if (typeof text === "string")
        add(item.id, "reasoning", "模型返回的思考", text);
    }
    if (item.type === "dynamicToolCall") {
      add(
        `${item.id}:call`,
        "tool-call",
        `工具调用 · ${item.tool}`,
        json({ callId: item.callId, arguments: item.arguments }),
      );
      add(
        `${item.id}:result`,
        "tool-result",
        `工具结果 · ${item.tool}`,
        json({
          status: item.status,
          success: item.success,
          execution: item.execution,
          contentItems: item.contentItems,
        }),
      );
    }
  }
  return rows;
}
export const turnStatus = (status: string) =>
  ({
    inProgress: "执行中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已停止",
  })[status] ?? status;
