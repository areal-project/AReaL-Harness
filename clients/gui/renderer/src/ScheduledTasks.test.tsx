import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vite-plus/test";
import { ScheduledTaskRow } from "./ScheduledTasks.js";

const editorImport = vi.hoisted(() => vi.fn());
vi.mock("./ScheduledTaskEditDialog.js", () => {
  editorImport();
  return { ScheduledTaskEditDialog: () => null };
});
vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id }),
}));

test("reading a scheduled task does not import its editor or execute task actions", () => {
  const action = vi.fn();
  const markup = renderToStaticMarkup(
    createElement(ScheduledTaskRow, {
      task: {
        id: "task",
        objective: "Review CI",
        mode: "scheduled",
        runs: [],
        schedule: { kind: "once", at: 2000000000 },
        nextRunAt: 2000000000,
      },
      project: { id: "project", state: { connected: true }, pending: [] },
      action,
      variant: "card",
    }),
  );
  expect(markup).toContain('data-scheduled-task-menu="task"');
  expect(markup).toContain("Review CI");
  expect(editorImport).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});

test("runtime transport guard rejects N*2 preview+observe dual reads and O(N^2) same-turn duplicate target fanouts while coalescing identical in-flight reads", async () => {
  const { call } = await import("./services.js");
  const reqSame = "00000000-0000-4000-a000-000000000001";
  const reqPreview = "00000000-0000-4000-a000-000000000002";
  const reqObserve = "00000000-0000-4000-a000-000000000003";
  const reqA = "00000000-0000-4000-a000-000000000004";
  const reqB = "00000000-0000-4000-a000-000000000005";
  let calls = 0;
  const okPage = {
    data: [],
    errors: [],
    hasMore: false,
    owners: [
      {
        projectId: "proj-1",
        status: "unobserved",
        source: "published",
        coverage: { kind: "empty" },
        readAt: 1,
      },
    ],
    projectId: "proj-1",
    requestId: reqSame,
    viewEpoch: 1,
  };
  const services = {
    snapshot: async () => ({ projects: [] }),
    onState: () => () => {},
    chooseProject: async () => null,
    theme: async () => ({ dark: false, id: "default" }),
    onTheme: () => () => {},
    preview: async () => null,
    command: vi.fn(async (_name: string, params: Record<string, unknown>) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const projectId = (params.projectId as string) ?? "proj-1";
      return {
        ok: true as const,
        value: {
          ...okPage,
          owners: [{ ...okPage.owners[0], projectId }],
          projectId,
          requestId: (params.requestId as string) ?? reqSame,
          viewEpoch: (params.viewEpoch as number) ?? 1,
          ...(params.operation === "preview"
            ? { source: "published", executionState: "unobserved" }
            : {}),
        },
      };
    }),
  };

  // 1. 同一参数并发读取自动合并为单次底层请求
  const [r1, r2] = await Promise.all([
    call(services as any, "tasks", {
      operation: "observe",
      projectId: "proj-1",
      limit: 30,
      requestId: reqSame,
      viewEpoch: 1,
    }),
    call(services as any, "tasks", {
      operation: "observe",
      projectId: "proj-1",
      limit: 30,
      requestId: reqSame,
      viewEpoch: 1,
    }),
  ]);
  expect(r1).toEqual(r2);
  expect(calls).toBe(1);

  // 2. 同一目标并发发起 preview + observe (N×2) 被确定性拦截
  const previewPromise = call(services as any, "tasks", {
    operation: "preview",
    projectId: "proj-2",
    limit: 30,
    requestId: reqPreview,
    viewEpoch: 1,
  });
  await expect(
    call(services as any, "tasks", {
      operation: "observe",
      projectId: "proj-2",
      limit: 30,
      requestId: reqObserve,
      viewEpoch: 1,
    }),
  ).rejects.toMatchObject({ code: "FANOUT_N_TIMES_2_FORBIDDEN" });
  await previewPromise;

  // 3. 同一事件轮次内用不同 requestId 对同一目标重复扇出 (O(N^2)) 被确定性拦截
  const firstTurnCall = call(services as any, "tasks", {
    operation: "observe",
    projectId: "proj-3",
    limit: 30,
    requestId: reqA,
    viewEpoch: 1,
  });
  await expect(
    call(services as any, "tasks", {
      operation: "observe",
      projectId: "proj-3",
      limit: 30,
      requestId: reqB,
      viewEpoch: 1,
    }),
  ).rejects.toMatchObject({ code: "FANOUT_DUPLICATE_TARGET_FORBIDDEN" });
  await firstTurnCall;
});
