import type { MessageId } from "../i18n/messages.js";

// 用户能看到的状态只有下面几种。视图从这里取状态和文字，不直接读 Host/Core/Run 的内部字段。
// 新的内部状态先决定落到哪一种用户状态，再改这里；不要在视图里加分支。

type Data = Record<string, any>;

/** 项目：能不能用、是否正在打开、是否需要升级、打不开。 */
export type ProjectUserState = {
  kind: "ready" | "opening" | "needsUpgrade" | "unavailable";
  message: MessageId;
  /** 现在就能发起需要项目在线的操作。 */
  canAct: boolean;
};

export function projectUserState(project: Data | undefined): ProjectUserState {
  const state = project?.state;
  const canAct = state?.connected === true;
  if (canAct) return { kind: "ready", message: "userState.project.ready", canAct };
  switch (state?.hostState) {
    case "legacyPending":
      return { kind: "needsUpgrade", message: "userState.project.needsUpgrade", canAct };
    case "unavailable":
      return { kind: "unavailable", message: "userState.project.unavailable", canAct };
    // 项目按需启动：已停止对用户来说就是可用，发起操作时自动打开。
    case "ready":
    case "stopped":
      return { kind: "ready", message: "userState.project.ready", canAct };
    default:
      return { kind: "opening", message: "userState.project.opening", canAct };
  }
}

/** 对话：空闲、正在回复、等你处理、出错。 */
export type ConversationUserState = {
  kind: "idle" | "working" | "needsYou" | "failed";
  message: MessageId;
};

export function conversationUserState(
  project: Data | undefined,
  threadId: string,
  thread: Data | undefined,
): ConversationUserState {
  const live = project?.state?.connected === true;
  const needsYou =
    live &&
    (project?.state?.interactions?.[threadId]?.data ?? []).some(
      (item: Data) => item.status === "pending",
    );
  if (needsYou) return { kind: "needsYou", message: "userState.conversation.needsYou" };
  const turns: Data[] = thread?.turns ?? [];
  if (live && turns.some((turn) => turn.status === "inProgress"))
    return { kind: "working", message: "userState.conversation.working" };
  if (turns.at(-1)?.status === "failed")
    return { kind: "failed", message: "userState.conversation.failed" };
  return { kind: "idle", message: "userState.conversation.idle" };
}

/** 任务：等待下次运行、运行中、等你处理、已暂停、已结束、失败。 */
export type TaskUserState = {
  kind: "scheduled" | "running" | "needsYou" | "paused" | "finished" | "failed";
  message: MessageId;
};

const terminalRun = (run?: Data) =>
  !!run && ["completed", "failed", "cancelled"].includes(run.status);

export function taskUserState(task: Data): TaskUserState {
  const run: Data | undefined = task.latestRun ?? task.runs?.at(-1);
  const state = (kind: TaskUserState["kind"]): TaskUserState => ({
    kind,
    message: `userState.task.${kind}`,
  });
  if (task.cancelled) return state("finished");
  const missed =
    task.lastTriggerDecision?.outcome?.kind === "missedWindow" &&
    task.nextRunAt == null &&
    !(task.hasUnsettledWork ?? task.runs?.some((item: Data) => !terminalRun(item)));
  if (missed) return state("failed");
  const finished = terminalRun(run) && task.nextRunAt == null;
  if (finished) return state(run?.status === "failed" ? "failed" : "finished");
  if (task.paused || run?.status === "paused") return state("paused");
  switch (run?.status) {
    case "waitingForInput":
    case "blocked":
      return state("needsYou");
    case "queued":
    case "running":
    case "waitingForAgents":
      return state("running");
    case "failed":
      return state("failed");
    default:
      return state("scheduled");
  }
}
