import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostClient, ShellProject } from "@areal/client";
import { refreshTaskDirectory, type TaskDirectoryState } from "./host-task-directory.js";

afterEach(() => vi.useRealTimers());

describe("task directory refresh", () => {
  it("backs off after a failed read instead of re-reading on every publish", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let fail = true;
    const client = {
      workbench: async () => {
        calls++;
        if (fail) throw new Error("backend unavailable");
        return { data: [{ id: "task", projectId: "alias" }] };
      },
    } as unknown as HostClient;
    const projects = [
      { projectId: "host", state: "ready", taskRevision: "c:1" },
    ] as unknown as ShellProject[];
    const state: TaskDirectoryState = { tasks: new Map(), reads: new Map() };
    const refresh = () =>
      refreshTaskDirectory(client, projects, new Map([["host", "alias"]]), state, refresh);
    refresh();
    await vi.advanceTimersByTimeAsync(0);
    // 失败后的重绘不再触发读取。
    refresh();
    refresh();
    expect(calls).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    expect(state.tasks.get("host")).toMatchObject({ task: { id: "task" } });
  });
});
