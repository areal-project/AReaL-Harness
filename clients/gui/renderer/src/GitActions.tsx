import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GitCommitHorizontal, Minus, Plus, RefreshCw } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./components/ui/dialog.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import type { Action } from "./services.js";

type GitState = { root: string; head: string; branch: string; token: string; staged: string[]; unstaged: string[]; remotes: string[] };
type IndexReview = { scope: "unstaged" | "staged"; revision: number; enabled: boolean; token: string | undefined; target: HTMLElement | null };
type Operation = "gitStage" | "gitUnstage" | "gitCommit" | "gitPush";

/** A direct workspace operation, not a model request or a turn undo. */
export function GitActions({ projectId, action, onChanged, renderTrigger, indexReview }: { projectId: string; action: Action; onChanged: () => void; renderTrigger?: (onOpen: () => void) => ReactNode; indexReview?: IndexReview }) {
  const [open, setOpen] = useState(false), [state, setState] = useState<GitState>();
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(true);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [message, setMessage] = useState(""), [remote, setRemote] = useState(""), [targetBranch, setTargetBranch] = useState("");
  const readGeneration = useRef(0);
  useEffect(() => () => { readGeneration.current++; }, []);
  const read = async (resetDestination = false, generation = ++readGeneration.current, review?: IndexReview) => {
    const next: GitState = await action("workspace", { projectId, operation: "gitState" });
    if (generation !== readGeneration.current) return;
    setState(next);
    if (review) {
      const current = await action("workspace", { projectId, operation: "review", scope: review.scope });
      if (generation !== readGeneration.current) return;
      if (!review.token || current.token !== review.token) throw Error("改动版本已变化，请刷新改动并重新审查。");
    }
    setStale(false);
    setRemote(old => !resetDestination && next.remotes.includes(old) ? old : next.remotes.includes("origin") ? "origin" : next.remotes[0] ?? "");
    setTargetBranch(old => !resetDestination && old ? old : next.branch);
  };
  const refresh = async (resetDestination = false) => {
    if (busy) return;
    const generation = ++readGeneration.current;
    setBusy(true); setError(""); setStale(true);
    try { await read(resetDestination, generation, !open && !resetDestination && indexReview?.enabled ? indexReview : undefined); }
    catch (cause) { if (generation === readGeneration.current) setError((cause as Error).message); }
    finally { if (generation === readGeneration.current) setBusy(false); }
  };
  useEffect(() => {
    // The review and dialog share this owner. A write already performs its own
    // readback; range/data repaint must not race it or replay a failed action.
    if (indexReview?.enabled && !busy) void refresh();
  }, [projectId, action, indexReview?.scope, indexReview?.revision, indexReview?.enabled, indexReview?.token]);
  const run = async (operation: Operation) => {
    if (busy || stale || !state) return;
    readGeneration.current++;
    setBusy(true); setStale(true); setError(""); setNotice("");
    let applied = false;
    try {
      const result = await action("workspace", { projectId, operation, token: state.token, message, remote, targetBranch: targetBranch.trim() });
      if (operation === "gitCommit") { setMessage(""); setNotice(`已提交 ${result.head.slice(0, 8)}`); }
      else if (operation === "gitPush") setNotice(`已推送 ${result.head.slice(0, 8)} 到 ${result.remote}/${result.targetBranch}`);
      else setNotice(operation === "gitStage" ? "已暂存全部改动" : "已取消全部暂存，工作区文件保持不变");
      applied = true;
      // Failure to refresh after a successful write does not erase that receipt.
      try { await read(); }
      catch { setError("操作已完成，但状态刷新失败。请刷新后继续。"); }
    } catch (cause) {
      setError(`${(cause as Error).message} 请刷新 Git 状态并核对结果后继续。`);
    } finally { setBusy(false); if (applied) onChanged(); }
  };
  const disabled = busy || stale || !state;
  const openDialog = () => { setOpen(true); setNotice(""); void refresh(true); };
  return <>
    {renderTrigger ? renderTrigger(openDialog) : <Button variant="ghost" size="icon" aria-label="Git 操作" title="Git 操作" onClick={openDialog}><GitCommitHorizontal className="size-3.5" /></Button>}
    {indexReview?.target && !open && createPortal(<div className="review-index-actions" role="group" aria-label="仓库暂存操作">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <Button variant="secondary" size="sm" disabled={busy || !indexReview.enabled} onClick={onChanged}><RefreshCw />刷新 Git 状态</Button>}
      {state && (indexReview.scope === "unstaged" ? state.unstaged : state.staged).length > 0 && <Button variant="secondary" size="sm" title={state.root} disabled={disabled || !indexReview.enabled} onClick={() => void run(indexReview.scope === "unstaged" ? "gitStage" : "gitUnstage")}>
          {indexReview.scope === "unstaged" ? <Plus /> : <Minus />}{indexReview.scope === "unstaged" ? "暂存全部改动" : "取消全部暂存"}
        </Button>}
    </div>, indexReview.target)}
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Git 操作</DialogTitle><DialogDescription>审查并提交当前仓库的改动，然后选择推送目标。</DialogDescription></DialogHeader>
        <div className="flex items-center justify-between gap-3 text-ui-sm">
          <span className="min-w-0 truncate" title={state?.root}>{state ? `${state.branch || "分离的 HEAD"} · ${state.head ? state.head.slice(0, 8) : "尚无提交"}` : "正在读取仓库…"}</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw className="size-3.5" />刷新 Git 状态</Button>
        </div>
        {state && <p className="break-all text-ui-xs text-foreground-subtle">{state.root}</p>}
        {error && <p role="alert" className="text-ui-sm text-destructive whitespace-pre-wrap">{error}</p>}
        {notice && <p role="status" className="text-ui-sm">{notice}</p>}
        {state && <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            {([['未暂存', state.unstaged], ['已暂存', state.staged]] as const).map(([title, paths]) => <section key={title} className="min-w-0 rounded-lg border border-border p-3">
              <h3 className="mb-2 text-ui-sm font-medium">{title} · {paths.length}</h3>
              <ul className="max-h-28 overflow-auto text-ui-sm text-foreground-subtle">{paths.map(path => <li key={path} className="truncate" title={path}>{path}</li>)}</ul>
              {!paths.length && <p className="text-ui-sm text-foreground-subtle">没有改动</p>}
            </section>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled || !state.unstaged.length} onClick={() => void run("gitStage")}>暂存全部改动</Button>
            <Button variant="outline" size="sm" disabled={disabled || !state.staged.length} onClick={() => void run("gitUnstage")}>取消全部暂存</Button>
          </div>
          <label className="grid gap-2 text-ui-sm">提交信息<Textarea aria-label="提交信息" value={message} maxLength={10000} disabled={busy} onChange={event => setMessage(event.target.value)} placeholder="说明这次改动的目的" className="min-h-20" /></label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ui-sm text-foreground-subtle">只提交已暂存内容。</span>
            <Button disabled={disabled || !state.staged.length || !message.trim()} onClick={() => void run("gitCommit")}>提交已暂存改动</Button>
          </div>
          <section className="grid gap-3 border-t border-border pt-4">
            <h3 className="text-ui-sm font-medium">推送</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-2 text-ui-sm">远程仓库<Select<string> value={remote || null} disabled={disabled || !state.remotes.length} onValueChange={value => { if (value) setRemote(value); }}>
                <SelectTrigger aria-label="远程仓库"><SelectValue placeholder="未配置远程" /></SelectTrigger><SelectContent>{state.remotes.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
              </Select></label>
              <label className="grid gap-2 text-ui-sm">目标分支<Input aria-label="目标分支" value={targetBranch} disabled={busy} onChange={event => setTargetBranch(event.target.value)} /></label>
            </div>
            <p className="text-ui-sm text-foreground-subtle">{state.head && remote && targetBranch.trim() ? `${state.head.slice(0,8)} → ${remote}/${targetBranch.trim()}` : "配置远程并创建提交后可推送。"}</p>
            <Button variant="outline" disabled={disabled || !state.head || !state.branch || !remote || !targetBranch.trim()} onClick={() => void run("gitPush")}>推送当前提交</Button>
          </section>
        </div>}
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>完成</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
