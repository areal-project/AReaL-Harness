import { useI18n } from "./i18n/IntlProvider.js";
import type { ReactNode } from "react";
import { ActivityGroup, ThinkingStatus } from "@areal/ui/wip";
import "@areal/ui/conversation.css";
import { spawnedAgent } from "./AgentIdentity.js";
import { ActivityIcon } from "./ActivityIcon.js";
import { ReasoningGroup } from "./ReasoningGroup.js";
import { activityLabel, executionOutcome, executionSummary, processItems, timelineItems, toolPresentation } from "./conversationPresentation.js";
import type { Data } from "./services.js";

function canAnimateTurn(project: Data, threadId: string, turn: Data) {
  return turn.status === "inProgress" && (project.state?.threads?.[threadId]?.executionConnected ?? !!project.state?.connected) && !turn.modelRetry
    && !project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending");
}

export function TurnActivity({ turn, project, threadId }: { turn: Data; project: Data; threadId: string }) {
  const { t } = useI18n();
  if (turn.status !== "inProgress") return null;
  const animate = canAnimateTurn(project, threadId, turn);
  const currentTool = animate && processItems(turn.items ?? [], turn.status).findLast(item => item.type === "dynamicToolCall" && toolPresentation(item).running);
  const detail = currentTool ? toolPresentation(currentTool).detail : undefined;
  const items = processItems(turn.items ?? [], turn.status);
  const unconfirmed = items.some(item => item.type === "dynamicToolCall" && toolPresentation(item).status === "结果待确认");
  const last = items.filter(item => item.type !== "modelContext").at(-1);
  const summary = last?.type === "reasoning" ? (last.summary ?? []).filter((part: unknown) => typeof part === "string" && part.trim()).at(-1) : undefined;
  const label = activityLabel(project, threadId, turn);
  const model = animate && !currentTool && !unconfirmed;
  return <div className="turn-activity" data-testid="turn-activity">
    {model ? <ThinkingStatus label={summary || (/^(等待模型|正在思考)/.test(label) ? undefined : label)} />
      : <p className="execution-status" role="status">{unconfirmed && animate && !currentTool ? t("chat.tool.unconfirmed") : label}{detail && <> {detail}</>}</p>}
  </div>;
}

/** Core work items are disclosed in order between visible conversation messages. */
export function TurnExecution({ items, turn, project, threadId, renderItem }: {
  items: Data[]; turn: Data; project: Data; threadId: string; renderItem: (item: Data, disclosure: { animate: boolean }) => ReactNode;
}) {
  const { unfinished } = executionOutcome(items);
  const visibleItems = items.filter(item => item.type !== "dynamicToolCall" || !toolPresentation(item).failed);
  const tools = visibleItems.filter(item => item.type === "dynamicToolCall");
  const unconfirmed = tools.some(item => toolPresentation(item).status === "结果待确认");
  const rows = timelineItems(visibleItems);
  const reasoningCount = items.filter(item => item.type === "reasoning").length;
  const counts = [reasoningCount && `${reasoningCount} 段思考`, tools.length && `${tools.length} 项活动`].filter(Boolean).join(" · ");
  const label = `${executionSummary(visibleItems)}${turn.status === "failed" ? " · 回合失败" : ""}`;
  const singleTool = rows.length === 1 && rows[0].type === "dynamicToolCall";
  const singleReasoning = rows.length === 1 && rows[0].type === "reasoningGroup";
  const onlyAgentEntries = rows.length > 0 && rows.every(item => !!spawnedAgent(item));
  const direct = singleTool || singleReasoning || onlyAgentEntries;
  const canAnimate = canAnimateTurn(project, threadId, turn);
  const iconKind = toolPresentation(tools.find(item => toolPresentation(item).running) ?? tools[0] ?? {}).kind;
  if (!rows.length) return null;
  const status = <>
    {unconfirmed ? <p role="status">结果待确认</p> : unfinished && turn.status !== "inProgress" && <p role="status">仍在运行</p>}
  </>;
  const content = rows.map(item => <div key={item.id} className="execution-row">{item.type === "reasoningGroup"
    ? <ReasoningGroup items={item.items} />
    : renderItem(item, { animate: canAnimate })}</div>);
  return <div className="turn-execution" data-testid="turn-execution">
    <ActivityGroup presentation={direct ? "inline" : "collapsible"} label={`${label}${counts ? ` · ${counts}` : ""}`} icon={tools.length > 0 ? <ActivityIcon kind={iconKind} /> : undefined} status={status}>{content}</ActivityGroup>
  </div>;
}
