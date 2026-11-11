import { useCallback, useRef, useState } from "react";
import { currentErrorText } from "./errors/currentErrorText.js";

// 一次用户操作的显式状态。unknown 表示已发出但结果未确认：只能核对，不能自动重发。
export type OperationStatus = "idle" | "running" | "succeeded" | "failed" | "unknown";
export type OperationState = { status: OperationStatus; message?: string };

export function operationFailure(cause: unknown): OperationState {
  const failure = cause as Error & { submissionUnknown?: boolean };
  return {
    status: failure.submissionUnknown ? "unknown" : "failed",
    message: currentErrorText(cause),
  };
}

export function useOperation(initial: OperationState = { status: "idle" }) {
  const [state, set] = useState<OperationState>(initial);
  const locked = useRef(false);
  // 同一操作在途时再次触发直接忽略，返回 undefined。
  const run = useCallback(async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (locked.current) return undefined;
    locked.current = true;
    set({ status: "running" });
    try {
      const value = await task();
      set({ status: "succeeded" });
      return value;
    } catch (cause) {
      set(operationFailure(cause));
      return undefined;
    } finally {
      locked.current = false;
    }
  }, []);
  return { state, set, run, running: state.status === "running" };
}
