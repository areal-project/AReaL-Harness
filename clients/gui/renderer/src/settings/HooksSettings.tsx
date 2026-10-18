import { useRef, useState } from "react";
import type { Action } from "../services.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback, SettingsDialog, useResource } from "./common.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";

type Hook = { name: string; event: string; matcher: string; argv: string[]; timeoutMs: number };
type Hooks = { path: string; external: boolean; revision: string; hooks: Hook[];
  projects: { projectId: string; root: string; connected: boolean; applied: boolean }[] };
type Draft = { source: string; revision: string; hooks: Hook[]; index: number; name: string; event: string; matcher: string; argv: string; timeout: string };
const draftKey = "areal-hooks-editor";
function savedDraft(): Draft | null { try { return JSON.parse(localStorage.getItem(draftKey) || "null"); } catch { return null; } }

export function HooksSettings({ action, connected, onConnect }: { action: Action; connected: boolean; onConnect: () => Promise<void> }) {
  const state = useResource(() => action("resources", { operation: "hooks" }), String(connected));
  const value = state.value as Hooks | undefined;
  const [draft, setDraft] = useState<Draft | null>(savedDraft), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const locked = useRef(false);
  const update = (next: Draft | null) => {
    setDraft(next);
    if (!next) setDeleting(false);
    if (next) localStorage.setItem(draftKey, JSON.stringify(next)); else localStorage.removeItem(draftKey);
  };
  const edit = (index: number) => {
    if (!value) return;
    const item = value.hooks[index]; setError(""); setNotice("");
    update({ source: value.path, revision: value.revision, hooks: value.hooks, index,
      name: item?.name ?? "", event: item?.event ?? "PreToolUse", matcher: item?.matcher ?? "*",
      argv: JSON.stringify(item?.argv ?? [], null, 2), timeout: String(item?.timeoutMs ?? 10000) });
  };
  const run = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (cause) { setError((cause as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  const save = () => run(async () => {
    if (!draft || !value) return;
    if (draft.source !== value.path) throw new Error("配置来源已变化，请取消编辑并重新读取。");
    const argv = JSON.parse(draft.argv);
    if (!Array.isArray(argv) || argv.some(v => typeof v !== "string")) throw new Error("命令参数必须是字符串组成的 JSON 数组。");
    const hook: Hook = { name: draft.name, event: draft.event, matcher: draft.matcher, argv, timeoutMs: Number(draft.timeout) };
    const hooks = draft.index < 0 ? [...draft.hooks, hook] : draft.hooks.map((h, i) => i === draft.index ? hook : h);
    await action("resources", { operation: "hooksSave", expectedRevision: draft.revision, hooks });
    update(null); await state.refresh(); setNotice("配置已保存，重启后台后生效。");
  });
  const move = (index: number, direction: number) => run(async () => {
    if (!value) return;
    const hooks = [...value.hooks];
    [hooks[index], hooks[index + direction]] = [hooks[index + direction], hooks[index]];
    await action("resources", { operation: "hooksSave", expectedRevision: value.revision, hooks });
    await state.refresh(); setNotice("配置已保存，重启后台后生效。");
  });
  const remove = () => run(async () => {
    if (!draft || !value || draft.source !== value.path || draft.index < 0) return;
    await action("resources", { operation: "hooksSave", expectedRevision: draft.revision, hooks: draft.hooks.filter((_, index) => index !== draft.index) });
    update(null); await state.refresh(); setNotice("配置已保存，重启后台后生效。");
  });
  const apply = () => run(async () => {
    if (connected) {
      const result = await action("stopService");
      if (result.canceled) { setNotice("已取消重启，配置仍保留。"); return; }
      if (!result.stopped) throw new Error("后台尚未停止，配置尚未应用。");
    }
    await onConnect(); await state.refresh(); setNotice("后台已重新连接，请核对各项目的加载状态。");
  });
  const disabled = busy || !connected || state.loading || !!state.error;
  return <div className="settings-sections" aria-label="钩子管理">
    <p className="settings-section-desc">在工具执行前、成功后或失败后运行命令。钩子按顺序执行，修改后需重启后台。命令不会隐式经过 shell。</p>
    <Feedback error={draft ? undefined : error || state.error} message={notice} />
    <SettingsSection title="来自配置" description={value?.path ?? "读取 Core 配置来源…"} action={<div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={busy || !connected} onClick={() => void state.refresh()}>刷新钩子</Button>
      <Button size="sm" disabled={disabled || !value || !!draft || value.hooks.length >= 64} onClick={() => edit(-1)}>添加钩子</Button>
    </div>}>
      <SettingsGroupCard>
        {value?.hooks.map((hook, index) => <SettingsRow key={hook.name} label={hook.name}
          description={`${hook.event} · ${hook.matcher} · ${hook.timeoutMs} ms`}
          control={<div className="flex gap-2">
            <Button variant="ghost" size="sm" aria-label={`上移 ${hook.name}`} disabled={disabled || !!draft || index === 0} onClick={() => void move(index, -1)}>上移</Button>
            <Button variant="ghost" size="sm" aria-label={`下移 ${hook.name}`} disabled={disabled || !!draft || index === value.hooks.length - 1} onClick={() => void move(index, 1)}>下移</Button>
            <Button variant="outline" size="sm" disabled={disabled || !!draft} onClick={() => edit(index)}>编辑 {hook.name}</Button>
          </div>} />)}
        {value && !value.hooks.length && <p className="p-4 settings-section-desc">尚未配置钩子。</p>}
      </SettingsGroupCard>
    </SettingsSection>
    <SettingsSection title="配置生效" description="重启会断开共享后台的所有窗口；正在执行的任务、终端或未确认操作会阻止停止。保存本身不会中断执行。"
      action={<Button variant="outline" size="sm" disabled={busy || !!draft || !value} onClick={() => void apply()}>{connected ? "重启后台并应用" : "连接后台并应用"}</Button>}>
      <SettingsGroupCard>{value?.projects.map(p => <SettingsRow key={p.projectId} label={p.root.split(/[\\/]/).at(-1) || p.root}
        description={p.root} control={<span>{!connected || !p.connected ? "下次启动加载" : p.applied ? "已加载当前配置" : "待重启应用"}</span>} />)}</SettingsGroupCard>
    </SettingsSection>
    <p className="settings-section-desc">本页管理 Core 扩展配置中的钩子；不会自动导入项目文件或插件中的其他格式。</p>
    {draft && <SettingsDialog title={draft.index < 0 ? "添加钩子" : "编辑钩子"} description="命令接收一行事件 JSON，并返回钩子响应。保存时由 Core 校验完整扩展配置。" busy={busy} onClose={() => update(null)}>
      <form onSubmit={e => { e.preventDefault(); void save(); }} className="grid gap-3">
        <Feedback error={error || state.error} />
        {state.error && <Button type="button" variant="outline" disabled={busy || !connected} onClick={() => void state.refresh()}>重新读取钩子配置</Button>}
        <label>钩子名称<Input aria-label="钩子名称" required disabled={busy} value={draft.name} onChange={e => update({ ...draft, name: e.target.value })} /></label>
        <label>触发事件<select aria-label="触发事件" disabled={busy} value={draft.event} onChange={e => update({ ...draft, event: e.target.value })}>
          <option value="PreToolUse">工具执行前</option><option value="PostToolUse">工具成功后</option><option value="PostToolUseFailure">工具失败后</option>
        </select></label>
        <label>匹配工具<Input aria-label="匹配工具" required disabled={busy} value={draft.matcher} onChange={e => update({ ...draft, matcher: e.target.value })} /></label>
        <label>命令参数（JSON 数组）<textarea aria-label="命令参数（JSON 数组）" className="w-full min-h-32 font-mono" disabled={busy} value={draft.argv} onChange={e => update({ ...draft, argv: e.target.value })} /></label>
        <label>超时（毫秒）<Input type="number" aria-label="超时（毫秒）" required disabled={busy} value={draft.timeout} onChange={e => update({ ...draft, timeout: e.target.value })} /></label>
        {deleting ? <div role="group" aria-label="确认删除钩子" className="grid gap-2">
          <p>删除钩子“{draft.hooks[draft.index]?.name}”？保存后仍需重启后台生效。</p>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setDeleting(false)}>取消删除</Button><Button type="button" variant="destructive" disabled={disabled} onClick={() => void remove()}>确认删除钩子</Button></div>
        </div> : <div className="flex justify-end gap-2">
          {draft.index >= 0 && <Button type="button" variant="destructive" disabled={disabled} onClick={() => setDeleting(true)}>删除钩子</Button>}
          <Button type="button" variant="outline" disabled={busy} onClick={() => update(null)}>取消</Button><Button type="submit" disabled={disabled}>保存钩子</Button>
        </div>}
      </form>
    </SettingsDialog>}
  </div>;
}
