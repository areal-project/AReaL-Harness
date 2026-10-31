import { Button } from "@areal/ui";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type { Data } from "./services.js";
import { retryProgress } from "./conversationEvents.js";

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
      <p className="model-change-notice" data-model-change={change.revision} key={change.revision}>
        {t("chat.timeline.modelChange", {
          from: [change.from.providerId, change.from.modelId].filter(Boolean).join(" / "),
          to: [change.to.providerId, change.to.modelId].filter(Boolean).join(" / "),
        })}
      </p>
    ));
}

export function TurnRetries({ turn }: { turn: Data }) {
  const { t } = useI18n();
  return retryProgress(turn)
    .filter((retry) => retry.state !== "waiting" && retry.state !== "retrying")
    .map((retry) => (
      <p className="execution-status" data-retry-state={retry.state} key={retry.id} role="status">
        {t(`chat.timeline.retry.${retry.state}`, { attempts: retry.attempts })}
      </p>
    ));
}
