import { useState } from "react";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTitle, PopoverDescription } from "./components/ui/popover.js";
import { ForkIcon } from "./interfaceIcons.js";
import type { Data } from "./services.js";

export function ForkTargetDialog({ title, boundary, models, profiles, onClose, onCreate, onCheck, anchor }: {
  anchor?: HTMLElement;
  title: string;
  boundary: "before" | "after";
  models: Data[];
  profiles: Data[];
  onClose: () => void;
  onCreate: (target?: Data) => Promise<void>;
  onCheck: () => Promise<void>;
}) {
  const [selection, setSelection] = useState("inherit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const availableModels = models.filter(model => model.providerId && model.modelId && model.available !== false);
  const ordinaryProfiles = profiles.filter(profile => profile.id && profile.revision && !profile.workflow);
  const create = async () => {
    const target = selection === "inherit" ? undefined : selection === "default" ? {} :
      selection.startsWith("model:") ? { model: availableModels[Number(selection.slice(6))] && {
        providerId: availableModels[Number(selection.slice(6))].providerId,
        modelId: availableModels[Number(selection.slice(6))].modelId,
      } } : { agentProfile: ordinaryProfiles[Number(selection.slice(8))] && {
        id: ordinaryProfiles[Number(selection.slice(8))].id,
        revision: ordinaryProfiles[Number(selection.slice(8))].revision,
      } };
    setBusy(true); setError("");
    try { await onCreate(target); }
    catch (cause) {
      setUnknown(!!(cause && typeof cause === "object" && "submissionUnknown" in cause && cause.submissionUnknown));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true);
    try { await onCheck(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Popover open onOpenChange={open => { if (!open) onClose(); }}>
    <PopoverContent anchor={anchor} side="top" align="start" sideOffset={8} className="fork-target-popover" aria-label="创建独立分支" finalFocus={() => anchor?.isConnected ? anchor : false}>
    <PopoverTitle>从这里创建聊天分支</PopoverTitle>
    <PopoverDescription className="fork-target-description">{`从「${title}」${boundary === "after" ? "此轮之后" : "此轮之前"}冻结历史。新旧会话共享当前工作区，文件不会回滚。`}</PopoverDescription>
    {!unknown && <button type="button" className="fork-workspace-choice" aria-label="创建分支" disabled={busy} onClick={() => void create()}><ForkIcon size={18} /><span><strong>{busy ? "正在创建…" : "在当前工作树中创建"}</strong><small>在当前工作区创建新的独立聊天</small></span></button>}
    <details className="fork-target-options"><summary>目标配置</summary>
    <label className="grid gap-2">目标配置
      <select aria-label="分支目标配置" value={selection} disabled={busy} onChange={event => setSelection(event.target.value)}>
        <option value="inherit">继承锚点配置</option>
        <option value="default">普通默认配置</option>
        {ordinaryProfiles.map((profile, index) => <option key={`profile:${profile.id}:${profile.revision}`} value={`profile:${index}`}>预设 · {profile.displayName || profile.id}</option>)}
        {availableModels.map((model, index) => <option key={`model:${model.providerId}:${model.modelId}`} value={`model:${index}`}>模型 · {model.displayName || model.modelId}</option>)}
      </select>
    </label>
    </details>
    {error && <p role="alert">{error}{unknown ? "。请先核对原提交，不会重新创建。" : "。可选择兼容的普通配置后重试。"}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>{busy ? "关闭等待" : "取消"}</Button>{unknown
      ? <Button type="button" disabled={busy} onClick={() => void check()}>{busy ? "正在核对…" : "核对受理结果"}</Button>
      : null}</div>
    </PopoverContent>
  </Popover>;
}
