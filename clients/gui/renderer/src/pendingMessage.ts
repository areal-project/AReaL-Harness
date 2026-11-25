import { useSyncExternalStore } from "react";
import type { MessageId } from "./i18n/messages.js";

// 本地输入预览保留到回执与历史投影交接完成；草稿和 Core 回执仍由原提交链路管理。
export type PendingMessage = {
  text: string;
  files: readonly File[];
  previousUserIds: readonly string[];
  starting?: boolean;
  accepted?: boolean;
  status?: MessageId;
  /** 实时计时起始时间戳（ms），用于云端沙箱启动等长耗时阶段。 */
  startedAt?: number;
  /** 阶段已结算的耗时（秒），如沙箱就绪后进入发送阶段时展示启动用时。 */
  elapsedSeconds?: number;
};
const messages = new Map<string, PendingMessage>();
const listeners = new Set<() => void>();
export function setPendingMessage(key: string, message?: PendingMessage) {
  if (message) messages.set(key, message);
  else messages.delete(key);
  listeners.forEach((listener) => listener());
}
type Turns = readonly { items?: readonly { id: string; type: string; originalType?: string }[] }[];
// 历史页里体积大的用户消息以 historyDeferred 占位，originalType 保留原类型。
export function userMessageIds(turns: Turns | undefined) {
  return (turns ?? []).flatMap((turn) =>
    (turn.items ?? [])
      .filter(
        (item) =>
          item.type === "userMessage" ||
          (item.type === "historyDeferred" && item.originalType === "userMessage"),
      )
      .map((item) => item.id),
  );
}
/** 投影里出现了提交前没有的用户消息，说明这次提交已被历史接管。 */
export function pendingMessageProjected(turns: Turns | undefined, message: PendingMessage) {
  return userMessageIds(turns).some((id) => !message.previousUserIds.includes(id));
}
export function acceptPendingMessage(key: string) {
  const message = messages.get(key);
  if (message) setPendingMessage(key, { ...message, accepted: true });
}
export function getPendingMessage(key: string) {
  return messages.get(key);
}
export function subscribePendingMessages(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function usePendingMessage(key: string) {
  return useSyncExternalStore(
    subscribePendingMessages,
    () => messages.get(key),
    () => messages.get(key),
  );
}
