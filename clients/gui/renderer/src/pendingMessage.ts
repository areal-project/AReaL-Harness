import { useSyncExternalStore } from "react";

// 本地输入预览保留到回执与历史投影交接完成；草稿和 Core 回执仍由原提交链路管理。
export type PendingMessage = {
  text: string;
  files: readonly File[];
  previousUserIds: readonly string[];
  starting?: boolean;
  accepted?: boolean;
};
const messages = new Map<string, PendingMessage>();
const listeners = new Set<() => void>();
export function setPendingMessage(key: string, message?: PendingMessage) {
  if (message) messages.set(key, message);
  else messages.delete(key);
  listeners.forEach((listener) => listener());
}
export function acceptPendingMessage(key: string) {
  const message = messages.get(key);
  if (message) setPendingMessage(key, { ...message, accepted: true });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function usePendingMessage(key: string) {
  return useSyncExternalStore(subscribe, () => messages.get(key));
}
