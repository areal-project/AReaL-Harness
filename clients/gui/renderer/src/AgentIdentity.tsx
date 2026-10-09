import { useMemo } from "react";
import { createAvatar } from "@dicebear/core";
import * as bottts from "@dicebear/bottts";
import type { Data } from "./services.js";
import "./AgentResources.css";

// 身份来自 Core Thread，不将示例人名或图片 API 引入真实会话。
export const agentName = (id: string) => `Agent · ${id.slice(0, 8)}`;
export const agentStatus = (status?: string) => ({ inProgress: "执行中", completed: "已完成", interrupted: "已中断", failed: "失败" }[status ?? ""] ?? "状态待确认");
export function AgentAvatar({ id, size = 18 }: { id: string; size?: number }) {
  const src = useMemo(() => createAvatar(bottts, { seed: id, size: 64 }).toDataUri(), [id]);
  return <img className="agent-avatar" data-agent-avatar={id} src={src} width={size} height={size} alt="" aria-hidden="true" />;
}
export function spawnedAgent(item: Data): string | undefined {
  if (!["agent_spawn", "agent_spawn_configured"].includes(item.tool) || item.status !== "completed" || item.success !== true) return;
  for (const part of item.contentItems ?? []) {
    if (!["inputText", "text"].includes(part.type)) continue;
    try {
      const value = JSON.parse(part.text);
      if (typeof value.threadId === "string" && value.threadId && !value.threadId.startsWith("workgroup:")) return value.threadId;
    } catch { /* 非标准结果继续使用原工具记录。 */ }
  }
}

/** 摘要使用真实委派输入；长指令留在子对话中，不猜测系统前缀边界。 */
export function agentAssignment(thread: Data, id: string): string | undefined {
  const item = (thread.turns ?? []).flatMap((turn: Data) => turn.items ?? []).find((item: Data) => spawnedAgent(item) === id);
  const text = (item?.arguments?.input ?? []).filter((part: Data) => part.type === "text").map((part: Data) => part.text).join("\n").trim();
  return text || undefined;
}
