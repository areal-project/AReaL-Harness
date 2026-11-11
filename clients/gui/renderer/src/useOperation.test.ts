import { expect, it, vi } from "vite-plus/test";
import { operationFailure, useOperation, type OperationState } from "./useOperation.js";

// 单个组件实例：useState 记住最新值，useRef/useCallback 原样返回。
const hook = vi.hoisted(() => ({ state: undefined as unknown, ref: undefined as unknown }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    hook.state ??= initial;
    return [hook.state, (next: unknown) => (hook.state = next)];
  },
  useRef: (value: unknown) => (hook.ref ??= { current: value }),
  useCallback: (callback: unknown) => callback,
}));

it("maps a lost response to unknown and a refusal to failed", () => {
  expect(operationFailure(Object.assign(new Error("lost"), { submissionUnknown: true }))).toEqual({
    status: "unknown",
    message: "lost",
  });
  expect(operationFailure(new Error("refused"))).toEqual({ status: "failed", message: "refused" });
});

it("runs one task at a time and settles to the task outcome", async () => {
  const operation = useOperation();
  let release!: (value: string) => void;
  const first = operation.run(() => new Promise<string>((resolve) => (release = resolve)));
  expect(hook.state).toEqual({ status: "running" });
  expect(await operation.run(async () => "second")).toBeUndefined();
  release("first");
  expect(await first).toBe("first");
  expect(hook.state as OperationState).toEqual({ status: "succeeded" });
  await operation.run(async () => {
    throw new Error("refused");
  });
  expect(hook.state).toEqual({ status: "failed", message: "refused" });
});
