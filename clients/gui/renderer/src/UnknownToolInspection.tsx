import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./components/ui/dialog.js";
import type { Action, Data } from "./services.js";

/** Core owns both the UNKNOWN journal and the operator's inspection. Acknowledging
 * records facts only: it never retries the operation or changes its outcome. */
export function UnknownToolInspection({ item, project, thread, action }: {
  item: Data; project: Data; thread: Data; action: Action;
}) {
  const [open, setOpen] = useState(false), [inspection, setInspection] = useState("");
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false);
  const connected = !!project.state?.connected;
  const confirmed = item.execution?.inspection;
  const unknown = item.execution?.outcome === "unknown" || item.execution?.hooks?.some((hook: Data) => hook.outcome === "unknown")
    || item.execution?.plugin?.operations?.some((operation: Data) => operation.outcome === "unknown");
  const active = thread.turns?.some((turn: Data) => turn.status === "inProgress");
  const bytes = new TextEncoder().encode(inspection.trim()).length;
  const archived = thread.desktop?.archived && thread.conversation?.policy?.kind !== "sideExecutableV2";
  const disabled = busy || !connected || active || archived || !!confirmed;
  useEffect(() => { if (!connected) setChecked(false); }, [connected]);
  if (!unknown) return null;
  const params = { projectId: project.id, threadId: thread.id };
  const confirm = async () => {
    if (disabled || !checked || bytes < 1 || bytes > 1024 || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      await action("manage", { ...params, operation: "toolAcknowledge", itemId: item.id, inspection: inspection.trim() });
      setOpen(false);
    } catch (cause) {
      setError(`核查未确认，请刷新原记录后核对；不会自动重试。${(cause as Error).message}`);
    } finally { locked.current = false; setBusy(false); }
  };
  const refresh = async () => {
    if (locked.current || !connected) return;
    locked.current = true; setBusy(true);
    try { await action("open", params); setError(""); }
    catch (cause) { setError(`刷新失败，仍显示上次记录。${(cause as Error).message}`); }
    finally { locked.current = false; setBusy(false); }
  };
  return <div className="notice">
    <p>{confirmed ? "UNKNOWN · 已记录人工核查，原结果仍未知。" : "UNKNOWN · 工具或钩子结果未确认，核查前会话保持阻塞。"}</p>
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (value) setChecked(false); }}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>{confirmed ? "查看 UNKNOWN 核查" : "核查 UNKNOWN"}</DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogTitle>核查工具结果 UNKNOWN</DialogTitle>
        <DialogDescription>请先核对工作区的实际文件或进程。确认只记录核查事实，不重放原操作，也不将历史改写为成功。证据不足时取消核查。</DialogDescription>
        <dl className="grid gap-1 text-sm break-all">
          <dt>原工具</dt><dd>{item.tool}</dd>
          <dt>执行项</dt><dd>{item.id}</dd>
          <dt>操作</dt><dd>{item.execution.operationId}</dd>
          <dt>历史状态</dt><dd>{item.execution.outcome}{item.execution.hooks?.some((hook: Data) => hook.outcome === "unknown") ? " · 钩子 UNKNOWN" : ""}{item.execution.plugin?.operations?.some((operation: Data) => operation.outcome === "unknown") ? " · 插件 UNKNOWN" : ""}</dd>
        </dl>
        <div><h3>原操作参数</h3><pre className="whitespace-pre-wrap break-all text-xs" aria-label="原操作参数">{JSON.stringify(item.arguments, null, 2)}</pre></div>
        <details><summary>Core 原始结果与核查事实</summary><pre className="whitespace-pre-wrap break-all text-xs" aria-label="Core 原始结果">{JSON.stringify({ output: item.contentItems, execution: item.execution }, null, 2)}</pre></details>
        {confirmed ? <div role="status"><h3>已保存的核查说明</h3><p className="whitespace-pre-wrap break-words">{confirmed}</p></div> : <>
          <label>核查说明<Textarea aria-label="核查说明" value={inspection} onChange={event => setInspection(event.target.value)} disabled={busy} placeholder="记录已检查的文件、进程及观察到的事实；不确定时不要确认。" /></label>
          <p className="text-xs">{bytes} / 1024 UTF-8 字节</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} disabled={disabled} />已核查实际文件或进程</label>
          {!connected && <p role="status">连接中断，不能确认。恢复连接后刷新原记录。</p>}
          {active && <p role="status">会话仍在执行，结算后才能确认。</p>}
        </>}
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>取消核查</Button>
          <Button variant="outline" disabled={busy || !connected} onClick={() => void refresh()}>刷新原记录</Button>
          {!confirmed && <Button disabled={disabled || !checked || bytes < 1 || bytes > 1024} onClick={() => void confirm()}>确认已核查</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
