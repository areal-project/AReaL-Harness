import { useId, useRef, useState } from "react";
import { Button } from "@areal/ui";
import { ComposerSurface, ComposerToolbar, Disclosure, SettingsPage, SettingsSection, SettingsGroupCard, SettingsRow } from "@areal/ui/wip";
import { ArrowUpIcon, FileTextIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";

/** State controls belong to this local example, never to the package or production. */
export function ComposerSurfaceExample() {
  const [mode, setMode] = useState("ready");
  const [layout, setLayout] = useState<"default" | "compact">("default");
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [model, setModel] = useState("本地示例模型");
  const [permission, setPermission] = useState("询问后执行");
  const [sent, setSent] = useState(0);
  const nextFile = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const reasonId = useId();
  const blocked = mode === "blocked";
  const busy = mode === "sending";
  const running = mode === "running";
  const empty = !draft.trim() && !files.length;
  const canSubmit = !blocked && !busy && !running && !empty;
  return <section className="library-composer-example" aria-label="Composer状态实例">
    <div className="library-example-actions">
      <label>状态<select aria-label="Composer状态" value={mode} onChange={event => setMode(event.target.value)}><option value="ready">可编辑</option><option value="blocked">模型不可用</option><option value="sending">发送中</option><option value="running">运行中</option></select></label>
      <label>布局<select aria-label="Composer布局" value={layout} onChange={event => setLayout(event.target.value as typeof layout)}><option value="default">默认</option><option value="compact">紧凑</option></select></label>
      <Button variant="outline" onClick={() => setDraft("请核对活动与输入来源。\n\n".repeat(16))}>填入长草稿</Button>
    </div>
    <form ref={form} className="composer-dock" onSubmit={event => { event.preventDefault(); if (canSubmit) setSent(value => value + 1); }}>
      <ComposerSurface layout={layout}
        context={<>{files.map(file => <div className="library-composer-reference" key={file}><FileTextIcon size={16} /><span>{file}</span><Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`移除 ${file}`} onClick={() => setFiles(values => values.filter(value => value !== file))}><XIcon size={14} /></Button></div>)}
          {blocked && <p id={reasonId} className="composer-submit-feedback" role="status">所选模型暂不可用。草稿已保留，请选择可用模型。</p>}</>}
        editor={<textarea className="library-composer-input" aria-label="示例任务输入" value={draft} disabled={busy} aria-describedby={blocked ? reasonId : undefined}
          placeholder="描述这项任务…" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSubmit) form.current?.requestSubmit(); }
          }} />}
        toolbar={<ComposerToolbar leading={<><Button variant="ghost" size="icon-sm" disabled={busy} aria-label="添加示例引用" onClick={() => { const file = `设计引用 ${++nextFile.current}.md`; setFiles(values => [...values, file]); }}><PaperclipIcon size={16} /></Button>
          <select aria-label="示例权限" value={permission} disabled={busy || running} onChange={event => setPermission(event.target.value)}><option>询问后执行</option><option>只读</option></select></>}
          trailing={<><select aria-label="示例模型" value={model} disabled={busy || running} onChange={event => setModel(event.target.value)}><option>本地示例模型</option><option>较长名称的本地示例模型</option></select>
            {running ? <Button className="composer-primary-action" size="icon-sm" aria-label="停止运行样例" onClick={() => setMode("ready")}><SquareIcon size={14} /></Button>
              : <Button type="submit" size="icon-sm" aria-label={busy ? "正在发送样例" : "发送样例"} aria-describedby={blocked ? reasonId : undefined} disabled={!canSubmit}><ArrowUpIcon size={16} /></Button>}</>} />} />
    </form>
    <p role="status" className="library-example-result">本地发送动作 {sent} 次；草稿仅在此页保留。</p>
  </section>;
}

/** The host fixture owns values and feedback. The package owns only layout. */
export function SettingsLayoutExample() {
  const [mode, setMode] = useState("ready");
  const [name, setName] = useState("设计系统工作区");
  const [saved, setSaved] = useState("设计系统工作区");
  const [density, setDensity] = useState<"compact" | undefined>();
  const [enabled, setEnabled] = useState(true);
  const id = useId();
  const busy = mode === "pending";
  const locked = busy || mode === "unknown";
  const descriptionId = `${id}-description`;
  return <section className="library-settings-example" aria-label="设置布局样例">
    <div className="library-example-actions">
      <label>反馈<select aria-label="设置反馈状态" value={mode} onChange={event => setMode(event.target.value)}><option value="ready">可编辑</option><option value="pending">保存中</option><option value="error">保存失败</option><option value="unknown">结果待核对</option></select></label>
      <label>密度<select aria-label="设置组密度" value={density ?? "default"} onChange={event => setDensity(event.target.value === "compact" ? "compact" : undefined)}><option value="default">默认</option><option value="compact">紧凑</option></select></label>
    </div>
    <div className="library-settings-viewport">
      <SettingsPage title="工作区设置" subtitle="独立组件组合；只修改本页样例，不会写入真实配置。">
        <SettingsSection title="输入偏好" description="配置值与操作反馈由宿主负责。">
          <SettingsGroupCard density={density}>
            <SettingsRow label={<label htmlFor={id}>工作区名称</label>} description={<span id={descriptionId}>用于区分当前工作区。修改后需主动保存。</span>}
              controlLayout="wide" disabled={locked} control={<input id={id} aria-label="示例工作区名称" aria-describedby={descriptionId} type="text" value={name} disabled={locked} onChange={event => setName(event.target.value)} />} />
            <SettingsRow label="保留输入草稿" description="离开此实例后不持久化，页面内切换状态保留输入。" disabled={locked}
              control={<input type="checkbox" aria-label="保留示例草稿" checked={enabled} disabled={locked} onChange={event => setEnabled(event.target.checked)} />}
              detail={<Disclosure label="查看设置边界"><p>配置值、导航守卫与保存回执仍归宿主。</p></Disclosure>} />
          </SettingsGroupCard>
        </SettingsSection>
        <SettingsSection title="不可调整的值" description="禁用布局必须配合真实控件禁用。">
          <SettingsGroupCard density="compact"><SettingsRow label="受当前环境限制的选项" description="不能仅通过淡化或禁用行代替控件语义。" disabled control={<input type="checkbox" aria-label="锁定的示例选项" checked disabled readOnly />} /></SettingsGroupCard>
        </SettingsSection>
        <SettingsSection title="保存反馈" action={<Button variant="outline" disabled={locked || !name.trim()} onClick={() => { setSaved(name); setMode("ready"); }}>保存样例</Button>}>
          {busy ? <p className="library-settings-feedback" role="status">正在保存样例，请保留当前输入…</p>
            : mode === "unknown" ? <p className="library-settings-feedback" role="status">保存结果待核对。先读取配置回执，不自动重试。</p>
            : mode === "error" ? <p className="library-settings-feedback" role="alert">保存失败；输入已保留。确认原因后可手动保存样例。</p>
            : <p className="library-settings-feedback" role="status">本地样例已保存：{saved}{name !== saved ? "；当前输入尚未保存" : ""}</p>}
        </SettingsSection>
      </SettingsPage>
    </div>
  </section>;
}
