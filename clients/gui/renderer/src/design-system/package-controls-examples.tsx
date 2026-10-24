import { useState } from "react";
import { FileTextIcon } from "lucide-react";
import * as Stable from "@areal/ui";
import * as Wip from "@areal/ui/wip";

// 示例同时展示稳定与实验入口；组件按成熟度分属两个入口。
const UI = { ...Stable, ...Wip };
const { Button } = Stable;

const fields = new Set(["input", "textarea", "switch", "select", "tabs", "settings-search-input", "settings-segmented-tabs", "settings-select"]);
const overlays = new Set(["popover", "dialog", "dropdown-menu", "context-menu", "tooltip", "command", "control-hint-tooltip"]);
const readers = new Set(["code-viewer", "diff-viewer", "message-code-block", "markdown-blockquote", "markdown-list", "markdown-table", "markdown-surface"]);
const workbench = new Set(["workbench-shell", "side-pane-frame", "side-pane-launcher", "settings-navigation", "task-title-overflow", "task-list-item", "resource-controls"]);
export function PackageControlsExamples({ only }: { only: string | null }) {
  const ids = only ? [only] : ["input", "popover", "card", "action-button", "input-group", "settings-disclosure", "settings-dialog", "decision-card", "collapsible-text", "feedback-notice", "command-details", "attachment-card", "message-attachments", "markdown-table", "workbench-shell", "resource-controls"];
  return <>{ids.map(id => <section className="library-package-example" aria-label={`包内实例 ${id}`} key={id}>
    {fields.has(id) ? <Fields /> : overlays.has(id) ? <Overlays id={id} /> : readers.has(id) ? <Reading id={id} /> : workbench.has(id) ? <Workbench id={id} /> : <Patterns id={id} />}
  </section>)}</>;
}
function Fields() {
  const [text, setText] = useState("保留的输入"); const [checked, setChecked] = useState(true); const [value, setValue] = useState("first"); const [disabled, setDisabled] = useState(false);
  return <><h2>输入与选择</h2><label><input type="checkbox" aria-label="禁用实例控件" checked={disabled} onChange={event => setDisabled(event.target.checked)} />禁用</label>
    <UI.Input aria-label="包内单行输入" value={text} readOnly={false} disabled={disabled} onChange={event => setText(event.target.value)} />
    <UI.Textarea aria-label="包内多行输入" value={text} disabled={disabled} onChange={event => setText(event.target.value)} />
    <UI.SettingsSearchInput aria-label="包内搜索" clearLabel="清除包内搜索" value={text} disabled={disabled} onChange={event => setText(event.target.value)} onClear={() => setText("")} />
    <UI.Switch aria-label="包内开关" checked={checked} disabled={disabled} onCheckedChange={setChecked} />
    <UI.Select value={value} onValueChange={next => { if (next) setValue(next); }} disabled={disabled}><UI.SelectTrigger aria-label="包内单选"><UI.SelectValue /></UI.SelectTrigger><UI.SelectContent><UI.SelectItem value="first">第一项</UI.SelectItem><UI.SelectItem value="second">第二项</UI.SelectItem><UI.SelectItem value="blocked" disabled>不可用</UI.SelectItem></UI.SelectContent></UI.Select>
    <UI.SettingsSegmentedTabs ariaLabel="包内分段" items={[{ value: "first", label: "第一项" }, { value: "second", label: "第二项" }]} value={value} onValueChange={setValue} disabled={disabled} activateOnFocus={false} />
    <UI.SettingsSelect aria-label="包内设置值" value={value} onValueChange={setValue} disabled={disabled}><option value="first">第一项</option><option value="second">第二项</option></UI.SettingsSelect>
    <UI.Tabs value={value} onValueChange={next => setValue(String(next))}><UI.TabsList aria-label="包内内容标签" activateOnFocus={false}><UI.TabsTrigger value="first" disabled={disabled}>第一项</UI.TabsTrigger><UI.TabsTrigger value="second" disabled={disabled}>第二项</UI.TabsTrigger></UI.TabsList><UI.TabsContent value="first">第一组内容</UI.TabsContent><UI.TabsContent value="second">第二组内容</UI.TabsContent></UI.Tabs>
    <p role="status">输入保留：{text}；当前选项：{value}</p></>;
}
function Overlays({ id }: { id: string }) {
  const [count, setCount] = useState(0); const [open, setOpen] = useState(false);
  const trigger = <Button variant="outline">打开包内浮层</Button>;
  const menu = <UI.DropdownMenu><UI.DropdownMenuTrigger render={trigger} /><UI.DropdownMenuContent><UI.DropdownMenuItem onClick={() => setCount(value => value + 1)}>执行本地菜单项</UI.DropdownMenuItem><UI.DropdownMenuItem disabled>不可用操作</UI.DropdownMenuItem></UI.DropdownMenuContent></UI.DropdownMenu>;
  return <><h2>浮层与焦点</h2>{id === "popover" ? <UI.Popover><UI.PopoverTrigger render={trigger} /><UI.PopoverContent><UI.PopoverTitle>包内配置</UI.PopoverTitle><UI.Input aria-label="浮层输入" defaultValue="保持焦点" /></UI.PopoverContent></UI.Popover>
    : id === "dialog" ? <UI.Dialog open={open} onOpenChange={setOpen}><UI.DialogTrigger render={trigger} /><UI.DialogContent closeLabel="关闭包内对话框"><UI.DialogHeader><UI.DialogTitle>包内编辑</UI.DialogTitle><UI.DialogDescription>只修改本地实例</UI.DialogDescription></UI.DialogHeader><UI.Input aria-label="对话框输入" defaultValue="保留草稿" /><UI.DialogFooter showCloseButton closeLabel="完成并关闭" /></UI.DialogContent></UI.Dialog>
    : id === "context-menu" ? <UI.ContextMenu><UI.ContextMenuTrigger className="library-context-trigger">在此区域打开右键菜单</UI.ContextMenuTrigger><UI.ContextMenuContent><UI.ContextMenuItem onClick={() => setCount(value => value + 1)}>执行本地菜单项</UI.ContextMenuItem></UI.ContextMenuContent></UI.ContextMenu>
    : id === "tooltip" ? <UI.TooltipProvider><UI.Tooltip><UI.TooltipTrigger render={trigger} /><UI.TooltipContent>包内辅助说明</UI.TooltipContent></UI.Tooltip></UI.TooltipProvider>
    : id === "control-hint-tooltip" ? <UI.ControlHintTooltip title="包内提示" shortcut="Ctrl+K" standalone>{trigger}</UI.ControlHintTooltip>
    : id === "command" ? <UI.Command><UI.CommandInput aria-label="搜索包内命令" placeholder="搜索…" /><UI.CommandList><UI.CommandEmpty>无匹配命令</UI.CommandEmpty><UI.CommandGroup heading="本地动作"><UI.CommandItem onSelect={() => setCount(value => value + 1)}>执行本地命令</UI.CommandItem><UI.CommandItem disabled>不可用命令</UI.CommandItem></UI.CommandGroup></UI.CommandList></UI.Command> : menu}
    <p role="status">本地动作 {count} 次</p></>;
}
function Patterns({ id }: { id: string }) {
  const [count, setCount] = useState(0); const [open, setOpen] = useState(false); const [pending, setPending] = useState(false); const [removed, setRemoved] = useState(false);
  if (id === "card") return <UI.Card><UI.CardHeader><UI.CardTitle>包内卡片</UI.CardTitle><UI.CardDescription>正文由宿主提供</UI.CardDescription></UI.CardHeader><UI.CardContent>同一布局支持长内容。</UI.CardContent><UI.CardFooter><Button onClick={() => setCount(value => value + 1)}>本地动作 {count}</Button></UI.CardFooter></UI.Card>;
  if (id === "action-button" || id === "spinner") return <><UI.ActionButton pending={pending} onClick={() => setCount(value => value + 1)}>{`本地动作 ${count}`}</UI.ActionButton><Button onClick={() => setPending(value => !value)}>切换处理中</Button><UI.Spinner label="包内加载中" /></>;
  if (id === "input-group") return <UI.InputGroup><UI.InputGroupAddon>名称</UI.InputGroupAddon><UI.InputGroupInput aria-label="组合字段" defaultValue="设计系统" /><UI.InputGroupAddon align="inline-end"><UI.InputGroupButton onClick={() => setCount(value => value + 1)}>动作 {count}</UI.InputGroupButton></UI.InputGroupAddon></UI.InputGroup>;
  if (id === "settings-disclosure") return <UI.SettingsDisclosure title="包内设置详情" expandLabel="展开" collapseLabel="收起"><p>详情内容由宿主提供。</p></UI.SettingsDisclosure>;
  if (id === "settings-dialog") return <><UI.SettingsToolbar description="设置组合实例" onAdd={() => setOpen(true)} addLabel="打开设置编辑" />{open && <UI.SettingsDialog title="包内设置编辑" description="不写入真实配置" closeLabel="关闭设置编辑" onClose={() => setOpen(false)} busy={pending}><UI.Input aria-label="设置编辑字段" defaultValue="未保存的输入" /><Button onClick={() => setPending(value => !value)}>切换保存中</Button></UI.SettingsDialog>}<UI.EmptySettings>没有其他设置项。</UI.EmptySettings></>;
  if (id === "decision-card") return <UI.DecisionCard kind="approval" label="需要批准" regionLabel="包内决策" icon={<span aria-hidden>•</span>} busy={pending} footer={<UI.ActionButton pending={pending} onClick={() => setPending(true)}>批准本地样例</UI.ActionButton>} feedback={<p role="status">{pending ? "仅表达意图；等待宿主结果。" : "尚未提交"}</p>}>操作内容由宿主投影。</UI.DecisionCard>;
  if (id === "collapsible-text") return <UI.CollapsibleText><p>{"长正文保留原始内容与复制入口。".repeat(100)}</p></UI.CollapsibleText>;
  if (id === "feedback-notice") return <UI.FeedbackNotice tone="warning" message="操作结果待核对" detail="保留原请求身份，查看不重试。" actions={<Button onClick={() => setCount(value => value + 1)}>核对原请求 {count}</Button>} detailsLabel="查看原因" expandLabel="展开" collapseLabel="收起" dismissLabel="关闭提示" />;
  if (id === "native-content") return <UI.NativeContent value={{ version: 1, type: "metric", title: "完成进度", value: "24", unit: "项" }} />;
  if (id === "question-card") return <UI.QuestionCard footer={null} title="希望先检查什么？" options={["布局", "状态"]} selected={count === 1 ? "布局" : count === 2 ? "状态" : undefined} onSelect={value => setCount(value === "布局" ? 1 : 2)} />;
  if (id === "command-details") return <UI.CommandDetails heading="命令详情" status="结果待核对" command={"pnpm verify " + "long_argument_".repeat(30)} output={"准备输出…\n".repeat(35)} placeholder="没有文本输出" outputCopy={<Button className="command-copy" aria-label="复制样例输出" onClick={() => setCount(value => value + 1)}>复制</Button>} notices={<p role="status" className="command-output-notice">复制动作 {count} 次</p>} raw={<details className="command-raw"><summary>原始记录</summary><pre>{'{"status":"unknown"}'}</pre></details>} />;
  if (id === "attachment-card") return <>{!removed && <UI.AttachmentCard image={false}><UI.AttachmentCard.Icon>MD</UI.AttachmentCard.Icon><UI.AttachmentCard.Text><span>示例引用.md</span><button onClick={() => setCount(value => value + 1)}>在文本框中显示 ›</button></UI.AttachmentCard.Text><UI.AttachmentCard.Remove aria-label="移除包内引用" onClick={() => setRemoved(true)}>×</UI.AttachmentCard.Remove></UI.AttachmentCard>}<p role="status">引用动作 {count} 次；{removed ? "已从本地草稿移除" : "仍保留引用"}</p></>;
  if (id === "message-attachments") return <UI.Attachments variant="list"><UI.Attachment data={{ id: "sample", type: "file", filename: "设计规范.md", mediaType: "text/markdown" }}><UI.AttachmentPreview /><UI.AttachmentInfo /><UI.AttachmentRemove label="移除示例附件" onClick={() => setCount(value => value + 1)} /></UI.Attachment></UI.Attachments>;
  return null;
}
function Reading({ id }: { id: string }) {
  const code = "export function hello() {\n  return 'AReaL';\n}\n"; const [notice, setNotice] = useState("");
  if (id === "code-viewer") return <UI.CodeViewer code={code} language="typescript" theme="github-light" showLineNumbers wrapLongLines />;
  if (id === "diff-viewer") return <UI.DiffViewer oldFile={{ name: "sample.ts", contents: "const value = 1;\n" }} newFile={{ name: "sample.ts", contents: "const value = 2;\n" }} lightTheme="github-light" darkTheme="github-dark" disableWorkerPool />;
  if (id === "message-code-block") return <UI.MessageCodeBlock code={code} language="typescript" streaming={false} fontSizePx={14} CodeComponent={GalleryCodeViewer} />;
  if (id === "markdown-blockquote") return <UI.MarkdownBlockquote>引用保留来源与正文。</UI.MarkdownBlockquote>;
  if (id === "markdown-list") return <UI.MarkdownUnorderedList><UI.MarkdownListItem>第一项</UI.MarkdownListItem><UI.MarkdownListItem>第二项</UI.MarkdownListItem></UI.MarkdownUnorderedList>;
  if (id === "markdown-surface") return <UI.MarkdownSurface>{"## 包内正文\n\n静态正文与流式呈现采用同一表面。\n\n- 第一项\n- 第二项"}</UI.MarkdownSurface>;
  return <><UI.MarkdownTable onNotify={message => setNotice(message)}><UI.MarkdownTableHeader><UI.MarkdownTableRow><UI.MarkdownTableHead>组件</UI.MarkdownTableHead><UI.MarkdownTableHead>说明</UI.MarkdownTableHead></UI.MarkdownTableRow></UI.MarkdownTableHeader><UI.MarkdownTableBody><UI.MarkdownTableRow><UI.MarkdownTableCell>Input</UI.MarkdownTableCell><UI.MarkdownTableCell>原生字段语义与ref保留</UI.MarkdownTableCell></UI.MarkdownTableRow></UI.MarkdownTableBody></UI.MarkdownTable><p role="status">{notice}</p></>;
}
function Workbench({ id }: { id: string }) {
  const [selected, setSelected] = useState("one"); const [count, setCount] = useState(0);
  if (id === "task-title-overflow") return <UI.TaskTitleOverflowText style={{ maxWidth: 180 }}>{"需要完整阅读的长任务名称".repeat(6)}</UI.TaskTitleOverflowText>;
  if (id === "task-list-item") return <ul className="library-task-list"><UI.MemoTaskItem id="sample" title="需要完整阅读的长任务名称" active pinned={false} running={false} attention={false} archived={false} disabled={false} unread onSelect={() => setCount(value => value + 1)} onRename={() => setCount(value => value + 1)} onPin={() => setCount(value => value + 1)} onArchive={() => setCount(value => value + 1)} /><li role="status">本地动作 {count}</li></ul>;
  if (id === "resource-controls") return <><UI.ResourceScope value={selected} onChange={setSelected} hasProject labels={{ scope: "示例资源范围", user: "用户", project: "项目", task: "任务" }} /><UI.CatalogEmpty kind="skill" title="暂无资源" description="选择作用范围后再添加。" addLabel="添加本地资源" onAdd={() => setCount(value => value + 1)} /><p role="status">本地添加 {count} 次</p></>;
  if (id === "side-pane-launcher") return <UI.SidePaneLauncher items={[{ id: "file", label: "文件", shortcut: "⌘P", icon: FileTextIcon, onOpen: () => setCount(value => value + 1) }]} />;
  if (id === "settings-navigation") return <div className="library-navigation-example"><UI.SettingsNavigation groups={[{ id: "personal", label: "个人", items: [{ id: "one", label: "常规" }, { id: "two", label: "外观" }] }]} activeId={selected} onSelect={setSelected} onBack={() => setCount(value => value + 1)} labels={{ back: "返回实例", forward: "前进", title: "设置", search: "搜索设置样例", searchPlaceholder: "搜索…", clear: "清除设置搜索", navigation: "包内设置导航", empty: "没有匹配项" }} locale="zh-CN" backIcon={<span aria-hidden>←</span>} forwardIcon={<span aria-hidden>→</span>} /><p role="status">当前分类 {selected}</p></div>;
  return <div className="library-shell-example"><UI.WorkbenchShell windowInset={0} style={{ height: 340, minHeight: 0, width: "100%" }}><UI.WorkspaceHeader>工作台实例</UI.WorkspaceHeader><UI.WorkSurface panelOpen split reducedMotion><div>任务正文与草稿由宿主提供。</div></UI.WorkSurface><UI.SidePaneFrame data-open><UI.SidePaneFrame.Header>资源面板<Button variant="ghost" onClick={() => setCount(value => value + 1)}>动作 {count}</Button></UI.SidePaneFrame.Header><UI.SidePaneFrame.Layout><UI.SidePaneFrame.Content>同一面板内容</UI.SidePaneFrame.Content></UI.SidePaneFrame.Layout></UI.SidePaneFrame></UI.WorkbenchShell></div>;
}

function GalleryCodeViewer(props: Wip.CodeViewerProps) { return <UI.CodeViewer {...props} theme="github-light" />; }
