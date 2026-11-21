import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Action } from "../services.js";
import { useConversationObservation } from "./useConversationObservation.js";
import type { useSessionNavigation } from "./useSessionNavigation.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function observe(input: {
  threadId: string;
  completionId: string;
  action: Action;
  resourceAction: Action;
}) {
  let result!: ReturnType<typeof useConversationObservation>;
  function Harness() {
    const session = {
      readOnly: false,
      project: { id: "p1", state: { connected: true } },
      thread: { id: input.threadId },
      threadId: input.threadId,
      snapshot: { projects: [], lifecycle: { operations: [] } },
      library: { threads: { [`p1:${input.threadId}`]: { completionId: input.completionId } } },
      resourceAction: input.resourceAction,
    } as unknown as ReturnType<typeof useSessionNavigation>;
    result = useConversationObservation(session, input.action, true, true, false, false);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return result;
}

it("debounces foreground readThread via resourceAction without invoking notice action", () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { hasFocus: () => true, visibilityState: "visible" });
  const action = vi.fn(async () => undefined);
  const resourceAction = vi.fn(async () => undefined);

  const first = observe({
    threadId: "t1",
    completionId: "c1",
    action: action as unknown as Action,
    resourceAction: resourceAction as unknown as Action,
  });
  const cancelFirst = first.markForegroundCompletionRead();
  expect(typeof cancelFirst).toBe("function");

  // 快速切走时取消未发出的已读标记，不占用 Host 命令队列。
  vi.advanceTimersByTime(50);
  cancelFirst?.();
  vi.advanceTimersByTime(200);
  expect(resourceAction).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();

  const second = observe({
    threadId: "t2",
    completionId: "c2",
    action: action as unknown as Action,
    resourceAction: resourceAction as unknown as Action,
  });
  second.markForegroundCompletionRead();
  vi.advanceTimersByTime(150);

  expect(action).not.toHaveBeenCalled();
  expect(resourceAction).toHaveBeenCalledExactlyOnceWith("library", {
    operation: "readThread",
    projectId: "p1",
    threadId: "t2",
    read: true,
    completionId: "c2",
  });
});
