import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { ChannelQuestion, pendingChannelQuestions } from "./TaskCenter.js";
import type { Action, Data } from "./services.js";

const cacheKey = "areal-gui:inbox-cache";
const hasDraft = (row: Data) => {
  const owner = `${row.projectId}:${row.taskId}:${row.message.runId}:${row.message.id}`;
  try { return Object.values(JSON.parse(localStorage.getItem(`areal-gui:channel-reply:${owner}`) ?? localStorage.getItem(`areal-gui:channel-reply:${row.projectId}:${row.taskId}:${row.message.id}`) ?? "{}")).some(value => typeof value === "string" && value.length > 0) || localStorage.getItem(`areal-gui:channel-pending:${owner}`) !== null; } catch { return false; }
};
const cachedRows = (projects: Data[]): Data[] => {
  try { return JSON.parse(localStorage.getItem(cacheKey) ?? "[]").filter((row: Data) => projects.some(project => project.id === row.projectId) && typeof row.taskId === "string" && typeof row.message?.id === "string" && typeof row.message.runId === "string" && Array.isArray(row.message.questions)).map((row: Data) => ({ ...row, cached: true })); } catch { return []; }
};
const identity = (row: Data) => `${row.projectId}:${row.taskId}:${row.message.runId}:${row.message.id}`;

/** A rebuildable projection of the original channels, never an execution owner. */
export function Inbox({ projects, connected, action, onClose }: { projects: Data[]; connected: boolean; action: Action; onClose: () => void }) {
  const [rows, setRows] = useState<Data[]>(() => cachedRows(projects));
  const latest = useRef(rows); latest.current = rows;
  const [errors, setErrors] = useState<Data[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [hasMore, setHasMore] = useState(false);
  const owners = useRef(projects); owners.current = projects;
  const pages = useRef(1), sequence = useRef(0), reading = useRef(false);
  const refresh = useCallback(async (more = false) => {
    if (reading.current || !connected) return;
    if (more) pages.current++;
    reading.current = true; setBusy(true); const request = ++sequence.current;
    try {
      const result = await action("tasks", { operation: "inbox", limit: Math.min(1024, pages.current * 30) });
      if (request !== sequence.current) return;
      const failed = new Set(result.errors.map((failure: Data) => failure.projectId));
      const live = new Map<string, Data>(result.data.map((row: Data) => [identity(row), { ...row, cached: false }]));
      const retained = new Map<string, Data>([...latest.current, ...pendingChannelQuestions(owners.current)].map(row => [identity(row), row]));
      const channels = new Map<string, Promise<Data[]>>();
      await Promise.all([...retained].map(async ([id, row]) => {
        if (live.has(id) || !owners.current.some(project => project.id === row.projectId)) return;
        if (failed.has(row.projectId)) { live.set(id, { ...row, cached: true }); return; }
        if (!hasDraft(row)) return;
        const owner = `${row.projectId}:${row.taskId}`;
        if (!channels.has(owner)) channels.set(owner, (async () => {
          const targets = [...retained.values()].filter(item => item.projectId === row.projectId && item.taskId === row.taskId && hasDraft(item));
          const messages: Data[] = []; let afterSequence = Math.max(0, Math.min(...targets.map(item => item.message.sequence ?? 1)) - 1);
          for (;;) {
            const page = await action("manage", { projectId: row.projectId, operation: "taskChannel", taskId: row.taskId, afterSequence, limit: 100 });
            messages.push(...page.data);
            if (!page.hasMore || targets.every(target => messages.some(message => message.id === target.message.id && message.runId === target.message.runId))) return messages;
            if (page.nextSequence <= afterSequence) throw new Error("频道读取未前进");
            afterSequence = page.nextSequence;
          }
        })());
        try {
          const messages = await channels.get(owner)!;
          const question = messages.find(message => message.id === row.message.id && message.runId === row.message.runId && message.kind === "question");
          live.set(id, { ...row, message: question ?? row.message, cached: !question });
        } catch { live.set(id, { ...row, cached: true }); }
      }));
      if (request !== sequence.current) return;
      const next = [...live.values()]; latest.current = next; setRows(next); localStorage.setItem(cacheKey, JSON.stringify(next));
      setErrors(result.errors); setError(""); setLoaded(true); setHasMore(result.hasMore);
    } catch (cause) { if (request === sequence.current) setError((cause as Error).message); }
    finally { reading.current = false; if (request === sequence.current) setBusy(false); }
  }, [action, connected]);
  const projectIds = projects.map(project => project.id).join(":");
  useEffect(() => {
    const allowed = new Set(owners.current.map(project => project.id));
    // A new connection cannot make the previous connection's read current.
    const previous: Data[] = connected ? latest.current : latest.current.map(row => ({ ...row, cached: true }));
    const restored = new Map([...cachedRows(owners.current), ...previous].filter(row => allowed.has(row.projectId)).map(row => [identity(row), row]));
    latest.current = [...restored.values()]; setRows(latest.current);
    void refresh(); const timer = window.setInterval(() => void refresh(), 3000);
    return () => { sequence.current++; window.clearInterval(timer); };
  }, [refresh, projectIds]);
  return <section aria-label="全局 Inbox" className="flex min-h-0 flex-1 flex-col text-ui-base">
    <header className="flex items-center gap-3 border-b border-border p-3"><Button variant="ghost" size="icon-sm" aria-label="返回对话" onClick={onClose}><ArrowLeft size={16} /></Button><h1 className="flex-1 font-medium">Inbox</h1><Button variant="ghost" size="sm" disabled={!connected || busy} onClick={() => void refresh()}>刷新 Inbox</Button></header>
    <div className="min-h-0 flex-1 overflow-auto p-4"><div className="mx-auto grid max-w-3xl gap-3">
      {!connected && <p role="alert">连接已断开，显示上次读取的问题；重新连接后才能回答。</p>}
      {error && <p role="alert">读取失败：{error}</p>}
      {errors.map(failure => <p role="alert" key={failure.projectId}>{failure.projectName}：{failure.message}。保留上次读取的问题，刷新后重试。</p>)}
      {connected && !loaded && !error && !errors.length && <p>正在读取待回答问题…</p>}
      {loaded && connected && !error && !errors.length && !rows.length && <p>没有待回答的问题</p>}
      {rows.map(row => {
        const project = projects.find(project => project.id === row.projectId);
        return <ChannelQuestion key={identity(row)} row={row} projectId={row.projectId} action={action} freshness={connected && project?.state?.connected && !error && !row.cached && !errors.some(failure => failure.projectId === row.projectId) ? "live" : "cached"} disabled={!connected || !project?.state?.connected || !!error || row.cached || errors.some(failure => failure.projectId === row.projectId)} onReplied={() => void refresh()} />;
      })}
      {hasMore && <Button variant="outline" disabled={busy || !connected || pages.current * 30 >= 1024} onClick={() => void refresh(true)}>{pages.current * 30 >= 1024 ? "问题过多，请先处理已显示的问题" : "更多问题"}</Button>}
    </div></div>
  </section>;
}
