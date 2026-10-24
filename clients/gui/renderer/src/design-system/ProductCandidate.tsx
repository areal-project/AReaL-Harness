import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import startupIcon from "../../../app/assets/icon-1024.png";
import { WorkbenchShell, NavigationSidebar, WorkspaceHeader } from "../app-shell/WorkbenchShell.js";
import { ApprovalRequest } from "../ApprovalRequest.js";
import { ConversationComposer } from "../ConversationComposer.js";
import { Messages } from "../Messages.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { Button } from "../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { SettingsPage } from "../settings/SettingsWorkspace.js";
import { SettingsGroupCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "../settings/SettingsPageParts.js";
import { CloseIcon, FileReference, NavigationBackIcon, Settings, StopIcon } from "../interfaceIcons.js";
import { SidebarToggleIcon } from "../homeChromeIcons.js";
import { DEFAULT_PALETTES, paletteVariables } from "../settings/applicationSettings.js";
import type { LexicalChatInputHandle } from "../LexicalChatInput.js";
import type { Action, Data } from "../services.js";
import "./product-candidate.css";

type Scenario = "normal" | "failure" | "unknown";
type Preferences = { theme: "light" | "dark"; uiSize: "14" | "18"; contentSize: "14" | "18"; reducedMotion: boolean };
type Run = { id: string; requestId: string; generation: number; prompt: string; scenario: Scenario; startedAt: number };
type Execution =
  | { kind: "idle" }
  | { kind: "running"; run: Run; phase: "accepted" | "reading" | "preparing" }
  | { kind: "awaiting-approval"; run: Run }
  | { kind: "acknowledged"; run: Run; decision: "allowOnce" | "deny" }
  | { kind: "writing"; run: Run }
  | { kind: "completed"; run: Run; reconciled: boolean }
  | { kind: "denied"; run: Run }
  | { kind: "failed"; run: Run; reason: "readonly" | "stopped" }
  | { kind: "unknown"; run: Run };
type Finished = Extract<Execution, { kind: "completed" | "denied" | "failed" }>;
type Location = { kind: "chat" } | { kind: "resource"; id: string } | { kind: "settings" };
type ReturnPoint = { location: Location; focus: string };
type Candidate = {
  generation: number; sequence: number; draft: string; execution: Execution; history: Finished[];
  scenario: Scenario; preferences: Preferences; location: Location; returns: ReturnPoint[];
  focus: { id: string; revision: number }; navigationOpen: boolean;
};
type Event =
  | { type: "edit"; text: string }
  | { type: "submit"; text: string; startedAt: number }
  | { type: "advance"; runId: string; generation: number }
  | { type: "decide"; runId: string; requestId: string; generation: number; decision: "allowOnce" | "deny" }
  | { type: "reconcile"; runId: string; generation: number }
  | { type: "stop" }
  | { type: "scenario"; scenario: Scenario }
  | { type: "preferences"; value: Partial<Preferences> }
  | { type: "open"; location: Location; focus: string }
  | { type: "back" }
  | { type: "chat" }
  | { type: "navigation"; open: boolean }
  | { type: "reset" };

const examplePrompt = "为示例项目补充一份快速开始指南，包含安装、启动和第一个任务，写到 docs/快速开始.md。";
const threadId = "candidate-task";
const projectId = "candidate-project";
const isFinished = (execution: Execution): execution is Finished => ["completed", "denied", "failed"].includes(execution.kind);
const unresolved = (execution: Execution) => execution.kind !== "idle" && !isFinished(execution);
const initial: Candidate = {
  generation: 0, sequence: 0, draft: "", execution: { kind: "idle" }, history: [], scenario: "normal",
  preferences: { theme: "light", uiSize: "14", contentSize: "14", reducedMotion: false },
  location: { kind: "chat" }, returns: [], focus: { id: "", revision: 0 }, navigationOpen: false,
};

function reduce(state: Candidate, event: Event): Candidate {
  const execution = state.execution;
  if ((event.type === "advance" || event.type === "decide" || event.type === "reconcile") &&
    (execution.kind === "idle" || execution.run.id !== event.runId || execution.run.generation !== event.generation)) return state;
  switch (event.type) {
    case "edit": return { ...state, draft: event.text };
    case "submit": {
      if (!event.text.trim() || unresolved(execution)) return state;
      const sequence = state.sequence + 1;
      const id = `candidate-${state.generation}-${sequence}`;
      const run: Run = { id, requestId: `${id}-write`, generation: state.generation, prompt: event.text.trim(), scenario: state.scenario, startedAt: event.startedAt };
      return { ...state, sequence, draft: state.draft === event.text ? "" : state.draft,
        history: isFinished(execution) ? [...state.history, execution] : state.history,
        execution: { kind: "running", run, phase: "accepted" } };
    }
    case "advance": {
      if (execution.kind === "running") {
        if (execution.phase === "accepted") return { ...state, execution: { ...execution, phase: "reading" } };
        if (execution.run.scenario === "failure") return { ...state, execution: { kind: "failed", run: execution.run, reason: "readonly" } };
        if (execution.phase === "reading") return { ...state, execution: { ...execution, phase: "preparing" } };
        return { ...state, execution: { kind: "awaiting-approval", run: execution.run } };
      }
      if (execution.kind === "acknowledged") return { ...state, execution: execution.decision === "deny"
        ? { kind: "denied", run: execution.run }
        : execution.run.scenario === "unknown" ? { kind: "unknown", run: execution.run } : { kind: "writing", run: execution.run } };
      if (execution.kind === "writing") return { ...state, execution: { kind: "completed", run: execution.run, reconciled: false } };
      return state;
    }
    case "decide":
      return execution.kind === "awaiting-approval" && execution.run.requestId === event.requestId
        ? { ...state, execution: { kind: "acknowledged", run: execution.run, decision: event.decision } } : state;
    case "reconcile": return execution.kind === "unknown" ? { ...state, execution: { kind: "completed", run: execution.run, reconciled: true } } : state;
    case "stop": return unresolved(execution) && execution.kind !== "unknown"
      ? { ...state, execution: { kind: "failed", run: execution.run, reason: "stopped" } } : state;
    case "scenario": return { ...state, scenario: event.scenario };
    case "preferences": return { ...state, preferences: { ...state.preferences, ...event.value } };
    case "open": return { ...state, location: event.location, focus: { id: event.location.kind === "resource" ? "reader" : "settings-back", revision: state.focus.revision + 1 }, returns: state.location.kind === "resource" && event.location.kind === "resource" ? state.returns : [...state.returns, { location: state.location, focus: event.focus }], navigationOpen: false };
    case "back": {
      const destination = state.returns.at(-1);
      return { ...state, location: destination?.location ?? { kind: "chat" }, returns: state.returns.slice(0, -1),
        focus: { id: destination?.focus ?? "input", revision: state.focus.revision + 1 } };
    }
    case "chat": return { ...state, location: { kind: "chat" }, returns: [], navigationOpen: false, focus: { id: "input", revision: state.focus.revision + 1 } };
    case "navigation": return { ...state, navigationOpen: event.open, focus: { id: event.open ? "task" : "navigation", revision: state.focus.revision + 1 } };
    case "reset": return { ...initial, generation: state.generation + 1, sequence: state.sequence, preferences: state.preferences,
      focus: { id: "input", revision: state.focus.revision + 1 } };
  }
}

const phaseText: Record<Execution["kind"], string> = {
  idle: "准备开始", running: "正在处理", "awaiting-approval": "等待你的批准", acknowledged: "决定已受理", writing: "正在写入",
  completed: "已完成", denied: "已拒绝", failed: "已结束", unknown: "结果待核对",
};
const readme = `# 示例项目\n\n这是一个用来体验任务协作的本地示例。\n\n## 项目结构\n\n- src/ 保存应用源码。\n- docs/ 保存使用说明。\n- package.json 声明项目依赖与脚本。\n\n## 开发约定\n\n先说明目标，再提交任务。涉及文件写入时，先阅读待审批内容。\n\n## 当前任务\n\n为新同事补充一份可以按顺序操作的快速开始指南。`;
const quickstart = `# 快速开始\n\n这份指南帮助你完成示例项目的第一次本地运行。\n\n## 准备环境\n\n安装项目要求的 Node.js 与 pnpm，并在终端进入项目根目录。\n\n## 安装依赖\n\n\`\`\`sh\npnpm install\n\`\`\`\n\n等待安装结束，确认终端没有错误提示。\n\n## 启动项目\n\n\`\`\`sh\npnpm dev\n\`\`\`\n\n打开终端显示的本地地址。看到项目页面后，保留终端以便查看输出。\n\n## 提交第一个任务\n\n1. 在任务输入框说明你要完成的目标。\n2. 发送需求，阅读处理中出现的步骤。\n3. 需要写入文件时，检查路径与内容，再允许一次。\n4. 等待明确的完成结果，打开交付物核对。\n\n## 核对结果\n\n确认文件包含预期内容，再继续下一项工作。审批已提交只表示决定被受理，完成结果随后到达。\n\n若出现明确失败，按说明修正后开始新尝试。若结果未知，先核对原操作，不要重复发送。\n\n## 接下来\n\n阅读项目说明，了解代码目录和开发约定。将需要补充的问题记录到下一条任务草稿。`;
type Resource = { id: string; name: string; path: string; body: string; runId?: string };
function resources(state: Candidate): Resource[] {
  const completed = [...state.history, state.execution].filter((value): value is Extract<Execution, { kind: "completed" }> => value.kind === "completed");
  return [{ id: "readme", name: "项目说明.md", path: "README.md", body: readme }, ...completed.map(value => ({ id: value.run.id, runId: value.run.id, name: "快速开始.md", path: "docs/快速开始.md", body: quickstart }))];
}
function turn(execution: Exclude<Execution, { kind: "idle" }>): Data {
  const { run } = execution;
  const preparing = execution.kind !== "running" || execution.phase === "preparing";
  const text = execution.kind === "completed" ? `${execution.reconciled ? "已核对迟到的本地演示结果。" : "已完成本地演示写入。"}快速开始指南包含环境准备、安装、启动和第一个任务。你可以打开文件核对，再继续下一条需求。`
    : execution.kind === "denied" ? "你已拒绝写入，本次任务已结束。没有生成交付物。"
    : execution.kind === "failed" ? execution.reason === "readonly" ? "示例目录为只读，写入尚未开始。可编辑需求，再开始一次新的演示。" : "本地演示已停止，后续定时事件已取消。没有生成交付物。"
    : execution.kind === "unknown" ? "写入结果尚未确认。保留本次请求，不重复发送。你可以核对演示中迟到的结果。"
    : execution.kind === "writing" ? "批准结果已到达，正在将指南写入示例文件。"
    : execution.kind === "acknowledged" ? "已收到你的决定，等待后续执行结果。"
    : execution.kind === "awaiting-approval" ? "已整理好指南。写入前请检查下面的文件路径与内容。"
    : execution.phase === "accepted" ? "已收到需求，开始检查示例项目。"
    : execution.phase === "reading" ? "正在阅读项目说明，核对安装与启动方式。" : "已核对项目结构，正在整理快速开始指南。";
  const items: Data[] = [
    { id: `${run.id}-user`, type: "userMessage", content: [{ type: "text", text: run.prompt }] },
    { id: `${run.id}-read`, type: "agentMessage", phase: "commentary", text: "先阅读项目说明，再补充一份可以跟着操作的指南。" },
  ];
  if (execution.kind !== "running" || execution.phase !== "accepted") items.push({ id: `${run.id}-tool`, type: "dynamicToolCall", tool: "读取项目说明", status: "completed", success: true, arguments: { path: "README.md" }, contentItems: [{ type: "text", text: "已读取项目结构、开发约定与当前任务。" }] });
  if (preparing) items.push({ id: `${run.id}-plan`, type: "agentMessage", phase: "commentary", text: "指南将包含准备环境、安装依赖、启动项目、提交任务与核对结果。" });
  items.push({ id: `${run.id}-response`, type: "agentMessage", phase: isFinished(execution) ? "final_answer" : "commentary", text });
  return { id: run.id, status: execution.kind === "failed" ? execution.reason === "stopped" ? "interrupted" : "failed" : execution.kind === "denied" ? "interrupted" : execution.kind === "completed" ? "completed" : "inProgress",
    ...(execution.kind === "failed" && execution.reason === "readonly" ? { error: { message: "示例目录为只读，写入尚未开始。" } } : {}), startedAt: run.startedAt, items };
}
function project(state: Candidate) {
  const thread = { id: threadId, preview: "快速开始指南", updatedAt: 1, turns: [...state.history.map(turn), ...(state.execution.kind === "idle" ? [] : [turn(state.execution)])] };
  const data: Data = { id: projectId, root: "/示例项目", pending: [], models: [{ providerId: "preview", modelId: "local", displayName: "本地演示模型" }],
    core: { instanceId: "candidate", connectionGeneration: state.generation },
    configurations: { [threadId]: { model: { providerId: "preview", modelId: "local" } } },
    state: { connected: true, threads: { [threadId]: thread }, interactions: state.execution.kind === "awaiting-approval" || state.execution.kind === "acknowledged" ? { [threadId]: { data: [{ requestId: state.execution.run.requestId, turnId: state.execution.run.id, status: "pending" }] } } : {}, queues: {} } };
  return { data, thread };
}

export function ProductCandidate() {
  const [state, dispatch] = useReducer(reduce, initial);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const current = useRef(state);
  current.current = state;
  const input = useRef<LexicalChatInputHandle | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const { data, thread } = useMemo(() => project(state), [state]);
  const files = resources(state);
  const location = state.location;
  const resourceLocation = location.kind === "resource" ? location : location.kind === "settings" ? state.returns.at(-1)?.location : undefined;
  const selected = resourceLocation?.kind === "resource" ? files.find(file => file.id === resourceLocation.id) : undefined;
  const busy = unresolved(state.execution);
  const settingsOpen = location.kind === "settings";
  const chatHidden = settingsOpen || (narrow && location.kind === "resource") || (narrow && state.navigationOpen);
  const activeRun = state.execution.kind === "idle" ? undefined : state.execution.run;
  const approval = state.execution.kind === "awaiting-approval" || state.execution.kind === "acknowledged" ? {
    requestId: state.execution.run.requestId, threadId, tool: "写入文件", effectiveArguments: { 文件路径: "docs/快速开始.md", 内容摘要: "环境准备、安装依赖、启动项目、首个任务与结果核对" }, effectivePermissions: { rememberAllowed: false },
  } : undefined;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const execution = state.execution;
    if (execution.kind !== "running" && execution.kind !== "acknowledged" && execution.kind !== "writing") return;
    const timer = window.setTimeout(() => dispatch({ type: "advance", runId: execution.run.id, generation: execution.run.generation }), execution.kind === "acknowledged" ? 1100 : execution.kind === "writing" ? 1200 : 950);
    return () => window.clearTimeout(timer);
  }, [state.execution]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const palette = paletteVariables(DEFAULT_PALETTES.light);
    const savedVariables = Object.keys(palette).map(name => ({ name, value: root.style.getPropertyValue(name), priority: root.style.getPropertyPriority(name) }));
    const before = { dark: root.classList.contains("dark"), lightPreset: root.classList.contains("theme-areal-light"), darkPreset: root.classList.contains("theme-areal-dark"), colorScheme: root.style.colorScheme, reducedMotion: root.getAttribute("data-reduced-motion"), uiSize: root.style.getPropertyValue("--ui-font-size"), contentSize: root.style.getPropertyValue("--content-font-size") };
    return () => {
      for (const { name, value, priority } of savedVariables) {
        if (value) root.style.setProperty(name, value, priority); else root.style.removeProperty(name);
      }
      root.classList.toggle("dark", before.dark); root.classList.toggle("theme-areal-light", before.lightPreset); root.classList.toggle("theme-areal-dark", before.darkPreset); root.style.colorScheme = before.colorScheme;
      if (before.reducedMotion === null) root.removeAttribute("data-reduced-motion"); else root.setAttribute("data-reduced-motion", before.reducedMotion);
      for (const [name, value] of [["--ui-font-size", before.uiSize], ["--content-font-size", before.contentSize]]) {
        if (value) root.style.setProperty(name, value); else root.style.removeProperty(name);
      }
    };
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(paletteVariables(DEFAULT_PALETTES[state.preferences.theme], state.preferences.theme === "dark"))) root.style.setProperty(name, value);
    root.classList.toggle("dark", state.preferences.theme === "dark");
    root.classList.toggle("theme-areal-light", state.preferences.theme === "light");
    root.classList.toggle("theme-areal-dark", state.preferences.theme === "dark");
    root.style.colorScheme = state.preferences.theme;
    root.style.setProperty("--ui-font-size", `${state.preferences.uiSize}px`);
    root.style.setProperty("--content-font-size", `${state.preferences.contentSize}px`);
    root.dataset.reducedMotion = String(state.preferences.reducedMotion);
  }, [state.preferences]);
  useLayoutEffect(() => {
    if (!state.focus.id) return;
    const frame = requestAnimationFrame(() => {
      if (state.focus.id === "input") input.current?.focus();
      else shell.current?.querySelector<HTMLElement>(`[data-candidate-focus="${state.focus.id}"]`)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.focus]);
  const action = useCallback((async (name: string, params?: Data) => {
    const latest = current.current.execution;
    if (name === "respond" && latest.kind === "awaiting-approval" && params?.projectId === projectId && params.threadId === threadId && params.requestId === latest.run.requestId && (params.decision === "allowOnce" || params.decision === "deny")) {
      dispatch({ type: "decide", runId: latest.run.id, requestId: latest.run.requestId, generation: latest.run.generation, decision: params.decision });
      return { accepted: true };
    }
    if (name === "manage" && params?.operation === "interactions" && params.projectId === projectId && params.threadId === threadId) return { pending: latest.kind === "awaiting-approval" };
    throw new Error("此本地候选不支持该操作。");
  }) as Action, []);
  const openResource = (id: string, focus: string) => dispatch({ type: "open", location: { kind: "resource", id }, focus });
  const settings = () => dispatch({ type: "open", location: { kind: "settings" }, focus: "settings" });
  const reset = () => { dispatch({ type: "reset" }); input.current?.setText(""); };
  const submit = (text: string) => {
    if (!text.trim() || unresolved(current.current.execution)) return false;
    dispatch({ type: "submit", text, startedAt: Math.floor(Date.now() / 1000) });
    if (current.current.draft === text) input.current?.setText("");
    return true;
  };
  const delivered = state.execution.kind === "completed" ? state.execution : undefined;
  return <WorkbenchShell ref={shell} className="product-candidate" data-testid="product-candidate" data-execution={state.execution.kind} data-run-id={activeRun?.id ?? ""} data-settings={settingsOpen} data-resource={location.kind === "resource"} data-navigation={state.navigationOpen} data-reduced-motion={state.preferences.reducedMotion}>
    <NavigationSidebar className="candidate-sidebar" width={248} hidden={narrow && !state.navigationOpen} inert={narrow && !state.navigationOpen}
      chrome={<div className="candidate-brand"><img src={startupIcon} alt="" width={25} height={25} /><strong>AReaL Harness</strong>{narrow && <Button variant="ghost" size="icon-sm" aria-label="关闭导航" onClick={() => dispatch({ type: "navigation", open: false })}><CloseIcon /></Button>}</div>}
      footer={<div className="candidate-sidebar-footer"><span>本地交互演示，不连接服务</span><a href={window.location.pathname}>返回设计预览</a></div>}>
      <nav className="candidate-navigation" aria-label="项目与任务">
        <p className="candidate-navigation-label">项目</p>
        <div className="candidate-project"><FileReference /><span>示例项目</span></div>
        <p className="candidate-navigation-label">当前任务</p>
        <button type="button" className="candidate-task" aria-current="page" data-candidate-focus="task" onClick={() => dispatch({ type: "chat" })}><span>快速开始指南</span><small>{phaseText[state.execution.kind]}</small></button>
      </nav>
    </NavigationSidebar>
    <main className="candidate-workspace" hidden={narrow && state.navigationOpen} inert={narrow && state.navigationOpen}>
      <WorkspaceHeader className="candidate-header">
        <div className="candidate-heading">{narrow && <Button variant="ghost" size="icon-sm" aria-label="打开导航" data-candidate-focus="navigation" onClick={() => dispatch({ type: "navigation", open: true })}><SidebarToggleIcon /></Button>}<div><h1>快速开始指南</h1><span>示例项目</span></div></div>
        <div className="candidate-header-actions">
          {!settingsOpen && <Button variant="ghost" size="sm" aria-label="查看资源" data-candidate-focus="resources" onClick={() => openResource(files.at(-1)!.id, "resources")}><FileReference /><span>资源</span></Button>}
          {!settingsOpen && <Button variant="ghost" size="icon-sm" aria-label="打开设置" data-candidate-focus="settings" onClick={settings}><Settings /></Button>}
          <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="本地演示">本地演示</Button>} />
            <DropdownMenuContent align="end" ><p className="px-2 py-1 text-ui-sm text-foreground-subtle">场景应用于下一次发送。</p>
              <DropdownMenuRadioGroup value={state.scenario} onValueChange={value => { if (value === "normal" || value === "failure" || value === "unknown") dispatch({ type: "scenario", scenario: value }); }}>
                <DropdownMenuRadioItem value="normal">正常路径</DropdownMenuRadioItem><DropdownMenuRadioItem value="failure">明确失败</DropdownMenuRadioItem><DropdownMenuRadioItem value="unknown">结果未知</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup><DropdownMenuSeparator /><DropdownMenuItem onClick={reset}>重置演示</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </WorkspaceHeader>
      <div className="candidate-body">
        <section className="candidate-conversation" aria-label="任务对话" hidden={chatHidden} inert={chatHidden}>
          <Messages project={data} thread={thread} action={action} dark={state.preferences.theme === "dark"} readOnly reserveResponseSpace={false}
            onLink={url => { if (url.endsWith("README.md")) openResource("readme", "readme"); }} onFile={path => { const file = files.find(value => value.path === path); if (file) openResource(file.id, "resources"); }} onReview={() => {}} readTurnReview={async () => ({})}
            beforeTurns={state.execution.kind === "idle" ? <div className="candidate-empty"><h2>从一个清楚的需求开始</h2><p>让助手为示例项目整理一份快速开始指南。你可以先改写需求，写入前再检查并批准。</p><Button variant="outline" size="sm" aria-label="使用示例需求" onClick={() => { dispatch({ type: "edit", text: examplePrompt }); input.current?.setText(examplePrompt); input.current?.focus(); }}>使用示例需求</Button><button type="button" className="candidate-inline-link" data-candidate-focus="readme" onClick={() => openResource("readme", "readme")}>先阅读项目说明</button></div> : undefined}
            afterTurns={<div className="candidate-turn-footer">
              {approval && <><details className="candidate-proposal"><summary>查看拟写内容</summary><div className="candidate-proposal-content"><MessageResponse className="conversation-markdown" theme={state.preferences.theme}>{quickstart}</MessageResponse></div></details><ApprovalRequest key={approval.requestId} item={approval} projectId={projectId} action={action} /></>}
              {delivered && <Button variant="outline" size="sm" data-testid="candidate-deliverable" data-candidate-focus="deliverable" onClick={() => openResource(delivered.run.id, "deliverable")}><FileReference />打开快速开始.md</Button>}
              {state.execution.kind === "unknown" && <div className="candidate-reconcile"><Button variant="outline" size="sm" onClick={() => { if (activeRun) dispatch({ type: "reconcile", runId: activeRun.id, generation: activeRun.generation }); }}>核对演示结果</Button><p>读取本次演示的迟到结果，不重新执行写入。</p></div>}
            </div>} />
          <div className="composer-dock candidate-composer-dock"><div className="candidate-execution" role="status"><span className="candidate-motion-sample" data-testid="candidate-motion-sample">{phaseText[state.execution.kind]}</span>{busy && state.execution.kind !== "unknown" && <Button variant="ghost" size="sm" aria-label="停止演示任务" onClick={() => dispatch({ type: "stop" })}><StopIcon />停止</Button>}</div>
            <ConversationComposer project={data} modelConfig={data.configurations[threadId]} modelDisabled onConfigureModel={() => { throw new Error("本候选只使用本地演示模型。"); }}
              workspacePath="/示例项目" taskId={threadId} initialValue="" inputApiRef={input} inputTestId="candidate-input" submitTestId="candidate-send" placeholder={busy ? "可以先写下一条需求" : "描述你想完成的事"} submitLabel="发送需求" enterSubmits enableMentionPanel={false}
              submitDisabled={busy || !state.draft.trim()} onChange={text => dispatch({ type: "edit", text })} onSubmit={submit} />
            <p className="candidate-composer-note">{state.scenario !== "normal" ? `下一次发送将演示${state.scenario === "failure" ? "明确失败" : "结果未知"}。` : "本地交互演示，不连接服务"}</p>
          </div>
        </section>
        <aside className="candidate-resource" aria-label="任务资源" hidden={location.kind !== "resource"} inert={location.kind !== "resource"}>
          <div className="candidate-resource-header"><Button variant="ghost" size="sm" onClick={() => dispatch({ type: "back" })} aria-label="返回对话"><NavigationBackIcon />返回对话</Button><span>任务资源</span></div>
          <nav className="candidate-resource-list" aria-label="可用文件">{files.map(file => <Button key={file.id} variant="ghost" size="sm" aria-pressed={selected?.id === file.id} onClick={() => dispatch({ type: "open", location: { kind: "resource", id: file.id }, focus: "resources" })}><FileReference />{file.name}</Button>)}</nav>
          <div className="candidate-reader" data-testid="candidate-reader" data-candidate-focus="reader" tabIndex={0} aria-label="文件阅读"><div className="candidate-file-heading"><h2>{selected?.name}</h2><span>{selected?.path}</span></div><MessageResponse className="conversation-markdown" theme={state.preferences.theme}>{selected?.body ?? ""}</MessageResponse></div>
        </aside>
        <section className="candidate-settings" hidden={!settingsOpen} inert={!settingsOpen} aria-label="候选设置"><div className="candidate-settings-back"><Button variant="ghost" size="sm" aria-label="返回上一工作区" data-candidate-focus="settings-back" onClick={() => dispatch({ type: "back" })}><NavigationBackIcon />返回{selected ? "文件" : "对话"}</Button></div>
          <SettingsPage title="设置" subtitle="仅在当前候选生效，刷新后恢复默认值。"><SettingsSection title="外观与阅读" description="调整工作台与内容的阅读方式。"><SettingsGroupCard>
            <SettingsRow label="外观" control={<SettingsSelect aria-label="外观" value={state.preferences.theme} onValueChange={value => dispatch({ type: "preferences", value: { theme: value === "dark" ? "dark" : "light" } })}><option value="light">明亮</option><option value="dark">深色</option></SettingsSelect>} />
            <SettingsRow label="界面字号" description="导航、按钮和设置文字。" control={<SettingsSelect aria-label="界面字号" value={state.preferences.uiSize} onValueChange={value => dispatch({ type: "preferences", value: { uiSize: value === "18" ? "18" : "14" } })}><option value="14">14</option><option value="18">18</option></SettingsSelect>} />
            <SettingsRow label="内容字号" description="对话消息和文件正文。" control={<SettingsSelect aria-label="内容字号" value={state.preferences.contentSize} onValueChange={value => dispatch({ type: "preferences", value: { contentSize: value === "18" ? "18" : "14" } })}><option value="14">14</option><option value="18">18</option></SettingsSelect>} />
            <SettingsRow label="减少动态效果" description="关闭本候选的界面动画和过渡，任务处理时间保持不变。" control={<SettingsSwitch aria-label="减少动态效果" checked={state.preferences.reducedMotion} onCheckedChange={reducedMotion => dispatch({ type: "preferences", value: { reducedMotion } })} />} />
          </SettingsGroupCard></SettingsSection><SettingsSection title="阅读示例"><p className="candidate-settings-sample">清楚的需求、可检查的过程、明确的完成结果。</p></SettingsSection></SettingsPage>
        </section>
      </div>
    </main>
  </WorkbenchShell>;
}
