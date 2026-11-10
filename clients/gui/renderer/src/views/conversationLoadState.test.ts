import { expect, test } from "vite-plus/test";
import { conversationLoadState } from "./conversationLoadState.js";

const idle = { restorationError: "", restorationFailed: false, viewRefreshing: false };

test.each([
  ["project not started yet, opening in flight", undefined, { pending: true }, "starting"],
  ["project started, reading the conversation", true, { pending: true }, "reading"],
  ["start attempt ended but project still not running", undefined, { pending: false }, "failed"],
] as const)("%s", (_, connected, currentRestoration, kind) => {
  expect(
    conversationLoadState({ state: { connected } }, { ...idle, currentRestoration }, false).kind,
  ).toBe(kind);
});

test("a failed open shows its own reason with retry, never a stopped-project hint", () => {
  const state = conversationLoadState(
    { state: { connected: false } },
    { ...idle, restorationError: "模型服务不可用", restorationFailed: true },
    true,
  );
  expect(state).toEqual({
    kind: "failed",
    message: "common.conversation.unavailable",
    detail: "模型服务不可用",
    retry: true,
    settings: true,
  });
});
