import { useSyncExternalStore } from "react";

// 仅表示本地在途输入；草稿和 Core 回执继续由原提交链路管理。
export type PendingMessage = {
  text: string;
  files: readonly File[];
  previousUserIds: readonly string[];
  starting?: boolean;
};
const messages = new Map<string, PendingMessage>();
const listeners = new Set<() => void>();
export function setPendingMessage(key: string, message?: PendingMessage) {
  if (message) messages.set(key, message);
  else messages.delete(key);
  listeners.forEach((listener) => listener());
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
