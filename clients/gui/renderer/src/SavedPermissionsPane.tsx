import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.js";
import type { Action, Data } from "./services.js";

type Grant = { key: string; tool: string; arguments: unknown };
type Permissions = { workspace: string; session: Grant[] | null; project: Grant[]; configuration: { mode: string; ask: string[]; allow: string[]; deny: string[] } };
type Scope = "session" | "project";
const scopeLabel = { session: "本任务", project: "本项目" };

export function SavedPermissionsPane({ project, thread, action }: { project: Data; thread: Data; action: Action }) {
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [reading, setReading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<Scope | null>(null);
  const sequence = useRef(0), locked = useRef(false);
  const read = useCallback(async () => {
    const id = ++sequence.current; setReading(true);
    try {
      const result: Permissions = await action("manage", { projectId: project.id, threadId: thread.id, operation: "permissions" });
      if (sequence.current === id) { setPermissions(result); setError(""); }
      return result;
    } catch (cause) { if (sequence.current === id) setError(`无法刷新授权，当前列表可能已过期。${(cause as Error).message}`); return null; }
    finally { if (sequence.current === id) setReading(false); }
  }, [action, project.id, thread.id]);
  const active = thread.turns?.some((turn: Data) => turn.status === "inProgress");
  const connected = project.state?.connected;
  // Read actual grants after a turn, not an optimistic copy of an approval click.
  useEffect(() => { if (!locked.current && connected) void read(); return () => { sequence.current++; }; }, [read, active, connected]);
  const disabled = saving || reading || !connected || active || thread.desktop?.archived || project.pending?.some((entry: Data) => entry.params?.threadId === thread.id);
  const forget = async () => {
    if (!confirm || locked.current || disabled) return;
    const scope = confirm; locked.current = true; setSaving(true); setError(""); setNotice("");
    try {
      await action("manage", { projectId: project.id, threadId: thread.id, operation: "permissionsForget", project: scope === "project" });
      setConfirm(null);
      const current = await read();
      setNotice(current && current[scope]?.length === 0 ? `${scopeLabel[scope]}已保存授权已撤销，并已读回有效状态。` : "撤销已受理，但当前状态尚未确认，请刷新授权核对。");
    } catch (cause) {
      // No receipt exists for this operation. Refresh, but never retry the write.
      await read(); setError(`撤销结果未确认，请核对列表后再操作。${(cause as Error).message}`);
    } finally { locked.current = false; setSaving(false); }
  };
  return <section aria-label="已保存授权" className="flex h-full min-h-0 flex-col text-ui-base">
    <div className="panel-toolbar flex shrink-0 items-center justify-between"><span>{reading ? "读取中…" : "已保存授权"}</span><Button size="sm" variant="ghost" disabled={saving || reading || !connected} onClick={() => { setNotice(""); void read(); }}>刷新授权</Button></div>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <p className="text-foreground-subtle">这里是你在工具审批时记住的具体操作。授权匹配参数与权限条件，不代表允许工具的所有操作。</p>
      {permissions && <p className="break-all text-foreground-subtle">工作区：{permissions.workspace}</p>}
      {active && <p role="status">当前任务运行中，结束后可以撤销已保存授权。</p>}
      {!connected && <p role="status">连接不可用，恢复连接后重新读取授权。</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {permissions && (["session", "project"] as const).map(scope => <section key={scope} aria-label={`${scopeLabel[scope]}授权`} className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{scopeLabel[scope]}授权 · {permissions[scope]?.length ?? 0}</h3><Button size="sm" variant="ghost" disabled={disabled || !permissions[scope]?.length} onClick={() => { setError(""); setConfirm(scope); }}>撤销{scopeLabel[scope]}全部授权</Button></div>
        <p className="text-foreground-subtle">{scope === "session" ? "仅此任务使用，重新打开任务后仍保留。" : "当前工作区内的任务共用。撤销将影响其他任务之后的审批。"}</p>
        {!permissions[scope]?.length && <p className="text-foreground-subtle">暂无已保存授权</p>}
        {permissions[scope]?.map(grant => <details key={grant.key} className="rounded-control border border-border p-2"><summary>{grant.tool}</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(grant.arguments, null, 2)}</pre></details>)}
      </section>)}
      {permissions && <details className="border-t border-border pt-3"><summary>部署审批规则</summary><p className="mt-2 text-foreground-subtle">{permissions.configuration.mode === "ASK_PERMISSIONS" ? "默认请求审批" : "默认自动执行"}；会话与预设限制仍然生效。</p>{([['deny', '始终拒绝'], ['ask', '每次询问'], ['allow', '允许']] as const).map(([key, label]) => <p key={key} className="mt-1 break-words">{label}：{permissions.configuration[key].join("、") || "未配置"}</p>)}</details>}
    </div>
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !saving) setConfirm(null); }}>
      <DialogContent className="max-w-md" showCloseButton={!saving}>
        <DialogHeader><DialogTitle>撤销{confirm ? scopeLabel[confirm] : ""}全部授权？</DialogTitle><DialogDescription>{confirm === "project" ? "将清除当前工作区共享的全部已保存授权。其他任务之后执行这些操作时也将重新判断是否需要审批。" : "将清除此任务的全部已保存授权；之后执行这些操作时将重新判断是否需要审批。"} 此操作不会撤回已经执行的操作，也不会改变部署或会话权限模式。</DialogDescription></DialogHeader>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setConfirm(null)}>取消</Button><Button variant="destructive" disabled={disabled} onClick={() => void forget()}>{saving ? "撤销中…" : "确认撤销"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
