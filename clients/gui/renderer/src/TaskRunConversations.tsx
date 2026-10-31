import { describeMoment } from "./scheduleText.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useRef, useState } from "react";
import { ApprovalRequest } from "./ApprovalRequest.js";
import { AskUserQuestion } from "./AskUserQuestion.js";
import { Button } from "./components/ui/button.js";
import type { Action, Data } from "./services.js";
import type { TaskConversationRenderer } from "./TaskDraft.js";

export const scheduleZone = (task: Data) =>
  task.scheduleV2?.rule?.timeZone ?? task.schedule?.timeZone;
export const runZone = (run: Data, task: Data) =>
  run.acceptedSchedule
    ? (run.acceptedSchedule.scheduleV2?.rule?.timeZone ??
      run.acceptedSchedule.schedule?.timeZone ??
      "UTC")
    : scheduleZone(task);

const statuses: Record<string, string> = {
  queued: "已受理，等待开始",
  running: "运行中",
  waitingForInput: "等待回答",
  waitingForAgents: "等待 worker",
  paused: "已暂停",
  blocked: "受阻",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};
// Core 的结算原因码换成用户能读懂的说明；未知原因原样显示。
const runReasons: Record<string, string> = {
  serverRestarted: "后台重启时中断，已记为失败，下次按计划继续",
  hostUnavailable: "桌面端离线时中断，已记为失败，下次按计划继续",
  supersededBySchedule: "到下一次计划时仍未继续，已记为失败",
  goalMissingOrReplaced: "执行目标已丢失，已记为失败",
  stopRequested: "已请求停止",
};
type ReadState = { status: "loading" | "ready" | "error"; error?: string };

export function TaskRunConversations({
  project,
  task,
  action,
  disabled,
  renderConversation,
}: {
  project: Data;
  task: Data;
  action: Action;
  disabled: boolean;
  renderConversation: TaskConversationRenderer;
}) {
  const { t } = useI18n();
  // Core 的 runs 已按运行顺序排列；只去重，不重排或修改来源历史。
  const runs = [
    ...new Map<string, Data>((task.runs ?? []).map((run: Data) => [run.id, run])).values(),
  ];
  const threadIds = [
    ...new Set<string>(runs.flatMap((run) => (run.threadId ? [run.threadId] : []))),
  ];
  const connected = !!project.state?.connected;
  const connection = useRef({ connected, epoch: 0 });
  if (connection.current.connected !== connected)
    connection.current = { connected, epoch: connection.current.epoch + 1 };
  const scope = JSON.stringify([
    project.id,
    task.id,
    project.core?.instanceId,
    project.core?.connectionGeneration,
    connection.current.epoch,
  ]);
  const [reads, setReads] = useState<Record<string, ReadState>>({});
  const attempted = useRef(new Set<string>());
  const reading = useRef(false);
  const latest = useRef({ scope, threadIds });
  latest.current = { scope, threadIds };
  const key = (threadId: string) => JSON.stringify([scope, threadId]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    const hydrate = async () => {
      if (!live || reading.current) return;
      reading.current = true;
      try {
        while (live && latest.current.scope === scope) {
          const threadId = latest.current.threadIds.find(
            (id) => !attempted.current.has(JSON.stringify([scope, id])),
          );
          if (!threadId) break;
          const id = JSON.stringify([scope, threadId]);
          attempted.current.add(id);
          setReads((previous) => ({ ...previous, [id]: { status: "loading" } }));
          try {
            // open 只观察执行会话，不导航，也不恢复执行；已有 taskWatch 保持不变。
            await action("open", { projectId: project.id, threadId });
            if (live) setReads((previous) => ({ ...previous, [id]: { status: "ready" } }));
          } catch (cause) {
            if (live)
              setReads((previous) => ({
                ...previous,
                [id]: {
                  status: "error",
                  error: cause instanceof Error ? cause.message : String(cause),
                },
              }));
          } finally {
            if (!live) attempted.current.delete(id);
          }
        }
      } finally {
        reading.current = false;
      }
    };
    void hydrate();
    // 仅扫描新出现的 threadId；每个连接代际只读一次，失败由用户重试。
    const timer = window.setInterval(() => void hydrate(), 500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [action, connected, project.id, scope]);

  return (
    <section aria-label="定时任务执行记录" className="grid gap-6 pt-4">
      <h3>执行记录</h3>
      {!runs.length && <p role="status">尚未运行</p>}
      {runs.map((run) => {
        const thread = project.state?.threads?.[run.threadId];
        const read = run.threadId ? reads[key(run.threadId)] : undefined;
        const interactions = project.state?.interactions?.[run.threadId];
        const readOnly =
          disabled || !connected || read?.status !== "ready" || !!thread?.desktop?.archived;
        const pending = (interactions?.data ?? []).filter(
          (item: Data) => item.status === "pending" && item.threadId === run.threadId,
        );
        const decisionAction: Action = (name, params) => {
          if (
            readOnly ||
            interactions?.error ||
            !("threadId" in params) ||
            params.threadId !== run.threadId ||
            !("projectId" in params) ||
            params.projectId !== project.id
          )
            return Promise.reject(new Error("当前执行记录只读，请先确认会话状态。"));
          if (
            name === "respond" ||
            (name === "manage" && "operation" in params && params.operation === "interactions")
          )
            return action(name, params);
          return Promise.reject(new Error("执行记录不支持该操作。"));
        };
        return (
          <article
            key={run.id}
            data-task-run-id={run.id}
            className="grid min-w-0 gap-2 border-t border-border pt-4"
          >
            <header className="flex flex-wrap justify-between gap-2" title={run.id}>
              <h4>
                {run.scheduledAt == null
                  ? "—"
                  : describeMoment(run.scheduledAt, t, runZone(run, task))}
              </h4>
              <span role="status">{statuses[run.status] ?? run.status}</span>
            </header>
            <p className="text-foreground-subtle" data-run-trigger={run.trigger ?? "scheduled"}>
              {run.trigger === "manual"
                ? t("operations.manual")
                : t("operations.schedules.sentBySchedule")}
            </p>
            {run.reason && (
              <p className="whitespace-pre-wrap">
                运行原因：{runReasons[run.reason] ?? run.reason}
              </p>
            )}
            {!run.threadId ? (
              <p>本次运行没有执行会话。</p>
            ) : (
              <>
                {!connected && (
                  <p role="status">连接中断，显示上次读取的执行记录；恢复连接后会重新读取。</p>
                )}
                {connected && (!read || read.status === "loading") && (
                  <p role="status">正在读取执行会话…</p>
                )}
                {(read?.status === "error" || (read?.status === "ready" && !thread)) && (
                  <p role="alert">
                    执行会话读取失败：{read.error ?? "未收到执行会话投影"}。运行状态仍保留。
                    <Button
                      variant="ghost"
                      disabled={!connected}
                      onClick={() => {
                        attempted.current.delete(key(run.threadId));
                        setReads((previous) => ({
                          ...previous,
                          [key(run.threadId)]: { status: "loading" },
                        }));
                      }}
                    >
                      重新读取
                    </Button>
                  </p>
                )}
                {thread &&
                  renderConversation(
                    readOnly
                      ? { ...project, state: { ...project.state, connected: false } }
                      : project,
                    thread,
                    undefined,
                    { embedded: true, readOnly },
                  )}
                {interactions?.error && <p role="alert">交互读取失败：{interactions.error}</p>}
                {!!pending.length && (
                  <fieldset
                    disabled={readOnly || !!interactions?.error}
                    className="grid min-w-0 gap-2"
                  >
                    {pending.map((item: Data) =>
                      item.kind === "approval" ? (
                        <ApprovalRequest
                          key={item.id}
                          item={item}
                          projectId={project.id}
                          action={decisionAction}
                        />
                      ) : (
                        <AskUserQuestion
                          key={item.id}
                          item={item}
                          projectId={project.id}
                          action={decisionAction}
                        />
                      ),
                    )}
                  </fieldset>
                )}
                {readOnly &&
                  !["completed", "failed", "cancelled", "skipped"].includes(run.status) && (
                    <p role="status">当前执行记录只读；连接与会话读取确认后才能回答或审批。</p>
                  )}
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
