import { ContentSystemPreview } from "./ContentSystemPreview.js";
import { ToastHost } from "../ToastHost.js";
import { FeedbackNotice } from "../FeedbackNotice.js";
import { ArtifactReviewExercise } from "./ArtifactReviewExercise.js";
import { DesignDashboard } from "./DesignDashboard.js";
import { ProductCandidate } from "./ProductCandidate.js";
import { DesignDocument } from "./DesignDocument.js";
import { ApplicationIntlProvider } from "../i18n/IntlProvider.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "../workbench.css";
import "./preview.css";
import { ConversationComposer } from "../ConversationComposer.js";
import { ApprovalRequest } from "../ApprovalRequest.js";
import { SideChatPane } from "../SideChatPane.js";
import { RefreshIcon } from "../interfaceIcons.js";
import { ActionButton } from "../components/ui/action-button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsSegmentedTabs } from "../settings/SettingsSegmentedTabs.js";
import { SettingsDisclosure } from "../settings/SettingsDisclosure.js";
import { SettingsPage } from "../settings/SettingsWorkspace.js";
import { SettingsGroupCard, SettingsRow, SettingsSelect, SettingsSection } from "../settings/SettingsPageParts.js";
import { Button } from "../components/ui/button.js";
import { Feedback } from "../components/ui/feedback.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { TurnActivity } from "../TurnExecution.js";
import { Messages } from "../Messages.js";
import { DecisionTransferExercise } from "./DecisionTransferExercise.js";
import { SettingsReflowExercise } from "./SettingsReflowExercise.js";
import { ConversationFlowExercise } from "./ConversationFlowExercise.js";
import { SharedWorkspacePreview } from "./SharedWorkspacePreview.js";
import { SettingsPreview } from "./SettingsPreview.js";
import { ConversationTimelinePreview } from "./ConversationTimelinePreview.js";
import { ConversationSystemPreview } from "./ConversationSystemPreview.js";
import { UiLibraryPreview } from "./UiLibraryPreview.js";
import type { LexicalChatInputHandle } from "../LexicalChatInput.js";
import type { Action, CommandName } from "../services.js";
import { tokenGroups, baseCandidate } from "./catalog.js";
import { setApplicationPreferences, useAppearance } from "../settings/applicationPreferences.js";

const project = {
  id: "design-preview", root: "/preview", pending: [],
  core: { instanceId: "design-preview", connectionGeneration: 1, features: { sidePreview: true } },
  state: { connected: true, threads: {}, interactions: {}, queues: {} },
  models: [{ providerId: "preview", modelId: "example", displayName: "示例模型", reasoningEffortOptions: ["low", "medium", "high"] }],
  configurations: { main: { model: { providerId: "preview", modelId: "example" }, parameters: { reasoningEffort: "medium" } } },
};
const source = { id: "main", preview: "示例主聊天", turns: [], updatedAt: 1 };
const approval = { requestId: "preview-approval", threadId: "main", tool: "fs_create",
  effectiveArguments: { path: "example.txt", text: "示例文本 Example content" }, effectivePermissions: { rememberAllowed: true } };
const states = { ready: "可操作", busy: "提交中", failed: "明确失败", unknown: "结果待核对" } as const;
type PreviewState = keyof typeof states;

const longMessage = `# 长消息预览\n\n${Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 段：保留原始内容，长文本默认展示开头，展开后可完整阅读。 Long text stays complete and readable.`).join("\n\n")}\n\n[末尾链接](https://example.com)\n\n全文结束 END_OF_LONG_MESSAGE`;
const messagePreview = { id: "long-text-preview", turns: [{ id: "preview-messages", status: "completed", items: [
  { id: "long", type: "userMessage", content: [{ type: "text", text: longMessage }] },
  { id: "short", type: "userMessage", content: [{ type: "text", text: "短消息直接完整展示。" }] },
  { id: "wrapped", type: "userMessage", content: [{ type: "text", text: "随宽度重新判断折叠，文字保留。".repeat(12) }] },
] }] };

const motionText = "流式文字沿用当前主题，新内容柔和显现，已经读过的内容保持稳定。\n\nStreaming text stays readable as each new fragment arrives.\n\n- 支持**加粗**和 `行内代码`\n- 保留中文、English 与换行";
function ChatMotionPreview({ dark }: { dark: boolean }) {
  const [length, setLength] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    let cursor = 0;
    setLength(0);
    const timer = setInterval(() => {
      cursor = Math.min(cursor + 8, motionText.length);
      setLength(cursor);
      if (cursor === motionText.length) setPlaying(false);
    }, 120);
    return () => clearInterval(timer);
  }, [playing]);
  return <section className="design-preview-panel" aria-label="聊天动效预览">
    <h2>流式输出与等待状态</h2>
    <TurnActivity turn={{ id: "preview-turn", status: "inProgress", items: [] }} project={project} threadId="main" />
    <div className="design-preview-actions">
      <Button variant="outline" disabled={playing} onClick={() => setPlaying(true)}>播放流式输出</Button>
      <Button variant="ghost" disabled={playing} onClick={() => setLength(value => Math.min(value + 8, motionText.length))}>追加片段</Button>
      <Button variant="ghost" disabled={playing} onClick={() => setLength(motionText.length)}>完成输出</Button>
    </div>
    <div data-testid="preview-stream"><MessageResponse className="conversation-markdown" preserveLineBreaks streaming={length > 0 && length < motionText.length} theme={dark ? "dark" : "light"}>{motionText.slice(0, length)}</MessageResponse></div>
  </section>;
}

function Preview() {
  const [dark, setDark] = useState(() => new URLSearchParams(window.location.search).has("conversation-system"));
  const [fontSize, setFontSize] = useState("14");
  const [width, setWidth] = useState("wide");
  const [state, setState] = useState<PreviewState>("ready");
  const [text, setText] = useState("");
  const [closeBehavior, setCloseBehavior] = useState<string | null>("shortcut");
  const [showPanel, setShowPanel] = useState(true);
  const [panelLocation, setPanelLocation] = useState<"bottom" | "right">("bottom");
  const [message, setMessage] = useState("");
  const [operationNotice, setOperationNotice] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);
  const reuseExercise = new URLSearchParams(window.location.search).has("reuse-exercise");
  const sharedWorkspace = new URLSearchParams(window.location.search).has("shared-workspace");
  const conversationExercise = new URLSearchParams(window.location.search).has("conversation-exercise");
  const conversationSystem = new URLSearchParams(window.location.search).has("conversation-system");
  const contentSystem = new URLSearchParams(window.location.search).has("content-system");
  const uiLibrary = new URLSearchParams(window.location.search).has("ui-library");
  const decisionExercise = new URLSearchParams(window.location.search).has("decision-exercise");
  const exercise = new URLSearchParams(window.location.search).has("settings-exercise");
  const [exerciseContent, setExerciseContent] = useState("reference");
  const [values, setValues] = useState<Record<string, string>>({});
  const api = useRef<LexicalChatInputHandle | null>(null);
  useAppearance(dark);
  useLayoutEffect(() => {
    if (conversationExercise || conversationSystem) setApplicationPreferences({ contentSize: Number(fontSize) });
  }, [conversationExercise, conversationSystem, fontSize]);
  useLayoutEffect(() => { setApplicationPreferences({ reducedMotion: reducedMotion ? "on" : "off" }); }, [reducedMotion]);
  useEffect(() => {
    let fragment = window.location.hash.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch {}
    const target = fragment && document.getElementById(fragment);
    if (target) target.scrollIntoView();
    else document.querySelector(".design-preview")?.scrollTo(0, 0);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("theme-areal-light", !dark);
    root.classList.toggle("theme-areal-dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    root.style.setProperty("--ui-font-size", `${fontSize}px`);
    const css = getComputedStyle(root);
    setValues(Object.fromEntries(tokenGroups.flatMap(group => group.tokens.map(([name]) => [name, css.getPropertyValue(name).trim()]))));
  }, [dark, fontSize]);
  // fixture 只接受 respond；其余 Action 重载均明确拒绝，不伪造业务返回值。
  // 只反馈本地状态，不读取 preload，也不连接 Core 或供应商。
  const action = (async (name: CommandName) => {
    if (name !== "respond") throw new Error("组件预览保留业务入口，不执行真实操作。");
    if (state === "busy") return new Promise<never>(() => {});
    if (state === "failed") throw new Error("示例：操作未受理，内容已保留。");
    if (state === "unknown") throw Object.assign(new Error("示例：等待核对"), { submissionUnknown: true });
    return {};
  }) as Action;
  const disabled = state === "busy" || state === "unknown";
  return <main className="design-preview" data-width={width} data-view={new URLSearchParams(window.location.search).has("conversation") ? "conversation" : new URLSearchParams(window.location.search).has("settings") ? "settings" : undefined}>
    <header className="design-preview-header">
      <div><h1>客户端设计系统</h1><p>{uiLibrary ? "私有 workspace 包 · 首批实现，未发布" : conversationSystem ? "对话流候选 · 独立预览，未接入生产页面" : <>生产组件与语义 Token · Base {baseCandidate.version}（{({ "frozen-beta": "有限 beta 已冻结", candidate: "候选未冻结" })[baseCandidate.status]}）</>}</p>
        <nav className="design-preview-navigation" aria-label="设计预览导航"><a href="?dashboard">建设看板</a><a href="?ui-library">UI 包与架构</a><a href="?conversation-system">对话流设计</a><a href="?product-candidate">完整产品候选</a><a href="?reuse-exercise">独立复用题</a><a href="?docs=design/README.md">设计说明</a><a href={`${window.location.pathname}#controls`}>组件示例</a>
          {new URLSearchParams(window.location.search).get("returnTo")?.startsWith("?docs=") && <a href={`${window.location.pathname}${new URLSearchParams(window.location.search).get("returnTo")}`}>返回来源设计说明</a>}
        </nav></div>
      <label>主题<select aria-label="主题" value={dark ? "dark" : "light"} onChange={event => setDark(event.target.value === "dark")}><option value="light">明亮</option><option value="dark">深色</option></select></label>
      <label>字号<select aria-label="字号" value={fontSize} onChange={event => setFontSize(event.target.value)}><option value="14">14</option><option value="18">18</option></select></label>
      <label>面板宽度<select aria-label="面板宽度" value={width} onChange={event => setWidth(event.target.value)}><option value="wide">宽面板</option><option value="narrow">窄面板</option></select></label>
      {!reuseExercise && !conversationSystem && !uiLibrary && <label>状态<select aria-label="状态" value={state} onChange={event => { setState(event.target.value as PreviewState); setMessage(""); }}>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      <label>减少动态效果<input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /></label>
      {exercise && <label>题目内容<select aria-label="题目内容" value={exerciseContent} onChange={event => setExerciseContent(event.target.value)}><option value="reference">参考内容</option><option value="stress">长文案</option></select></label>}
    </header>
    {contentSystem ? <ContentSystemPreview dark={dark} /> : uiLibrary ? <UiLibraryPreview dark={dark} fontSize={fontSize} /> : conversationSystem ? <ConversationSystemPreview dark={dark} /> : reuseExercise ? <section id="artifact-review-exercise" className="design-preview-panel" aria-label="交付物核对"><ArtifactReviewExercise baseVersion={baseCandidate.version} /></section> : sharedWorkspace ? <SharedWorkspacePreview dark={dark} /> : conversationExercise ? <ConversationFlowExercise dark={dark} /> : decisionExercise ? <DecisionTransferExercise key={state} state={state} /> : exercise ? <SettingsReflowExercise key={exerciseContent} stress={exerciseContent === "stress"} state={state} /> : <>
    <SettingsPreview />
    <section id="controls" className="design-preview-panel" aria-label="公共控件">
      <h2>设置控件 · 按交互选择</h2>
      <p className="text-ui-sm text-foreground-subtle">执行操作用按钮，开启或关闭用开关，多项选择用下拉，仅两个选项直接并排选择。</p>
      <SettingsPage><SettingsSection>
      <SettingsGroupCard>
        <SettingsRow label="导入配置" description="点击后执行一次操作；普通操作直接显示文字。" control={<ActionButton onClick={() => setMessage("导入入口仅作组件预览。")}>导入</ActionButton>} />
        <SettingsRow label="聊天存储位置" description="项目外聊天的默认位置。" control={<ActionButton onClick={() => setMessage("目录选择仅作组件预览。")}>更改</ActionButton>} />
        <SettingsRow label="显示底部面板" description="开或关：切换后立即更新，用左右滑动的开关表示状态。" control={<Switch aria-label="显示底部面板" checked={showPanel} onCheckedChange={setShowPanel} />} />
        <SettingsRow label="默认终端位置" description="只有两个互斥选项：直接展示两个选项，选中项保持高亮。" control={<SettingsSegmentedTabs ariaLabel="默认终端位置" items={[{value: "bottom", label: "底部"}, {value: "right", label: "右侧"}]} value={panelLocation} onValueChange={setPanelLocation} />} />
        <SettingsRow label="关闭窗口前确认" description="三个及以上选项：下拉按钮显示当前值，展开后选择。" control={
          <SettingsSelect aria-label="关闭窗口前确认" value={closeBehavior ?? "never"} onValueChange={setCloseBehavior}>
            <option value="never">从不</option><option value="shortcut">仅关闭快捷键</option><option value="always">始终</option>
          </SettingsSelect>} />
        <SettingsRow label="开源许可" description="查看随应用分发的第三方声明。" control={<ActionButton onClick={() => setMessage("许可入口仅作组件预览。")}>查看</ActionButton>} />
      </SettingsGroupCard>
      <SettingsDisclosure title="高级设置详情"><p>原地展开保留明确的展开 / 收起动作和键盘语义。</p></SettingsDisclosure>
      </SettingsSection><SettingsSection title="样式与状态">
      <div className="design-preview-actions" aria-label="按钮样式与状态">
        <Button size="sm">主要操作</Button>
        <ActionButton>普通操作</ActionButton>
        <Button size="sm" variant="outline">描边操作</Button>
        <Button size="sm" variant="ghost">辅助操作</Button>
        <ActionButton variant="destructive-subtle">停止服务</ActionButton>
        <Button size="sm" variant="destructive">删除</Button>
        <ActionButton disabled>不可用</ActionButton>
        <ActionButton pending={state === "busy"} onClick={() => setMessage("状态已刷新。")}>刷新状态</ActionButton>
        <Button size="icon-sm" variant="ghost" aria-label="刷新预览" onClick={() => setMessage("状态已刷新。 ")}><RefreshIcon /></Button>
        <Button variant="outline" onClick={() => setOperationNotice("示例操作失败，输入已保留。")}>触发操作失败提醒</Button>
      </div>
      {operationNotice && <FeedbackNotice transient tone="error" message={operationNotice} actions={<></>} onDismiss={() => setOperationNotice("")} />}
      <Feedback error={state === "failed" ? "操作未受理，请检查后重试。" : undefined} message={state === "unknown" ? "结果待核对，保留当前内容。" : "反馈跟随所属组件，错误与等待保持不同含义。"} />
      </SettingsSection></SettingsPage>
    </section>
    <section className="design-preview-panel" aria-label="Composer 预览">
      <h2>Composer</h2>
      <div className="composer-dock">
        <ConversationComposer project={project} modelConfig={project.configurations.main} modelDisabled={disabled}
          onConfigureModel={() => setMessage("模型配置仅作预览。")}
          initialValue={text} inputApiRef={api} inputTestId="preview-composer" workspacePath="/preview" taskId="preview-main" placeholder="随心输入"
          disabled={disabled} submitDisabled={disabled || !text.trim()} submitting={state === "busy"} submitLabel="发送"
          enterSubmits enableMentionPanel={false} onChange={setText} onSubmit={() => { setMessage("预览收到输入，草稿保留。"); return false; }} />
      </div>
      <Feedback message={message} />
    </section>
    <ChatMotionPreview dark={dark} />
    <ConversationTimelinePreview dark={dark} />
    <section className="design-preview-panel design-preview-messages" aria-label="长文本预览">
      <h2>已发送消息 · 渐进展示</h2>
      <Messages project={project} thread={messagePreview} action={action} dark={dark} reserveResponseSpace={false}
        onLink={() => setMessage("链接入口仅作预览。")} onFile={() => {}} onReview={() => {}} readTurnReview={async () => ({})} />
    </section>
    <section className="design-preview-panel" aria-label="审批预览">
      <h2>审批卡片</h2><ApprovalRequest key={state} item={approval} projectId="design-preview" action={action} />
    </section>
    <section className="design-preview-panel design-preview-side" aria-label="Side 预览">
      <h2>Side Chat</h2><SideChatPane project={project} source={source} action={action} dark={dark} executionBlocked={false}
        onReturn={() => setMessage("关闭入口仅作预览。")} onPanel={() => setMessage("面板入口仅作预览。")} />
    </section>
    <section className="design-preview-tokens" aria-label="Token 目录">
      <h2>Token 角色与当前值</h2>{tokenGroups.map(group => <div key={group.title}><h3>{group.title}</h3><dl>{group.tokens.map(([name, role]) => <div key={name}><dt><code>{name}</code><span>{role}</span></dt><dd data-token={name}>{values[name]}</dd></div>)}</dl></div>)}
    </section>
    </>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<ApplicationIntlProvider><ToastHost /><TooltipProvider>{new URLSearchParams(window.location.search).has("dashboard") ? <DesignDashboard /> : new URLSearchParams(window.location.search).has("product-candidate") ? <ProductCandidate /> : new URLSearchParams(window.location.search).has("docs") ? <DesignDocument path={new URLSearchParams(window.location.search).get("docs")!} /> : <Preview />}</TooltipProvider></ApplicationIntlProvider>);
