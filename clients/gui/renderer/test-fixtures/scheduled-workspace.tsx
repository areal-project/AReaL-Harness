import React, { type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { TaskCenter } from "../src/TaskCenter";
import { ApplicationIntlProvider } from "../src/i18n/IntlProvider";
import type { Action, Data } from "../src/services";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
const recovery = query.get("recovery");
const project: ComponentProps<typeof TaskCenter>["projects"][number] = {
  id: "00000000-0000-4000-a000-000000000001",
  name: "Fixture project",
  root: "/fixture",
  state: { connected: true, threads: {} },
  core: { connectionGeneration: 1 },
  pending: [],
  outcomes: {},
  desktopCapabilities: { currentCommands: !query.has("legacy") },
};
const fixture = Object.assign(window, {
  calls: [] as { name: string; params: Data }[],
  opened: [] as { projectId: string; threadId: string }[],
  fail: query.has("fail"),
});
const originalThread = "00000000-0000-4000-a000-000000000002";
const completedOutcome = (requestId: string) => ({
  accepted: true,
  status: "completed",
  threadId: originalThread,
  operation: {
    requestId,
    method: "areal/thread/start",
    target: { kind: "thread", threadId: originalThread },
  },
});
// 旧版已保存的创建意图继续走原请求恢复；新意图打开新建弹框。
if (recovery)
  localStorage.setItem(
    "areal-gui:ordinary-schedule-creation",
    JSON.stringify({
      prepareId: "fixture-prepare",
      requestId: "fixture-create",
      text: "帮我创建一个定时任务：回顾我提供的计划，整理当天待办和需要关注的事项。",
    }),
  );
const rows = query.has("empty")
  ? []
  : [
      { id: "active", objective: "每日进展", paused: false },
      { id: "paused", objective: "每周回顾", paused: true },
    ].map((row) => ({
      ...row,
      projectId: project.id,
      mode: "scheduled",
      sourceThreadId: row.id + "-thread",
      runs: [],
      nextRunAt: 2000000000,
      schedule: { kind: "once", at: 2000000000 },
      scope: "workspace",
    }));

const action = async (name: string, params: Data) => {
  fixture.calls.push({ name, params });
  if (name === "manage" && params.operation === "taskWatch") {
    const task = rows.find((row) => row.id === params.taskId);
    if (!task) throw Error("Fixture task unavailable");
    // 与生产观察一致：先发布被观察任务，再确认 watch，不能只返回目录行。
    project.state.tasks = { ...project.state.tasks, [task.id]: task };
    return task;
  }
  if (name === "manage" && params.operation === "taskUnwatch") return { removed: true };
  if (name === "projectless" && params.operation === "catalog")
    return { models: [], lastAcceptedModel: null };
  if (name === "projectless" && params.operation === "scratch")
    return { projectId: project.id, cwd: "/scratch" };
  if (name === "projectless") return { projectId: project.id };
  if (name === "manage" && params.operation === "taskCreate") return { id: "created" };
  if (name === "create" && recovery)
    throw Object.assign(Error("Fixture create response lost"), {
      submissionUnknown: true,
      requestId: params.requestId,
    });
  if (name === "workspace" && params.operation === "worktreeRead") return { state: "missing" };
  if (name === "reconcile") {
    const requestId = fixture.calls.find((call) => call.name === "create")?.params.requestId;
    return {
      outcomes: recovery === "completed" ? { [requestId]: completedOutcome(requestId) } : {},
    };
  }
  if (name === "tasks") {
    if (fixture.fail) throw Error("Fixture catalog unavailable");
    return {
      projectId: project.id,
      requestId: params.requestId,
      viewEpoch: params.viewEpoch,
      data: rows,
      hasMore: false,
      errors: [],
      owners: [
        {
          projectId: project.id,
          status: "ready",
          source: "live",
          coverage: { kind: "complete" },
          readAt: Date.now(),
          connectionGeneration: 1,
        },
      ],
    };
  }
  if (name === "open") {
    project.state.threads[params.threadId] = { id: params.threadId };
    return {};
  }
  return { data: [], enabled: false, runNow: false };
};

function Fixture() {
  const [projects, setProjects] = React.useState([project]);
  Object.assign(window, {
    publishContract: (currentCommands: boolean) =>
      setProjects([{ ...project, desktopCapabilities: { currentCommands } }]),
    publishOutcome: () => {
      const requestId = fixture.calls.find((call) => call.name === "create")!.params.requestId;
      setProjects([
        {
          ...project,
          worktreeOperations: [{ requestId, state: "missing" }],
          outcomes: { [requestId]: completedOutcome(requestId) },
        },
      ]);
    },
  });
  return (
    <ApplicationIntlProvider>
      <div style={{ height: "100vh", display: "flex" }}>
        <TaskCenter
          projects={projects}
          connected
          action={action as Action}
          onOpenThread={(projectId, threadId) => fixture.opened.push({ projectId, threadId })}
          onOpenModelSettings={() => {}}
          navigation={null}
          renderConversation={() => <p>会话详情</p>}
          renderResources={() => null}
        />
      </div>
    </ApplicationIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
