import { expect, test } from "vite-plus/test";
import {
  conversationUserState,
  isProjectHibernated,
  projectUserState,
  taskUserState,
} from "./userStates.js";

test("project states collapse Host lifecycle into what the user can do", () => {
  const project = (state: Record<string, unknown>) => ({ state });
  expect(projectUserState(project({ connected: true, hostState: "ready" }))).toMatchObject({
    kind: "ready",
    canAct: true,
  });
  // 按需启动：已停止仍是“可用”，但现在还不能做需要在线的操作。
  expect(projectUserState(project({ connected: false, hostState: "stopped" }))).toMatchObject({
    kind: "ready",
    canAct: false,
  });
  expect(projectUserState(project({ connected: false, hostState: "stopping" }))).toMatchObject({
    kind: "ready",
    canAct: false,
  });
  expect(projectUserState(project({ hostState: "starting" })).kind).toBe("opening");
  expect(projectUserState(project({})).kind).toBe("opening");
  expect(projectUserState(project({ hostState: "legacyPending" })).kind).toBe("needsUpgrade");
  expect(projectUserState(project({ hostState: "unavailable" })).kind).toBe("unavailable");
});

test("isProjectHibernated distinguishes idle hibernation from explicit stop and real errors", () => {
  expect(isProjectHibernated({ state: { connected: false, hostState: "stopped" } })).toBe(true);
  expect(isProjectHibernated({ state: { connected: false, hostState: "stopping" } })).toBe(true);
  expect(isProjectHibernated({ state: { connected: true, hostState: "ready" } })).toBe(false);
  expect(
    isProjectHibernated({
      scheduling: { suppressed: true },
      state: { connected: false, hostState: "stopped" },
    }),
  ).toBe(false);
  expect(
    isProjectHibernated({
      error: "boom",
      state: { connected: false, hostState: "stopped" },
    }),
  ).toBe(false);
  expect(
    isProjectHibernated({
      state: { connected: false, hostState: "stopped", error: "boom" },
    }),
  ).toBe(false);
  expect(isProjectHibernated({ state: { connected: false, hostState: "starting" } })).toBe(false);
});

test("a conversation waiting on the user outranks one still working", () => {
  const live = (interactions: unknown[] = []) => ({
    state: { connected: true, interactions: { t1: { data: interactions } } },
  });
  const running = { turns: [{ status: "inProgress" }] };
  expect(conversationUserState(live([{ status: "pending" }]), "t1", running).kind).toBe("needsYou");
  expect(conversationUserState(live(), "t1", running).kind).toBe("working");
  expect(conversationUserState({ state: { connected: false } }, "t1", running).kind).toBe("idle");
  expect(conversationUserState(live(), "t1", { turns: [{ status: "failed" }] }).kind).toBe(
    "failed",
  );
  // 非当前选中的后台对话没有展开完整 turns 时，仍按 Host 实时摘要感知运行中/待处理状态；离线项目不误报运行中。
  expect(conversationUserState(live(), "bg", undefined, { activity: "working" }).kind).toBe(
    "working",
  );
  expect(conversationUserState(live(), "bg", undefined, { activity: "needsYou" }).kind).toBe(
    "needsYou",
  );
  expect(
    conversationUserState({ state: { connected: false } }, "bg", undefined, { activity: "working" })
      .kind,
  ).toBe("idle");
  expect(conversationUserState(live(), "t1", { turns: [] }, { activity: "working" }).kind).toBe(
    "idle",
  );
});

test("task run statuses map onto six user states", () => {
  const withRun = (status: string, extra: Record<string, unknown> = {}) => ({
    latestRun: { status },
    nextRunAt: 100,
    ...extra,
  });
  expect(taskUserState(withRun("waitingForAgents")).kind).toBe("running");
  expect(taskUserState(withRun("blocked")).kind).toBe("needsYou");
  expect(taskUserState(withRun("waitingForInput")).kind).toBe("needsYou");
  expect(taskUserState(withRun("completed", { paused: true })).kind).toBe("paused");
  expect(taskUserState(withRun("completed", { nextRunAt: null })).kind).toBe("finished");
  expect(taskUserState(withRun("failed", { nextRunAt: null })).kind).toBe("failed");
  expect(taskUserState({ cancelled: true }).kind).toBe("finished");
  expect(taskUserState({ nextRunAt: 100 }).kind).toBe("scheduled");
  expect(
    taskUserState({ lastTriggerDecision: { outcome: { kind: "missedWindow" } }, runs: [] }).kind,
  ).toBe("failed");
});
