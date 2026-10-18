import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import type { Action, Data } from "./services.js";

type Message = { role: string; text: string; toolCalls: { id: string; function: { name: string; arguments: string } }[] | null; toolCallId: string | null; media: string[]; opaqueProviderContextOmitted: boolean };
type Context = { offset: number; nextOffset: number | null; instructionSnapshot: string | null; data: Message[]; checkpoint: { summary: string; compactions: number; totalDurationMs: number; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } } | null };
const roles: Record<string, string> = { user: "用户", assistant: "助手", tool: "工具结果", system: "系统" };
const mediaLabels: Record<string, string> = { image: "图片", audio: "音频", file: "文件" };
const pageSize = 8;

export function ContextPane({ project, thread, action }: { project: Data; thread: Data; action: Action }) {
  const [context, setContext] = useState<Context | null>(null);
  const [busy, setBusy] = useState(false), [compacting, setCompacting] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const sequence = useRef(0), locked = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const lastTurn = thread.turns?.at(-1);
  const version = `${thread.turns?.length ?? 0}:${lastTurn?.id ?? ""}:${lastTurn?.status ?? ""}`;
  const currentVersion = useRef(version); currentVersion.current = version;
  const [readVersion, setReadVersion] = useState("");
  const read = useCallback(async (offset: number) => {
    const id = ++sequence.current; setBusy(true); setError("");
    const startedVersion = currentVersion.current;
    try {
      const result: Context = await action("manage", { projectId: project.id, threadId: thread.id, operation: "context", offset, limit: pageSize });
      if (sequence.current === id) { setContext(result); setReadVersion(startedVersion); content.current?.scrollTo(0, 0); }
    } catch (cause) { if (sequence.current === id) setError((cause as Error).message); }
    finally { if (sequence.current === id) setBusy(false); }
  }, [action, project.id, thread.id]);
  useEffect(() => { void read(0); return () => { sequence.current++; }; }, [read]);
  const unavailable = !project.state?.connected || project.pending?.some((p: Data) => p.params?.threadId === thread.id);
  const active = thread.turns?.some((t: Data) => t.status === "inProgress") || thread.goals?.goal?.status === "active";
  const compact = async () => {
    if (locked.current || busy || unavailable || active || thread.desktop?.archived) return;
    locked.current = true; setCompacting(true); setBusy(true); setError(""); setNotice("");
    const id = ++sequence.current;
    try {
      const result: Context = await action("manage", { projectId: project.id, threadId: thread.id, operation: "contextCompact" });
      if (sequence.current !== id) return;
      setNotice((result.checkpoint?.compactions ?? 0) > (context?.checkpoint?.compactions ?? 0) ? "压缩完成，原始对话保留。" : "当前历史无需进一步压缩。");
      await read(0);
    } catch (cause) { if (sequence.current === id) setError(`压缩未确认，请刷新检查结果。${(cause as Error).message}`); }
    finally { locked.current = false; if (sequence.current === id || sequence.current === id + 1) { setBusy(false); setCompacting(false); } }
  };
  return <section className="flex h-full min-h-0 flex-col text-ui-base" aria-label="上下文">
    <div className="panel-toolbar flex shrink-0 items-center justify-between gap-2">
      <span className="text-foreground-subtle">{compacting ? "压缩中…" : busy ? "读取中…" : "上下文检查"}</span>
      <div className="flex gap-1"><Button size="sm" variant="ghost" disabled={busy || unavailable} onClick={() => void read(0)}>刷新</Button><Button size="sm" variant="ghost" disabled={busy || unavailable || active || thread.desktop?.archived || !context} onClick={() => void compact()}>压缩上下文</Button></div>
    </div>
    <div ref={content} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" aria-busy={busy}>
      <div><h3 className="font-medium">下一次请求的历史投影</h3><p className="mt-1 text-foreground-subtle">这里展示 Core 当前保留的消息与压缩摘要。工具定义、供应商私有上下文及下次请求配置不完整呈现在此。</p></div>
      {active && <p className="text-foreground-subtle">运行与目标停止后可以手动压缩；压缩会调用当前模型生成摘要。</p>}
      {context && readVersion !== version && <p role="status">对话已更新，刷新以查看最新上下文。</p>}
      {error && <p role="alert" className="text-destructive">{error}{context && " 当前仍显示上次读取的内容。"}</p>}
      {notice && <p role="status">{notice}</p>}
      {context?.checkpoint && <details open className="rounded-control border border-border p-2"><summary>已压缩 {context.checkpoint.compactions} 次</summary><p className="my-2 whitespace-pre-wrap break-words">{context.checkpoint.summary}</p><p className="text-foreground-subtle">累计 {(context.checkpoint.totalDurationMs / 1000).toFixed(1)} 秒 · 输入 {context.checkpoint.usage.inputTokens.toLocaleString()} / 输出 {context.checkpoint.usage.outputTokens.toLocaleString()} Token</p></details>}
      {context?.instructionSnapshot && <details><summary>最近一轮的指令快照</summary><p className="mt-2 whitespace-pre-wrap break-words">{context.instructionSnapshot}</p></details>}
      {context?.data.map((message, index) => <article key={`${context.offset}:${index}`} className="border-t border-border pt-2">
        <h4 className="mb-1 font-medium">{context.offset + index + 1}. {roles[message.role] ?? message.role}</h4>
        {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
        {message.toolCalls?.map(call => <details key={call.id}><summary>工具调用：{call.function.name}</summary><pre className="whitespace-pre-wrap break-words">{call.function.arguments}</pre></details>)}
        {message.toolCallId && <p className="break-all text-foreground-subtle">调用 ID：{message.toolCallId}</p>}
        {!!message.media.length && <p className="text-foreground-subtle">附件：{message.media.map(kind => mediaLabels[kind] ?? kind).join("、")}</p>}
        {message.opaqueProviderContextOmitted && <p className="text-foreground-subtle">供应商私有上下文已省略。</p>}
      </article>)}
      {context && !context.data.length && <p className="text-foreground-subtle">暂无历史消息。</p>}
    </div>
    {context && <footer className="panel-toolbar flex shrink-0 items-center justify-between"><Button size="sm" variant="ghost" disabled={busy || unavailable || context.offset === 0} onClick={() => void read(Math.max(0, context.offset - pageSize))}>上一页</Button><span>第 {Math.floor(context.offset / pageSize) + 1} 页</span><Button size="sm" variant="ghost" disabled={busy || unavailable || context.nextOffset === null} onClick={() => void read(context.nextOffset!)}>下一页</Button></footer>}
  </section>;
}
