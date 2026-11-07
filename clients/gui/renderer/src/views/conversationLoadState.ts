import type { MessageId } from "../i18n/IntlProvider.js";

// 对话区加载状态的唯一来源：文字和按钮出自同一分支，内部的 Host/Core 状态不直接上屏。
// 每个状态都有终点：启动或读取结束仍没有对话，就落到 failed，给出重试。
export type ConversationLoadState =
  | { kind: "starting"; message: MessageId }
  | { kind: "reading"; message: MessageId }
  | { kind: "failed"; message: MessageId; detail: string; retry: true; settings: boolean };

export function conversationLoadState(
  project: { state?: { connected?: boolean } } | undefined,
  startup: {
    restorationError: string;
    restorationFailed: boolean;
    viewRefreshing: boolean;
    currentRestoration?: { pending?: boolean };
  },
  settings: boolean,
): ConversationLoadState {
  const input = {
    connected: !!project?.state?.connected,
    failure: startup.restorationError,
    failed: startup.restorationFailed,
    attemptSettled:
      !!startup.currentRestoration &&
      !startup.currentRestoration.pending &&
      !startup.viewRefreshing,
    settings,
  };
  if (input.failed)
    return {
      kind: "failed",
      message: "common.conversation.unavailable",
      detail: input.failure,
      retry: true,
      settings: input.settings,
    };
  if (!input.connected)
    return input.attemptSettled
      ? {
          kind: "failed",
          message: "startup.projectStartFailed",
          detail: "",
          retry: true,
          settings: false,
        }
      : { kind: "starting", message: "startup.connectingProject" };
  return { kind: "reading", message: "startup.readingConversation" };
}
