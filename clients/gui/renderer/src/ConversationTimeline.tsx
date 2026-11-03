import { Button } from "@areal/ui";
import { Check, CircleAlert, CircleMinus } from "lucide-react";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type { Data } from "./services.js";
import { retryProgress } from "./conversationEvents.js";
import type { ComponentProps } from "react";

export function TimelineNotice({ children, className = "", ...props }: ComponentProps<"div">) {
  return (
    <div {...props} className={`conversation-event ${className}`}>
      <span className="conversation-event-content">{children}</span>
    </div>
  );
}

export function CompactionNotices({ turn }: { turn: Data }) {
  const { t } = useI18n();
  return (turn.trace?.activities ?? [])
    .filter((activity: Data) => activity.kind === "compaction")
    .map((activity: Data) => (
      <TimelineNotice key={activity.id} data-compaction={activity.id} role="status">
        {t(
          activity.status === "completed"
            ? "chat.timeline.compaction.completed"
            : activity.status === "running"
              ? "chat.timeline.compaction.running"
              : "chat.timeline.compaction.failed",
        )}
      </TimelineNotice>
    ));
}

export function MessageTime({ createdAt }: { createdAt?: number }) {
  const { locale, t } = useI18n();
  if (!Number.isSafeInteger(createdAt) || !createdAt || createdAt <= 0) return null;
  const date = new Date(createdAt * 1000);
  const full = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long" }).format(
    date,
  );
  return (
    <ControlHintTooltip title={full}>
      <Button
        unstyled
        data-slot={undefined}
        type="button"
        className="message-time"
        aria-label={t("chat.timeline.messageTime", { time: full })}
      >
        <time dateTime={date.toISOString()}>
          {new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)}
        </time>
      </Button>
    </ControlHintTooltip>
  );
}

export function ModelChanges({ changes, afterTurnId }: { changes?: Data[]; afterTurnId?: string }) {
  const { t } = useI18n();
  return (changes ?? [])
    .filter((change) => (change.afterTurnId ?? undefined) === afterTurnId)
    .map((change) => (
      <TimelineNotice
        className="model-change-notice"
        data-model-change={change.revision}
        key={change.revision}
      >
        {t("chat.timeline.modelChange", {
          from: [change.from.providerId, change.from.modelId].filter(Boolean).join(" / "),
          to: [change.to.providerId, change.to.modelId].filter(Boolean).join(" / "),
        })}
      </TimelineNotice>
    ));
}

export function TurnRetries({ turn }: { turn: Data }) {
  const { t } = useI18n();
  return retryProgress(turn).flatMap((retry) => {
    if (retry.state === "waiting" || retry.state === "retrying") return [];
    return (
      <TimelineNotice
        className="turn-retry-notice"
        data-retry-state={retry.state}
        key={retry.id}
        role="status"
      >
        {retry.state === "recovered" ? (
          <Check size={14} aria-hidden="true" />
        ) : retry.state === "exhausted" ? (
          <CircleAlert className="turn-retry-attention" size={14} aria-hidden="true" />
        ) : (
          <CircleMinus size={14} aria-hidden="true" />
        )}
        <span>
          {t(`chat.timeline.retry.${retry.state}.label`)}
          {" · "}
          {t("chat.timeline.retry.attempts", { attempts: retry.attempts })}
        </span>
      </TimelineNotice>
    );
  });
}
