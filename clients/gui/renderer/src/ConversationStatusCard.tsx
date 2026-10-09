import { useEffect, useRef, useState } from "react";
import { processItems, toolPresentation } from "./conversationPresentation.js";
import { ReviewPanelIcon, TerminalPanelIcon, DocumentPanelIcon } from "./app-shell/panelIcons.js";
import { AgentsPane } from "./AgentsPane.js";
import { SentAttachment } from "./MessageAttachment.js";
import { verifiedFileReceipts } from "./TurnFileSummary.js";
import { ProjectFolderIcon } from "./homeChromeIcons.js";
import { ActivityIcon } from "./ActivityIcon.js";
import type { Action, Data } from "./services.js";
import "./AgentResources.css";

/** 只展示已有权威资源；工具流水仍归对话信息流。 */
export function ConversationStatusCard({ project, thread, action, onPanel, onAgent, onFile, selectedAgent }: {
  project: Data; thread: Data; action: Action; onPanel: (name: string) => void;
  onAgent: (id: string) => void; onFile: (path: string) => void;
  selectedAgent?: string;
}) {
  const [git, setGit] = useState<Data>({ loading: true });
  const [processes, setProcesses] = useState<Data[]>([]);
  const [processError, setProcessError] = useState("");
  const [revision, refresh] = useState(0);
  const request = useRef(action); request.current = action;
  const turn = thread.turns?.at(-1);
  const tools = processItems(turn?.items ?? [], turn?.status).filter((item: Data) => item.type === "dynamicToolCall" && !item.processOwnerId);
  const checkpoint = JSON.stringify([turn?.id, turn?.status, tools.filter((item: Data) => !toolPresentation(item).running && !item.processUnsettled).map((item: Data) => item.id)]);
  const connected = !!project.state?.connected;
  useEffect(() => {
    if (!connected) return;
    let live = true;
    setGit(previous => ({ ...previous, loading: true }));
    void (async () => {
      try {
        const info = await request.current("workspace", { projectId: project.id, operation: "info" });
        const review = info.git !== false && info.head ? await request.current("workspace", { projectId: project.id, operation: "review", scope: "unstaged" }) : undefined;
        if (live) setGit({ info, review });
      } catch (cause) { if (live) setGit({ error: (cause as Error).message }); }
    })();
    return () => { live = false; };
  }, [project.id, thread.id, connected, checkpoint, revision]);
  useEffect(() => {
    if (!connected || project.core?.features?.processes === false) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await request.current("manage", { projectId: project.id, threadId: thread.id, operation: "processes" });
        if (live) { setProcesses(value.data); setProcessError(""); }
      } catch (cause) { if (live) setProcessError((cause as Error).message); }
      if (live) timer = setTimeout(read, 2000);
    };
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [project.id, thread.id, connected, revision, project.core?.features?.processes]);
  const files: Data[] = git.review?.files ?? [];
  const sources = [...verifiedFileReceipts((thread.turns ?? []).flatMap((turn: Data) => (turn.items ?? []).filter((item: Data) => item.tool === "fs_read"))).values()];
  const attachments: Data[] = [...new Map<string, Data>((thread.turns ?? []).flatMap((turn: Data) => (turn.items ?? []).filter((item: Data) => item.type === "userMessage").flatMap((item: Data) => (item.content ?? []).filter((part: Data) => ["image", "audio", "file"].includes(part.type) && typeof (part.url ?? part.uri) === "string")).map((part: Data) => [part.url ?? part.uri, part] as [string, Data]))).values()];
  const total = (key: string) => files.reduce((sum, file) => sum + (file[key] ?? 0), 0);
  const workspaceName = project.name || project.root.split(/[\\/]/).pop();
  return <section className="task-resources" role="region" aria-label="任务资源">
    <div className="task-resources-header"><h2 title={project.root}>{workspaceName}</h2><button className="icon-button" aria-label="刷新任务资源" title="刷新任务资源" disabled={!connected || git.loading} onClick={() => refresh(n => n + 1)}><ProjectFolderIcon /></button></div>
    {!connected && <p role="status" className="task-resource-note">连接不可用，资源可能已过期。</p>}
    {git.error && <p role="alert" className="task-resource-note">工作区改动读取失败：{git.error}</p>}
    {git.review && <section className="task-resources-section task-resources-changes" aria-label="工作区变更">
      <button type="button" className="task-resource-row" onClick={() => onPanel("改动")}><ReviewPanelIcon /><span className="task-resource-label">变更</span><small>{files.length} 个文件</small><span className="diff-count"><b>+{total("additions")}</b><em>−{total("deletions")}</em></span><ActivityIcon kind="chevron" size={14} /></button>
    </section>}
    <AgentsPane key={`${project.id}:${thread.id}`} project={project} thread={thread} action={action} onOpen={onAgent} compact selectedAgent={selectedAgent} />
    {processError && <p role="alert" className="task-resource-note">后台进程读取失败：{processError}</p>}
    {processes.length > 0 && <section className="task-resources-section" aria-label="后台进程">
      <h3 className="task-resources-heading"><span>后台进程</span><span>{processes.filter(process => ["running", "accepted"].includes(process.state)).length} 个运行中</span></h3>
      {processes.map(process => <button type="button" key={process.id} className="task-resource-row" onClick={() => onPanel("进程")} title={process.id}><TerminalPanelIcon /><span className="task-resource-agent-body"><span>{({ accepted: "已受理", running: "运行中", failed: "启动失败", closed: "已关闭", unknown: "待确认" } as Record<string, string>)[process.state] ?? process.state}</span><small className="task-resource-description">{process.argv?.join(" ") || process.id}</small></span><ActivityIcon kind="chevron" size={14} /></button>)}
    </section>}
    {sources.length + attachments.length > 0 && <section className="task-resources-section" aria-label="来源">
      <h3 className="task-resources-heading"><span>来源</span><span>{sources.length + attachments.length}</span></h3>
      {attachments.map(part => <SentAttachment key={part.url ?? part.uri} part={part} projectId={project.id} threadId={thread.id} action={action} compact />)}
      {sources.map(source => <button type="button" key={source.path} className="task-resource-row" onClick={() => onFile(source.path)} title={source.path}><DocumentPanelIcon /><span className="task-resource-agent-body"><span>{source.path.split("/").at(-1)}</span><small className="task-resource-description">{source.path}</small></span><ActivityIcon kind="chevron" size={14} /></button>)}
    </section>}
  </section>;
}
