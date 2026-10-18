import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";
import { SpaceReclamation } from "./SpaceReclamation.js";
import type { Action } from "../services.js";

type Resource = { id: string; threadId: string; executable: string; state: string; stale: boolean };
type Project = { projectId: string; root: string; started: boolean; restartSafe?: boolean; resources?: Resource[];
  activeThreads?: { threadId: string; turnId: string }[]; goalThreads?: string[]; activeTasks?: number;
  goals?: { threadId: string; status: string; objective: string }[];
  tasks?: { id: string; threadId: string; mode: string; objective: string; paused: boolean; nextRunAt?: number; running: boolean }[];
  unresolvedTools?: number; compactions?: number; workgroups?: number;
  queues?: { threadId: string; paused: boolean; pending: number; running: number }[];
  pendingRequests?: { threadId?: string; awaitingResponse: boolean }[] };
type Status = { connected: boolean; clients: number; busy: boolean; activeCommands: number; starting: number; providerUpdating: boolean; projects: Project[] };

export function ServiceStatusSettings({ connected, action, onConnect, onOpen, onTask }: {
  connected: boolean; action: Action; onConnect: () => Promise<void>;
  onTask: (projectId: string, taskId: string) => void;
  onOpen: (projectId: string, threadId: string, panel?: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null), [checkedAt, setCheckedAt] = useState("");
  const [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(""), [actionError, setActionError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), locked = useRef(false), inflight = useRef<Promise<void> | null>(null);
  const read = useCallback(() => {
    if (!connected) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const ticket = generation.current; setReading(true);
    const pending = (async () => {
      try {
        const result: Status = await action("serviceStatus");
        if (ticket === generation.current) { setStatus(result); setReadError(""); setCheckedAt(new Date().toLocaleTimeString()); }
      } catch (cause) { if (ticket === generation.current) setReadError(`后台状态读取失败，上次结果可能已过期。${(cause as Error).message}`); }
      finally { if (ticket === generation.current) setReading(false); inflight.current = null; }
    })();
    inflight.current = pending; return pending;
  }, [action, connected]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (!locked.current) await read(); if (live) timer = setTimeout(poll, 2000); };
    void poll();
    return () => { live = false; generation.current++; clearTimeout(timer); };
  }, [read]);
  const blocked = !status || status.busy || status.providerUpdating || status.starting > 0 || status.projects.some(p => p.started && !p.restartSafe);
  const run = async (operation: "stopService" | "recoverResources" | "connect") => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setActionError(""); setNotice("");
    let stopped = false;
    try {
      await inflight.current; // Finish this page's read before the native stop fence.
      if (operation === "connect") await onConnect();
      else {
        const result = await action(operation);
        if (operation === "stopService") { stopped = result.stopped === true; setNotice(result.canceled ? "已取消停止" : "后台进程已停止"); }
      }
    } catch (cause) { setActionError((cause as Error).message); }
    finally {
      locked.current = false; setBusy(false);
      // A successful stop must stay stopped. Reads never call connectService.
      if (!stopped) await read();
    }
  };
  return <div className="settings-sections" aria-label="后台服务管理">
    <SettingsSection title="共享后台" description="查看工作区的执行与资源状态。关闭窗口会保留后台；停止服务会断开连接此服务的所有窗口。"
      action={<Button variant="outline" size="sm" disabled={busy} onClick={() => void read()}>刷新后台状态</Button>}>
      <SettingsGroupCard>
        <SettingsRow label={connected ? "后台已连接" : "后台未连接"} description={connected && status ? `${status.clients} 个客户端连接 · ${status.activeCommands} 个处理中请求` : "可以显式连接后台，恢复任务历史。刷新此页不会启动后台。"}
          control={connected ? <Button variant="outline" size="sm" disabled={busy || !!readError || blocked} onClick={() => void run("stopService")}>停止后台服务</Button> : <Button size="sm" disabled={busy} onClick={() => void run("connect")}>连接后台</Button>} />
        <SettingsRow label="资源检查与恢复" description="当前资源通过 Runtime 关闭。旧 Runtime 的清理确认仍需在系统对话框中核实，不改写历史执行结果。"
          control={<Button variant="outline" size="sm" disabled={busy || !connected || !!readError || !status} onClick={() => void run("recoverResources")}>检查并处理资源</Button>} />
      </SettingsGroupCard>
      <p role="status" className="settings-section-desc">{busy ? "正在处理…" : reading ? "检查中…" : checkedAt ? `上次检查：${checkedAt}${!connected || readError ? "（可能已过期）" : ""}` : "尚未检查"}</p>
      <p className="settings-section-desc">连接后请核查实际状态；已暂停的目标、调度和队列需分别恢复。</p>
      {notice && <p role="status">{notice}</p>}
      {readError && <p role="alert" className="text-destructive">{readError}</p>}
      {actionError && <p role="alert" className="text-destructive">{actionError}</p>}
      {connected && status && <p className="settings-section-desc">{blocked ? "还有执行或资源需要处理，完成后再停止。" : "检查时未发现停止阻塞；确认停止时会重新检查。"} 已暂停的待发送消息会保留。</p>}
      {status?.providerUpdating && <p role="status">模型配置正在更新。</p>}
      {!!status?.starting && <p role="status">{status.starting} 个工作区正在启动。</p>}
    </SettingsSection>
    {status?.projects.map(project => <SettingsSection key={project.projectId} title={project.root.split(/[\\/]/).filter(Boolean).at(-1)} description={project.root}>
      <div data-testid={`service-project-${project.projectId}`}>
        <SettingsGroupCard>
          <SettingsRow label={!project.started ? "工作区尚未启动" : project.restartSafe ? "Core 资源检查通过" : "Core 仍有待处理事项"}
            description={!project.started ? "本页不会为读取状态而启动工作区。" : `活动轮次 ${project.activeThreads?.length ?? 0} · 持续目标 ${project.goalThreads?.length ?? 0} · 任务 ${project.activeTasks ?? 0}`}
            control={<span className="text-foreground-subtle">{project.resources?.length ?? 0} 个未清理资源</span>} />
          {project.activeThreads?.map(turn => <div key={turn.turnId} data-testid={`service-active-${turn.threadId}`}><SettingsRow label="正在执行" description={`会话 ${turn.threadId}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, turn.threadId)}>打开对话</Button>} /></div>)}
          {(project.goals ?? project.goalThreads?.map(threadId => ({ threadId, status: "active", objective: "持续目标" })))?.map(goal => <div key={goal.threadId} data-testid={`service-goal-${goal.threadId}`}><SettingsRow label={goal.objective} description={`持续目标 · ${{ active: "活动中", paused: "已暂停", budgetLimited: "已达预算限制", blocked: "受阻" }[goal.status] ?? goal.status}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, goal.threadId, "编辑目标")}>查看目标</Button>} /></div>)}
          {project.tasks?.map(task => <div key={task.id} data-testid={`service-task-${task.id}`}><SettingsRow label={task.objective} description={`${task.mode === "scheduled" ? "定时任务" : "后台任务"} · ${task.paused ? "已暂停，需要手动恢复" : task.running ? "执行中" : task.nextRunAt ? `下次运行 ${new Date(task.nextRunAt * 1000).toLocaleString()}` : "当前未执行"}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onTask(project.projectId, task.id)}>查看任务</Button>} /></div>)}
          {project.queues?.map(queue => <SettingsRow key={queue.threadId} label={queue.paused ? "队列已暂停" : "队列可执行"} description={`待发送 ${queue.pending} · 执行中 ${queue.running}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, queue.threadId, "队列")}>查看队列</Button>} />)}
          {project.pendingRequests?.map((request, index) => <SettingsRow key={index} label={request.awaitingResponse ? "请求等待回应" : "操作结果待确认"} description="不会自动重发；请在所属对话检查发送状态。" control={request.threadId ? <Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, request.threadId!)}>打开对话</Button> : <span>项目操作</span>} />)}
          {project.resources?.map(resource => <div key={resource.id} data-testid={`service-resource-${resource.id}`}><SettingsRow label={resource.executable || "受管进程"} description={resource.stale ? "属于旧 Runtime，需要核实清理状态" : "资源尚未确认清理"} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, resource.threadId, "进程")}>查看进程</Button>} /></div>)}
        </SettingsGroupCard>
        {project.started && <SpaceReclamation key={project.projectId} projectId={project.projectId} action={action} disabled={busy || !connected} onChange={read} />}
        {!!project.unresolvedTools && <p role="status">{project.unresolvedTools} 项工具执行结果待确认。</p>}
        {!!project.compactions && <p role="status">{project.compactions} 项上下文压缩进行中。</p>}
        {!!project.workgroups && <p role="status">{project.workgroups} 个子任务组尚未结算。</p>}
      </div>
    </SettingsSection>)}
    {status && !status.projects.length && <p className="settings-section-desc">尚未添加工作区。</p>}
  </div>;
}
