import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostClient, ShellProject } from "@areal/client";
import { refreshTaskDirectory, type TaskDirectoryState } from "./host-task-directory.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("task directory refresh", () => {
  it("refreshes the logical project when its execution worktree changes", async () => {
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const refreshed: unknown[] = [];
    window.addEventListener("areal-scheduled-tasks-changed", (event) => {
      refreshed.push((event as CustomEvent).detail);
    });
    const client = {
      workbench: async () => ({
        data: [{ id: "task", projectId: "logical-alias", executionProjectId: "execution-alias" }],
      }),
    } as unknown as HostClient;
    const state: TaskDirectoryState = { tasks: new Map(), reads: new Map([["execution", "c:1"]]) };
    const projects = [
      { projectId: "execution", logicalProjectId: "logical", state: "ready", taskRevision: "c:2" },
    ] as unknown as ShellProject[];
    const ids = new Map([
      ["execution", "execution-alias"],
      ["logical", "logical-alias"],
    ]);
    refreshTaskDirectory(client, projects, ids, state, () => {});
    await vi.waitFor(() => expect(refreshed).toEqual(["logical-alias"]));
    expect(state.tasks.get("execution")).toMatchObject({
      task: { id: "task", projectId: "logical-alias", executionProjectId: "execution-alias" },
    });
  });

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
