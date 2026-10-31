import type { Data } from "./services.js";
import type { TrajectoryVisualRole } from "./ModelTrajectoryRoleStyles.js";
export type TrajectoryEntry = {
  id: string;
  role: TrajectoryVisualRole;
  label: string;
  text: string;
  status?: string;
  durationMs?: number;
  startedAtMs?: number;
  callId?: string;
  rawResult?: string;
  activity?: Data;
};
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
/** Canonical turn projection, deliberately not reconstructed HTTP requests. */
export function trajectoryEntries(turn: Data): TrajectoryEntry[] {
  const rows: TrajectoryEntry[] = [];
  const add = (id: string, role: TrajectoryVisualRole, label: string, text: string) =>
    rows.push({ id, role, label, text });
  if (turn.instructionSnapshot)
    add(`${turn.id}:system`, "system", "系统指令快照", turn.instructionSnapshot);
  const activities: TrajectoryEntry[] = [];
  for (const activity of turn.trace?.activities ?? []) {
    activities.push({
      id: activity.id,
      role: "reasoning",
      label: activity.label,
      text: json(activity),
      status: activity.status,
      durationMs: activity.durationMs ?? undefined,
      startedAtMs: activity.startedAtMs,
      callId: activity.callId,
      activity,
    });
  }
  const itemIds = new Set((turn.items ?? []).map((item: Data) => item.id));
  rows.push(...activities.filter((entry) => !entry.activity?.afterItemId));
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
    if (item.type === "agentMessage") add(item.id, "assistant", "助手消息", item.text ?? "");
    if (item.type === "agentMedia")
      add(item.id, "assistant", "助手附件", json({ modality: item.modality, media: item.media }));
    if (item.type === "reasoning") {
      for (const [field, label] of [
        ["summary", "思考摘要"],
        ["content", "模型返回的思考"],
      ]) {
        (item[field] ?? []).forEach((text: unknown, index: number) => {
          if (typeof text === "string" && text.trim())
            add(`${item.id}:${field}:${index}`, "reasoning", label, text);
        });
      }
    }
    if (item.type === "modelContext") {
      const v = item.value;
      // Only display explicit, provider-emitted reasoning. Never dump opaque/encrypted context.
      const text = v?.type === "chat_reasoning" ? v.reasoning_content : undefined;
      if (typeof text === "string") add(item.id, "reasoning", "模型返回的思考", text);
    }
    if (item.type === "dynamicToolCall") {
      add(
        `${item.id}:call`,
        "tool-call",
        `工具调用 · ${item.tool}`,
        json({ callId: item.callId, arguments: item.arguments }),
      );
      Object.assign(rows[rows.length - 1], {
        status: item.execution?.outcome ?? (item.status === "inProgress" ? "running" : item.status),
        durationMs: item.execution?.durationMs,
        startedAtMs: item.execution?.startedAtMs,
        callId: item.callId,
      });
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
      Object.assign(rows[rows.length - 1], { rawResult: item.execution?.resultSnapshot?.uri });
    }
    rows.push(...activities.filter((entry) => entry.activity?.afterItemId === item.id));
  }
  rows.push(
    ...activities.filter(
      (entry) => entry.activity?.afterItemId && !itemIds.has(entry.activity.afterItemId),
    ),
  );
  return rows;
}
export const turnStatus = (status: string) =>
  ({
    inProgress: "执行中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已停止",
  })[status] ?? status;

/** Share the same saved execution projection as the pane, independent of its UI state. */
export function trajectoryText(thread: Data, title: string): string {
  return json({
    format: "areal-harness-trajectory-v1",
    title,
    notice: "已保存的执行记录；不包含逐次模型请求的完整 I/O。",
    threadId: thread.id,
    parentThreadId: thread.parentThreadId ?? null,
    turns: (thread.turns ?? []).map((turn: Data) => ({
      id: turn.id,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      trace: turn.trace,
      interruption: turn.interruption,
      continuedFromTurnId: turn.continuedFromTurnId,
      status: turn.status,
      model: turn.configuration?.model ?? null,
      usage: turn.usage ?? null,
      entries: trajectoryEntries(turn),
      error: turn.error ?? null,
    })),
  });
}
