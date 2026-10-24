import { useEffect, useRef, useState } from "react";
import { GitBranch, GitFork, Settings } from "lucide-react";
import { Button } from "@areal/ui";
import { NotificationToast, WorktreeDirectory, WorktreePicker, WorktreeSettings, WorktreeStatus, WorktreeWorkspace } from "@areal/ui/wip";

export function WorktreeExamples({ only }: { only: string | null }) {
  const show = (id: string) => !only || only === id;
  return <>{show("worktree-picker") && <PickerExample />}{show("worktree-status") && <StatusExample />}{show("worktree-directory") && <DirectoryExample />}{show("worktree-settings") && <SettingsExample />}{show("worktree-workspace") && <WorkspaceExample />}{show("notification-toast") && <ToastExample />}</>;
}
function PickerExample() {
  const [page, setPage] = useState("main");
  const [enabled, setEnabled] = useState(true);
  const [query, setQuery] = useState("");
  const [branch, setBranch] = useState("main");
  const [environment, setEnvironment] = useState("none");
  const [mode, setMode] = useState("ready");
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const busy = mode !== "ready";
  const [notice, setNotice] = useState(false);
  useEffect(() => setNotice(mode === "error"), [mode]);
  const branches = ["main", ...Array.from({ length: 30 }, (_, index) => `feature/long-branch-name-${index + 1}`)].filter(item => item.includes(query));
  useEffect(() => { if (page === "branch") search.current?.focus(); }, [page]);
  const back = () => { setPage("main"); setQuery(""); requestAnimationFrame(() => trigger.current?.focus()); };
  return <section className="library-worktree-example" aria-label="Worktree选择器样例"><h2>Worktree配置</h2>
    <label>选项状态<select aria-label="Worktree选项状态" value={mode} onChange={event => setMode(event.target.value)}><option value="ready">可用</option><option value="loading">读取中</option><option value="error">读取失败</option></select></label>
    <div className="library-worktree-picker"><WorktreePicker>{page === "main" ? <>
      <p className="worktree-picker-heading">配置本地环境</p>
      <WorktreePicker.Row icon={<GitFork />} label="新Worktree" control={<input type="checkbox" aria-label="在示例Worktree中工作" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />} />
      <WorktreePicker.Row ref={trigger} icon={<GitBranch />} label="分支" value={branch} aria-label="选择起始分支" disabled={busy} onClick={() => setPage("branch")} />
      <WorktreePicker.Row icon={<Settings />} label="环境" value={environment === "none" ? "无环境" : "本地开发"} aria-label="选择示例环境" disabled={busy || !enabled} onClick={() => setPage("environment")} />
    </> : <WorktreePicker.Page label={page === "branch" ? "分支" : "环境"} backLabel="返回配置样例" onBack={back}
      search={page === "branch" && <div className="worktree-branch-search"><input ref={search} aria-label="搜索示例分支" value={query} onChange={event => setQuery(event.target.value)} /></div>}
      note="只从已提交版本创建，不复制未提交改动。">
      <WorktreePicker.Options label={page === "branch" ? "示例分支" : "示例环境"} disabled={busy} empty="没有匹配的分支" heading={page === "branch" ? "分支" : undefined}
        items={(page === "branch" ? branches : ["none", "dev"]).map(id => ({ id, label: id === "none" ? "无环境" : id === "dev" ? "本地开发" : id, icon: <GitBranch />, selected: id === (page === "branch" ? branch : environment) }))}
        onSelect={id => { if (page === "branch") setBranch(id); else setEnvironment(id); back(); }} />
    </WorktreePicker.Page>}
      {mode === "loading" && <p className="worktree-picker-feedback" role="status">正在读取示例选项…</p>}
      {mode === "error" && <div className="worktree-picker-feedback"><details><summary>错误详情</summary><p>无法读取示例选项</p></details><Button variant="ghost" onClick={() => setMode("ready")}>重试示例选项</Button></div>}
    </WorktreePicker></div>{notice && <div className="areal-toast-viewport"><NotificationToast tone="error" message="无法读取示例选项" dismissLabel="关闭选项提示" onDismiss={() => setNotice(false)} /></div>}<p role="status">所选分支：{branch}；此页不会创建目录。</p>
  </section>;
}
function StatusExample() {
  const [state, setState] = useState("settingUp");
  const [action, setAction] = useState("");
  const running = state === "settingUp";
  const label = state === "unknown" ? "准备结果待核对" : state === "failed" ? "准备失败" : "Worktree 已创建";
  return <section className="library-worktree-example" aria-label="Worktree准备样例"><h2>准备过程</h2><label>准备状态<select aria-label="Worktree准备状态" value={state} onChange={event => setState(event.target.value)}><option value="settingUp">Setup中</option><option value="failed">失败</option><option value="unknown">结果待核对</option><option value="ready">就绪</option></select></label>
    <WorktreeStatus state={state} label={label} regionLabel="示例准备过程" running={running} message={state === "unknown" ? "原请求未确认；查看详情不会重试。" : undefined}
      stages={[{ id: "created", label: "目录已创建", current: false }, { id: state, label: state === "settingUp" ? "正在运行环境Setup" : label, current: true }]}
      showLabel="查看创建详情" hideLabel="收起创建详情" details={<><code>/workspace/worktrees/示例</code><pre role="log" aria-label="示例准备输出" className="worktree-status-log">{("Preparing local dependencies…\n".repeat(35))}</pre></>}
      controls={running ? <Button variant="ghost" aria-label="取消准备样例" onClick={() => setAction("已表达取消意图；未执行真实取消。")}>取消</Button> : undefined} />
    {action && <p role="status">{action}</p>}
  </section>;
}
function DirectoryExample() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(false);
  return <section className="library-worktree-example" aria-label="目录样例"><h2>已管理目录</h2><WorktreeDirectory><WorktreeDirectory.Group title="示例项目">
    <WorktreeDirectory.Item name="示例任务" open={open} onToggle={() => setOpen(value => !value)} onDelete={() => { setError("示例删除受阻：有未提交内容；目录仍保留。"); setNotice(true); }}
      labels={{ details: "查看目录", delete: "删除目录", deleting: "删除中", result: "删除结果" }} error={error}>
      <div><dt>目录</dt><dd><code>/workspace/worktrees/long-directory/示例任务</code></dd></div><div><dt>分支</dt><dd>areal/示例任务</dd></div>
    </WorktreeDirectory.Item></WorktreeDirectory.Group></WorktreeDirectory>{notice && <div className="areal-toast-viewport"><NotificationToast tone="error" message={error} dismissLabel="关闭目录提示" onDismiss={() => setNotice(false)} /></div>}</section>;
}
function SettingsExample() {
  const [view, setView] = useState("projects");
  const [platform, setPlatform] = useState("default");
  const [scripts, setScripts] = useState<Record<string, string>>({ default: "echo setup", macos: "", linux: "" });
  const [mode, setMode] = useState("ready");
  const busy = mode === "saving";
  const [notice, setNotice] = useState(false);
  useEffect(() => setNotice(mode === "error"), [mode]);
  return <section className="library-worktree-example" aria-label="环境设置样例"><h2>项目与环境</h2>
    <label>保存状态<select aria-label="环境保存状态" value={mode} onChange={event => setMode(event.target.value)}><option value="ready">可编辑</option><option value="saving">保存中</option><option value="error">保存失败</option></select></label>
    <WorktreeSettings view={view}>
      {view !== "projects" && <WorktreeSettings.Breadcrumb label="示例环境导航" disabled={busy} items={[{ id: "projects", label: "项目", onSelect: () => setView("projects") }, { id: "current", label: view === "project" ? "示例项目" : "本地开发" }]} />}
      {view === "projects" ? <div className="worktrees-project-list"><WorktreeSettings.Project name="示例项目" root="/workspace/example" disabled={busy} openLabel="配置项目 示例项目" addLabel="添加示例环境" onOpen={() => setView("project")} onAdd={() => setView("editor")} /></div>
        : view === "project" ? <div className="worktrees-environment-list"><WorktreeSettings.Environment name="本地开发" label="编辑环境 本地开发" disabled={busy} onOpen={() => setView("editor")} /></div>
          : <WorktreeSettings.Script label="Setup" description="各平台草稿由宿主独立保留；此实例不会执行脚本。" hint={platform !== "default" ? "为空时沿用Default。" : undefined}>
            <label>平台<select aria-label="示例脚本平台" value={platform} disabled={busy} onChange={event => setPlatform(event.target.value)}><option value="default">Default</option><option value="macos">macOS</option><option value="linux">Linux</option></select></label>
            <textarea className="worktrees-script-input" aria-label="示例Setup脚本" disabled={busy} value={scripts[platform]} onChange={event => setScripts(values => ({ ...values, [platform]: event.target.value }))} />
          </WorktreeSettings.Script>}
      {busy && <p role="status">正在保存样例…</p>}{mode === "error" && <details><summary>保存详情</summary><p>示例保存失败；草稿仍然保留。</p></details>}
    </WorktreeSettings>{notice && <div className="areal-toast-viewport"><NotificationToast tone="error" message="示例保存失败；草稿仍然保留。" dismissLabel="关闭保存提示" onDismiss={() => setNotice(false)} /></div>}
  </section>;
}
function WorkspaceExample() {
  const [mode, setMode] = useState("ready");
  return <section className="library-worktree-example"><h2>会话工作区详情</h2><WorktreeWorkspace heading={mode === "unknown" ? "操作结果待核对" : "环境已就绪"} directory="/workspace/worktrees/long-directory-name/示例"
    busy={mode === "running"} busyLabel="操作中…" output={mode === "unknown" ? "示例操作已提交，尚未确认最终结果。" : undefined} outputLabel="示例动作输出"
    actions={<div className="library-example-actions"><Button variant="secondary" disabled={mode === "running"} onClick={() => setMode("running")}>运行样例Action</Button><Button variant="ghost" onClick={() => setMode("unknown")}>显示未知结果</Button></div>} /></section>;
}
function ToastExample() {
  const [active, setActive] = useState<{ id: number; tone: "info" | "success" | "warning" | "error" }>();
  const sequence = useRef(0);
  return <section className="library-toast-example" aria-label="等级提示样例"><h2>短时通知</h2><p>5秒后消失；悬停或键盘聚焦暂停。</p><div className="library-example-actions">
    {([['info', '普通'], ['success', '成功'], ['warning', '警告'], ['error', '错误']] as const).map(([tone, label]) => <Button key={tone} variant="outline" onClick={() => setActive({ id: ++sequence.current, tone })}>触发{label}提示</Button>)}
  </div><div className="areal-toast-viewport">{active && <NotificationToast key={active.id} tone={active.tone} message={active.tone === "error" ? "删除失败：请先核对目录中的改动。" : active.tone === "warning" ? "操作结果待核对，请保留当前草稿。" : active.tone === "success" ? "设置已保存。" : "参考内容已复制。"} dismissLabel="关闭示例提示" onDismiss={() => setActive(undefined)} />}</div></section>;
}
