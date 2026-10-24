import { ActivityGroup, Disclosure, ImageDisclosure, SubagentPanel, TaskContext, ThinkingStatus } from "@areal/ui/wip";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { FileTextIcon, GlobeIcon, ImageIcon } from "lucide-react";
import "@areal/ui/conversation.css";
import { ActivityIcon } from "../ActivityIcon.js";
import { AgentAvatar } from "../AgentIdentity.js";
import { ToolEvent } from "../ToolEvent.js";
import { SentAttachment } from "../MessageAttachment.js";
import { ConversationComposer } from "../ConversationComposer.js";
import { WorkbenchShell } from "../app-shell/WorkbenchShell.js";
import { ReviewPanelIcon } from "../app-shell/panelIcons.js";
import { Button } from "../components/ui/button.js";
import { Feedback } from "../components/ui/feedback.js";
import { SettingsSegmentedTabs } from "../settings/SettingsSegmentedTabs.js";
import { editedActivity, editReview, previewMedia, previewProject, previewSources, previewSubagents, readActivity, systemActivities, verificationActivity, type AgentMode, type PreviewSource, type SystemPhase } from "./conversationSystemScenario.js";
import "./conversation-system.css";

function SourceIcon({ kind }: { kind: PreviewSource["kind"] }) {
  return kind === "image" ? <ImageIcon size={16} /> : kind === "web" ? <GlobeIcon size={16} /> : <FileTextIcon size={16} />;
}

type Inspection = { kind: "sources" } | { kind: "add" } | { kind: "changes" } | { kind: "unknown" }
  | { kind: "source"; source: PreviewSource } | { kind: "file"; path: string };

const phaseItems = [
  { value: "running" as const, label: "运行中" }, { value: "completed" as const, label: "已完成" }, { value: "attention" as const, label: "需要关注" },
];

export function ConversationSystemPreview({ dark }: { dark: boolean }) {
  const [phase, setPhase] = useState<SystemPhase>("running");
  const [revision, setRevision] = useState(0);
  const [sourceCount, setSourceCount] = useState("5");
  const [draftSource, setDraftSource] = useState(false);
  const [imageAvailable, setImageAvailable] = useState(true);
  const [agentMode, setAgentMode] = useState<AgentMode>("mixed");
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [progressMode, setProgressMode] = useState("summary");
  const [progressIndex, setProgressIndex] = useState(0);
  const progressLabels = ["澄清动效与输出需求", "对比上下文卡片与资源面板", "核对组件规范与状态边界"];
  const progressLabel = progressMode === "thinking" ? undefined : progressMode === "long" ? "正在核对模型提供的公开过程摘要、工具活动与等待确认状态，检查不同字号下的完整阅读和返回路径。" : progressLabels[progressIndex % progressLabels.length];
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const agentInvoker = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  const contextHeading = useRef<HTMLHeadingElement>(null);
  const contextId = useId();
  const contextBeforeReader = useRef(false);
  const invoker = useRef<HTMLElement | null>(null);
  const sources: PreviewSource[] = [...previewSources.slice(0, Number(sourceCount)), ...(draftSource
    ? [{ id: "draft-web", kind: "web" as const, name: "新加入的网页引用", location: "example.com/draft", note: "草稿待发送" }] : [])];
  const activities = systemActivities(phase, revision);
  const agents = previewSubagents(agentMode);
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId);
  const childState = agentMode === "mixed" ? "运行中" : agentMode === "attention" ? "需要确认" : "已完成";
  const openAgents = (id?: string) => {
    agentInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    contextBeforeReader.current = contextOpen;
    setContextOpen(false); setSelectedAgentId(id); setAgentPanelOpen(true);
  };
  const closeAgents = () => {
    setAgentPanelOpen(false); setContextOpen(contextBeforeReader.current);
    requestAnimationFrame(() => agentInvoker.current?.focus({ preventScroll: true }));
  };
  const inspect = (next: Inspection) => {
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInspection(next);
    // Resource inspection opens the context card on every viewport size.
    setContextOpen(true);
  };
  const returnContext = () => {
    setInspection(null);
    requestAnimationFrame(() => (invoker.current?.isConnected ? invoker.current : contextHeading.current)?.focus({ preventScroll: true }));
  };
  const returnConversation = () => {
    setInspection(null); setContextOpen(false);
    requestAnimationFrame(() => contextTrigger.current?.focus({ preventScroll: true }));
  };
  const toggleContext = () => {
    if (agentPanelOpen) { setAgentPanelOpen(false); setContextOpen(true); }
    else if (contextOpen) returnConversation();
    else { setInspection(null); setContextOpen(true); }
  };
  useLayoutEffect(() => {
    if (inspection || contextOpen) contextHeading.current?.focus({ preventScroll: true });
  }, [inspection, contextOpen]);
  const sourceRow = (source: PreviewSource) => <TaskContext.Item key={source.id} title={source.name} description={source.note ?? source.location}
    icon={<SourceIcon kind={source.kind} />} aria-label={`查看来源：${source.name}`} onClick={() => inspect({ kind: "source", source })} />;
  const inspectionTitle = !inspection ? "任务上下文" : inspection.kind === "sources" ? "全部来源" : inspection.kind === "add" ? "添加输入来源"
    : inspection.kind === "changes" ? "未暂存变更" : inspection.kind === "unknown" ? "结果待核对" : inspection.kind === "source" ? inspection.source.name : inspection.path.split("/").at(-1)!;

  return <section className="conversation-system" aria-label="对话流设计预览" data-theme={dark ? "dark" : "light"}>
    <div className="cs-preview-bar">
      <div><h2>对话流 · 活动与上下文</h2><p>本地交互样例 · 所有执行与资源均为示例数据</p></div>
      <SettingsSegmentedTabs ariaLabel="任务状态" value={phase} onValueChange={setPhase} items={phaseItems} />
      <label>来源数量<select aria-label="来源数量" value={sourceCount} onChange={event => { setSourceCount(event.target.value); setDraftSource(false); }}>
        <option value="0">0 项 · 空态</option><option value="3">3 项</option><option value="5">5 项 · 含不可用引用</option>
      </select></label>
      <label>过程摘要<select aria-label="过程摘要" value={progressMode} onChange={event => setProgressMode(event.target.value)}>
        <option value="summary">模型摘要</option><option value="thinking">无摘要 · Thinking</option><option value="long">长摘要</option>
      </select></label>
      <Button variant="outline" size="sm" disabled={phase !== "running" && !agentPanelOpen} onClick={() => { setProgressMode("summary"); setProgressIndex(value => value + 1); }}>推进摘要样例</Button>
      <label>子任务状态<select aria-label="子任务状态" value={agentMode} onChange={event => setAgentMode(event.target.value as AgentMode)}>
        <option value="mixed">1 运行中 · 15 已完成</option><option value="completed">全部已完成</option><option value="attention">1 需要确认 · 15 已完成</option>
      </select></label>
      <label>图片状态<select aria-label="图片状态" value={imageAvailable ? "available" : "unavailable"} onChange={event => setImageAvailable(event.target.value === "available")}>
        <option value="available">可用</option><option value="unavailable">引用不可用</option>
      </select></label>
      <Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)} disabled={phase !== "running"}>追加命令输出</Button>
      <a href="?docs=clients/gui/design-system/conversation-flow.md">阅读规范</a>
    </div>
    <WorkbenchShell className="conversation-system-shell" data-context-open={contextOpen} data-agent-open={agentPanelOpen}>
      <header className="cs-chat-header"><span>整理对话流设计系统</span><Button ref={contextTrigger} variant="ghost" size="sm"
        aria-label="任务上下文" aria-expanded={contextOpen} aria-controls={contextId} onClick={toggleContext}>任务上下文</Button></header>
      <div className="cs-conversation">
        <div className="cs-transcript" role="region" aria-label="示例对话" tabIndex={0}>
          <div className="cs-reading-column">
            <p className="cs-user-message">把活动分组、图片和任务上下文整理为统一的对话流，保留按需展开与返回阅读。</p>
            <p className="cs-working"><span>{phase === "running" ? "Working for 2m 28s" : phase === "completed" ? "Worked for 16m 18s" : "结果待核对"}</span><small>本地历史样例</small></p>
            <p>我会先读取现有规范与组件，再整理活动的展示层级。命令、图片与子任务分别保留自己的入口。</p>
            <ActivityGroup indicator={<ActivityIcon kind="chevron" size={14} />} label="读取文件、运行命令 · 30 项活动" icon={<ActivityIcon kind="command" />}
              status={phase === "attention" ? <div className="cs-attention"><Feedback message="结果待核对 · 连接中断，命令是否退出尚未确认。" />
                <Button variant="outline" size="sm" onClick={() => inspect({ kind: "unknown" })}>查看待核对记录</Button></div>
                : <p role="status">{phase === "running" ? `正在检查组件 · 已收集 ${5 + revision * 3} 段输出` : "命令已退出 · 退出码 0"}</p>}>
                {activities.map(item => <ToolEvent key={item.id} item={item} projectId={previewProject.id} threadId="system-main"
                  onFile={path => inspect({ kind: "file", path })} />)}
            </ActivityGroup>
            <ImageDisclosure indicator={<ActivityIcon kind="chevron" size={14} />} label="已查看图片 · 界面参考.png"
              {...(imageAvailable ? { state: "available", children: <SentAttachment part={{ type: "image", uri: "areal://blob/system-image", name: "界面参考.png" }}
                projectId={previewProject.id} threadId="system-main" action={previewMedia} /> } : { state: "unavailable", message: "图片引用暂不可用；保留原活动记录。" })} />
            <ToolEvent item={readActivity} onFile={path => inspect({ kind: "file", path })} />
            <Button variant="ghost" className="cs-agent-activity" onClick={() => openAgents("layout")}>
              <AgentAvatar id="layout" size={16} /><span>对话布局检查</span><small>{childState}</small><span className="cs-row-action">查看</span>
            </Button>
            <ActivityGroup indicator={<ActivityIcon kind="chevron" size={14} />} label="已编辑文件、运行命令" icon={<ActivityIcon kind="edit" />}>
              <ToolEvent item={editedActivity} turnId="system-turn" readTurnReview={editReview} onFile={path => inspect({ kind: "file", path })} />
              <ToolEvent item={verificationActivity} />
              <p className="cs-detail-note">本次示例修改一行默认值；文件差异与命令输出分别查看。</p>
            </ActivityGroup>
            <p>活动摘要用于快速了解过程，展开后可以核对原始记录。右侧按项目、子任务和输入来源整理相关对象。</p>
            {phase === "completed" && <div className="cs-final"><h3>对话流预览已整理完成</h3><p>活动与图片可按需展开，来源支持三项预览和查看全部。可以继续切换主题、字号和窄窗，检查同一组内容的呈现。</p></div>}
            {phase === "attention" && <p>已保留当前记录。查看详情不会重新执行命令；子任务的状态需要分别确认。</p>}
            {phase === "running" && <div className="cs-thinking"><ThinkingStatus label={progressLabel} /></div>}
          </div>
        </div>
        <div className="cs-composer composer-dock"><ConversationComposer project={previewProject} modelConfig={previewProject.configurations.main}
          modelDisabled onConfigureModel={() => {}} initialValue={draft} inputTestId="system-preview-composer" workspacePath={previewProject.root}
          taskId="system-main" placeholder="补充这项任务…" submitDisabled submitLabel="发送" onChange={setDraft} onSubmit={() => false}
          enableMentionPanel={false} /></div>
      </div>
      <TaskContext id={contextId} hidden={!contextOpen} title={inspectionTitle} headingRef={contextHeading} onBack={inspection ? returnContext : undefined}
        onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !(event.target as HTMLElement).closest('[role="dialog"]')) { event.preventDefault(); returnConversation(); } }}
        actions={<Button variant="ghost" size="sm" className="cs-context-toggle" onClick={returnConversation}>返回对话</Button>}>
          <div hidden={!!inspection}>
            <TaskContext.Section label="当前项目变更" title="AReaL-Harness">
              <TaskContext.Item title="Changes" description="未暂存 · 2 个文件" icon={<ReviewPanelIcon />} onClick={() => inspect({ kind: "changes" })}
                meta={<span className="diff-count"><b>+24</b><em>−8</em></span>} />
            </TaskContext.Section>
            <TaskContext.Section label="关联项目">
              {["ZCode", "Classic-skills", "magpie"].map(name => <Disclosure indicator={<ActivityIcon kind="chevron" size={14} />} key={name} label={`展开关联项目 ${name}`} displayLabel={name} textRole="interface" className="cs-project" icon={<ActivityIcon kind="list" />}>
                <p className="cs-detail-note">同一工作上下文的关联项目</p><p className="cs-path">/preview/workspace/{name}</p>
                <Button variant="ghost" size="sm" onClick={() => inspect({ kind: "file", path: `${name}/README.md` })}>查看项目说明</Button>
              </Disclosure>)}
            </TaskContext.Section>
            <TaskContext.Section label="子代理列表">
              <TaskContext.Item title="Subagents" aria-label="查看全部 Subagents（16）" onClick={() => openAgents()} meta={<ActivityIcon kind="chevron" size={14} />} />
              <div className="cs-agent-summary"><AgentAvatar id="layout" size={18} /><AgentAvatar id="contract" size={18} /><AgentAvatar id="review" size={18} /><span>{agentMode === "completed" ? "16 个已完成" : agentMode === "attention" ? "1 个待确认 · 15 个已完成" : "1 个运行中 · 15 个已完成"}</span></div>
            </TaskContext.Section>
            <TaskContext.Sources items={sources} onViewAll={() => inspect({ kind: "sources" })} onAdd={() => inspect({ kind: "add" })}>{sourceRow}</TaskContext.Sources>
          </div>
          {inspection?.kind === "sources" && <section aria-label="全部来源"><p className="cs-detail-note">{sources.length} 项输入来源</p>{sources.map(sourceRow)}</section>}
          {inspection?.kind === "add" && <section aria-label="添加输入来源"><p>将参考资料加入未发送的草稿。</p><Button variant="outline" onClick={() => { setDraftSource(true); setInspection(null); }}>添加示例网页到草稿</Button></section>}
          {inspection?.kind === "source" && <section><p className="cs-path">{inspection.source.location}</p>{inspection.source.note && <Feedback message={inspection.source.note} />}
            {inspection.source.kind === "image" ? <SentAttachment part={{ type: "image", uri: "areal://blob/system-image", name: inspection.source.name }} projectId={previewProject.id} threadId="system-main" action={previewMedia} />
              : <p>{inspection.source.id === "raft" ? "参考其基础规则、通用控件、领域组合与产品布局的职责划分。此处展示本地引用摘要。" : "这是设计预览中的引用记录；来源身份与名称在返回后保留。"}</p>}</section>}
          {inspection?.kind === "file" && <section><p className="cs-path">{inspection.path}</p><pre className="cs-file-content">{`# 对话流设计\n\n活动按原始顺序组织。\n展开用于核对内容，返回后继续原来的阅读。`}</pre></section>}
          {inspection?.kind === "changes" && <section><p>当前项目 · 未暂存变更</p><p className="cs-detail-note">示例统计包含工作区变更，不将全部修改归为 Agent 产出。</p><pre className="cs-file-content">{`src/conversation/ActivityGroup.tsx  +16 −4\nsrc/conversation/Context.tsx         +8 −4`}</pre></section>}
          {inspection?.kind === "unknown" && <section><Feedback message="退出结果尚未确认；保留原命令记录。" /><p>processId: preview-process</p><p>最后一次观察：已收到部分输出，连接随后中断。</p><p className="cs-detail-note">这里只展示已收集记录，不执行重试或重新运行命令。</p></section>}
      </TaskContext>
      <SubagentPanel open={agentPanelOpen} agents={agents.map(agent => ({ ...agent, icon: <AgentAvatar id={agent.id} size={18} /> }))}
        selectedId={selectedAgentId} onSelect={setSelectedAgentId} onClose={closeAgents}>
        {selectedAgent && <>
          <p className="cs-working"><span>{selectedAgent.state === "running" ? "Working for 2m 28s" : selectedAgent.state === "completed" ? "Worked for 16m 18s" : "结果待确认"}</span><small>本地历史样例</small></p>
          <section className="cs-agent-request" aria-label="子任务请求"><p>检查活动分组、阅读返回和上下文来源，保留独立的子任务状态。</p></section>
          <p>我会先读取现有规范，再核对长命令、图片和来源入口的阅读路径。</p>
          <ActivityGroup label="读取规范、核对交互 · 3 项活动">
            <p>已读取对话流设计规范。</p><p>已核对活动展开、图片查看和来源返回。</p><p>{selectedAgent.state === "completed" ? "已整理本地样例检查记录。" : "已保留当前核对记录。"}</p>
          </ActivityGroup>
          {selectedAgent.state === "running" ? <><p>正在检查窄窗返回与键盘焦点，结果尚未结算。</p><ThinkingStatus label={progressLabel} /></>
            : selectedAgent.state === "attention" ? <><Feedback message="退出结果尚未确认，保留最后收到的记录。" /><p>此处只读历史，不重试或重放任务。</p></>
              : <><h3>{selectedAgent.name}完成</h3><ul><li>活动与图片的人工展开选择得到保留。</li><li>来源返回后可继续阅读原记录。</li><li>子任务状态独立于父任务结算。</li></ul><p>以上是固定历史样例，用于评审完成态的阅读体验。</p></>}
        </>}
      </SubagentPanel>
    </WorkbenchShell>
  </section>;
}
