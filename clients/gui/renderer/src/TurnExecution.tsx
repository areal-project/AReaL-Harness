import { retryProgress } from "./conversationEvents.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { useState, type ComponentProps, type ReactNode } from "react";
import { ActivityGroup, ThinkingStatus } from "@areal/ui/experimental";
import "@areal/ui/conversation.css";
import { spawnedAgent } from "./AgentIdentity.js";
import { CircleAlert } from "lucide-react";
import { ActivityIcon } from "./ActivityIcon.js";
import { ReasoningGroup } from "./ReasoningGroup.js";
import { readingDisclosure, rememberDisclosure } from "./conversationReading.js";
import {
  activityLabel,
  activityRunLabel,
  activityRunStages,
  activityStageIcon,
  activityRuns,
  agentSettlements,
  executionOutcome,
  processItems,
  statusTarget,
  timelineItems,
  toolPresentation,
} from "./conversationPresentation.js";
import type { Data } from "./services.js";

function ReadingActivityGroup({
  readingKey,
  ...props
}: ComponentProps<typeof ActivityGroup> & { readingKey?: string }) {
  const [open, setOpen] = useState(
    () => (readingKey ? readingDisclosure(readingKey) : undefined) ?? false,
  );
  return (
    <ActivityGroup
      {...props}
      open={open}
      onOpenChange={(next) => {
        if (readingKey) rememberDisclosure(readingKey, next);
        setOpen(next);
      }}
    />
  );
}

function canAnimateTurn(project: Data, threadId: string, turn: Data) {
  return (
    turn.status === "inProgress" &&
    (project.state?.threads?.[threadId]?.executionConnected ?? !!project.state?.connected) &&
    !turn.modelRetry &&
    !project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending")
  );
}

/**
 * CONV-STATUS-01: one live status per turn, at its tail. Running tools and model
 * progress both use the sweeping one-line status; tool rows above stay static.
 * When the host shows the pending decision card (decisionShown), the card is the
 * only place that asks — the tail does not repeat "等待你的确认或回答".
 */
export function TurnActivity({
  turn,
  project,
  threadId,
  decisionShown = false,
}: {
  turn: Data;
  project: Data;
  threadId: string;
  decisionShown?: boolean;
}) {
  const { t } = useI18n();
  if (turn.status !== "inProgress") return null;
  if (
    decisionShown &&
    project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending")
  )
    return null;
  const retry = retryProgress(turn).findLast(
    (entry) => entry.state === "waiting" || entry.state === "retrying",
  );
  const animate = canAnimateTurn(project, threadId, turn) && !retry;
  const items = processItems(turn.items ?? [], turn.status);
  const currentTool =
    animate &&
    items.findLast((item) => item.type === "dynamicToolCall" && toolPresentation(item).running);
  const detail = currentTool ? statusTarget(toolPresentation(currentTool).detail) : undefined;
  const unconfirmed = items.some(
    (item) => item.type === "dynamicToolCall" && toolPresentation(item).status === "结果待确认",
  );
  const last = items.filter((item) => item.type !== "modelContext").at(-1);
  const summary =
    last?.type === "reasoning"
      ? (last.summary ?? [])
          .filter((part: unknown) => typeof part === "string" && part.trim())
          .at(-1)
      : undefined;
  const retrying =
    retry && (project.state?.threads?.[threadId]?.executionConnected ?? project.state?.connected);
  const label = retrying
    ? `${t(retry.state === "waiting" ? "chat.timeline.retry.waiting" : "chat.timeline.retry.retrying", { attempts: retry.attempts })}${retry.state === "waiting" && retry.delayMs != null ? ` ${t("chat.timeline.retry.delay", { seconds: retry.delayMs / 1000 })}` : ""}`
    : activityLabel(project, threadId, turn);
  // 需要你注意的状态只在这一行表达：图标着色、文字加深，不再在过程标题或其他位置重复。
  const tone =
    !(project.state?.threads?.[threadId]?.executionConnected ?? project.state?.connected) ||
    turn.modelRetry ||
    retry ||
    project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending")
      ? "attention"
      : unconfirmed
        ? "unknown"
        : undefined;
  return (
    <div className="turn-activity" data-testid="turn-activity">
      {currentTool ? (
        <ThinkingStatus lines="single" label={detail ? `${label} ${detail}` : label} />
      ) : animate && !unconfirmed ? (
        <ThinkingStatus
          lines="single"
          label={summary || (/^(等待模型|正在思考)/.test(label) ? undefined : label)}
        />
      ) : (
        <p className="execution-status" role="status" data-tone={tone}>
          {tone && <CircleAlert size={14} aria-hidden="true" />}
          <span>{unconfirmed && animate ? t("chat.tool.unconfirmed") : label}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Core work items are disclosed in order between visible conversation messages.
 * 两段文字之间的工具合成一组（CONV-ACTIVITY-01）：一项时直接显示该项，多项时折叠为
 * "已修改 2 个文件，已探索"等过去式短语串，图标取第一个短语；思考组与子代理行各自成段。
 */
export function TurnExecution({
  items,
  turn,
  project,
  threadId,
  renderItem,
  readingKey,
}: {
  items: Data[];
  turn: Data;
  project: Data;
  threadId: string;
  renderItem: (item: Data, disclosure: { animate: boolean }) => ReactNode;
  readingKey?: string;
}) {
  const { t } = useI18n();
  const { unfinished } = executionOutcome(items);
  // 失败的步骤留在原位，由所在活动行写明结果（CONV-ACTIVITY-01），过程标题不另作提示。
  const visibleItems = items.filter((item) => !item.historyOmitted);
  const tools = visibleItems.filter((item) => item.type === "dynamicToolCall");
  const unconfirmed = tools.some((item) => toolPresentation(item).state === "unsettled");
  const rows = timelineItems(items);
  const canAnimate = canAnimateTurn(project, threadId, turn);
  if (!rows.length) return null;
  const status =
    turn.interruption === "userPause" ? null : unconfirmed ? (
      <p role="status">{t("chat.activity.status", { state: "unsettled" })}</p>
    ) : unfinished && turn.status !== "inProgress" ? (
      <p role="status">{t("chat.activity.stillRunning")}</p>
    ) : turn.status === "failed" ? (
      <p role="status">{t("common.turn.failed")}</p>
    ) : null;
  const runs = activityRuns(
    rows,
    (item) => !!spawnedAgent(item) || agentSettlements(item).length > 0,
  )
    .map((run) => ({
      ...run,
      items: run.items.flatMap((item) => {
        if (item.type === "reasoningGroup") {
          const resident = item.items.filter((entry: Data) => !entry.historyOmitted);
          return resident.length ? [{ ...item, items: resident }] : [];
        }
        return item.historyOmitted ? [] : [item];
      }),
    }))
    .filter((run) => run.items.length);
  const row = (item: Data) => (
    <div key={item.id} className="execution-row">
      {item.type === "reasoningGroup" ? (
        <ReasoningGroup
          items={item.items}
          readingKey={readingKey && JSON.stringify([readingKey, item.id])}
          renderGap={(gap) => renderItem(gap, { animate: canAnimate })}
        />
      ) : (
        renderItem(item, { animate: canAnimate })
      )}
    </div>
  );
  return (
    <div className="turn-execution" data-testid="turn-execution">
      {runs.map((run, index) => {
        const last = index === runs.length - 1;
        const activities = {
          ...run,
          items: run.items.filter((item) => item.type !== "historyPageGap"),
        };
        const grouped = run.key !== null && activities.items.length > 1;
        const icon = activityStageIcon(grouped ? activityRunStages(activities)[0] : null);
        return (
          <ReadingActivityGroup
            key={run.id}
            readingKey={readingKey && JSON.stringify([readingKey, run.id, "activity"])}
            presentation={grouped ? "collapsible" : "inline"}
            label={
              run.key !== null
                ? activityRunLabel(activities, t)
                : run.items[0].type === "reasoningGroup"
                  ? t("common.turn.reasoning")
                  : t("common.turn.activity")
            }
            icon={grouped ? <ActivityIcon kind={icon} /> : undefined}
            status={last ? status : undefined}
          >
            {run.items.map(row)}
          </ReadingActivityGroup>
        );
      })}
    </div>
  );
}
