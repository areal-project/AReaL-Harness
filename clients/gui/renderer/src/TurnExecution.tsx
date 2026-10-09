import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { spawnedAgent } from "./AgentIdentity.js";
import { ActivityIcon } from "./ActivityIcon.js";
import { ReasoningGroup } from "./ReasoningGroup.js";
import { activityLabel, executionOutcome, executionSummary, timelineItems, toolPresentation } from "./conversationPresentation.js";
import type { Data } from "./services.js";

/** Core work items are disclosed in order between visible conversation messages. */
export function TurnExecution({ items, turn, project, threadId, renderItem, active = true, hasTurnSummary = false }: {
  active?: boolean; hasTurnSummary?: boolean; items: Data[]; turn: Data; project: Data; threadId: string; renderItem: (item: Data, disclosure: { animate: boolean; onDisclosureChange: (open: boolean) => void }) => ReactNode;
}) {
  const { failures, unfinished } = executionOutcome(items);
  const settled = turn.status === "completed" && hasTurnSummary && !unfinished;
  // Execution and reading state are independent: live activity stays compact.
  // Terminal exceptions remain discoverable; receipts never override a reader.
  const defaultOpen = turn.status !== "inProgress" && !settled;
  const [open, setOpen] = useState(defaultOpen);
  const manual = useRef(false);
  useEffect(() => {
    if (!manual.current) setOpen(defaultOpen);
  }, [defaultOpen]);
  const id = useId();
  const running = active && turn.status === "inProgress";
  const awaitingInput = project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending");
  const tools = items.filter(item => item.type === "dynamicToolCall");
  const currentTool = tools.findLast(item => toolPresentation(item).running);
  const currentDetail = running && project.state?.connected && !awaitingInput && !turn.modelRetry && currentTool
    ? toolPresentation(currentTool).detail : undefined;
  const unconfirmed = tools.some(item => toolPresentation(item).status === "结果待确认");
  const rows = timelineItems(items);
  const reasoningCount = items.filter(item => item.type === "reasoning").length;
  const counts = [reasoningCount && `${reasoningCount} 段思考`, tools.length && `${tools.length} 项活动`].filter(Boolean).join(" · ");
  const hasDetails = rows.length > 0;
  const summary = executionSummary(items);
  const label = running ? activityLabel(project, threadId, items.length ? { ...turn, items } : turn) :
    `${summary}${turn.status === "failed" ? " · 回合失败" : ""}`;
  const singleTool = rows.length === 1 && rows[0].type === "dynamicToolCall";
  const singleReasoning = rows.length === 1 && rows[0].type === "reasoningGroup";
  // The round disclosure owns commentary; multi-item activity keeps its
  // semantic disclosure. A single tool or reasoning group needs no wrapper.
  const onlyAgentEntries = rows.length > 0 && rows.every(item => !!spawnedAgent(item));
  const direct = singleTool || singleReasoning || onlyAgentEntries;
  const expanded = direct || open;
  const canAnimate = turn.status === "inProgress" && !!project.state?.connected && !awaitingInput && !turn.modelRetry;
  const animateSummary = canAnimate && (running || unfinished) && !(expanded && tools.some(item => toolPresentation(item).running));
  const onDisclosureChange = (next: boolean) => {
    // A direct first row becomes a group without hiding or remounting its detail.
    if (singleTool || next) { manual.current = true; setOpen(singleTool ? next : true); }
  };
  const iconKind = toolPresentation(tools.find(item => toolPresentation(item).running) ?? tools[0] ?? {}).kind;
  const statusLabel = <span className={animateSummary ? "execution-label turn-thinking" : "execution-label"} role={running ? "status" : undefined} aria-live={running ? "polite" : undefined} data-testid={running ? "turn-activity" : undefined}><span>{label}</span>{currentDetail && <> {currentDetail}</>}</span>;
  const heading = !direct && (hasDetails ? <button type="button" className="execution-summary" aria-label="执行过程" title={counts || undefined} aria-expanded={open} aria-controls={id} onClick={() => { manual.current = true; setOpen(!open); }}>
      {tools.length > 0 && <ActivityIcon kind={iconKind} />}
      {statusLabel}
      {!!failures && !(hasTurnSummary && turn.status === "completed") && <span className="execution-failures">{failures} 次工具失败</span>}
      {unconfirmed ? <span className="execution-label">结果待确认</span> : unfinished && !running && <span className="execution-label">仍在运行</span>}
      <ActivityIcon kind="chevron" size={14} className={open ? "execution-chevron open" : "execution-chevron"} />
    </button> : running ? <div className="execution-summary">{statusLabel}</div> : null);
  return <div className="turn-execution" data-testid="turn-execution">
    {heading}
    <div id={id} className={direct ? "execution-details execution-single" : "execution-details"} data-expanded={expanded} data-agent-entries={rows.some(item => !!spawnedAgent(item)) || undefined} data-activity-list={rows.length > 1}>
      {rows.map(item => <div key={item.id} className="execution-row" hidden={!expanded && !spawnedAgent(item)}>{item.type === "reasoningGroup"
        ? <ReasoningGroup items={item.items} activity={singleReasoning && running ? label : undefined} animate={singleReasoning && running && canAnimate} />
        : renderItem(item, { animate: canAnimate && expanded, onDisclosureChange })}</div>)}
    </div>
    {singleTool && running && (!toolPresentation(rows[0]).running || !project.state?.connected || awaitingInput || turn.modelRetry) && <p className={canAnimate ? "execution-label turn-thinking" : "execution-label"} role="status">{activityLabel(project, threadId, turn)}</p>}
  </div>;
}
