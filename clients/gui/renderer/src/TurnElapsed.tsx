import { Button } from "@areal/ui";
import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useState, type ReactNode } from "react";
import type { Data } from "./services.js";
import { ActivityIcon } from "./ActivityIcon.js";
import { processItems, toolPresentation } from "./conversationPresentation.js";

/** Terminal duration is a Core receipt, never a sum of tool execution times. */
export function completedTimeLabel(
  turn: Data,
  t: ReturnType<typeof useI18n>["t"],
): string | undefined {
  if (turn.status === "inProgress" || !Number.isSafeInteger(turn.durationMs) || turn.durationMs < 0)
    return undefined;
  const failures = processItems(turn.items ?? [], turn.status).filter(
    (item) => item.type === "dynamicToolCall" && toolPresentation(item).failed,
  ).length;
  const label = t("chat.progress.worked", { duration: durationText(turn.durationMs, t) });
  return failures ? `${label} · ${t("chat.activity.part.failures", { count: failures })}` : label;
}

function durationText(milliseconds: number, t: ReturnType<typeof useI18n>["t"]): string {
  const seconds = Math.floor(milliseconds / 1000);
  return t("chat.progress.duration", {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}

/** Refresh only the display. History and reconnect retain Core's original start. */
export function TurnElapsed({
  turn,
  connected,
  awaiting = false,
  disclosure,
  indicator,
}: {
  turn: Data;
  connected: boolean;
  awaiting?: boolean;
  indicator?: ReactNode;
  disclosure?: {
    expanded: boolean;
    controls: string;
    onToggle: () => void;
  };
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const running = turn.status === "inProgress";
  const hasStart = Number.isSafeInteger(turn.startedAt) && turn.startedAt > 0;
  useEffect(() => {
    // 等待用户批准的时间不算 agent 在工作，计时停在这里。
    if (!running || !connected || !hasStart || awaiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn.id, turn.startedAt, running, connected, hasStart, awaiting]);
  const label = running
    ? !connected
      ? "连接已中断，耗时待同步"
      : awaiting
        ? t("chat.progress.awaiting")
        : hasStart && now >= turn.startedAt * 1000
          ? t("chat.progress.working", {
              duration: durationText(now - turn.startedAt * 1000, t),
            })
          : undefined
    : completedTimeLabel(turn, t);
  if (!label && !disclosure) return null;
  return (
    <div className="turn-elapsed turn-progress-heading" data-testid="turn-elapsed">
      <div className="turn-progress-label">
        {disclosure ? (
          <Button
            unstyled
            data-slot={undefined}
            type="button"
            className="turn-progress-summary"
            aria-label={t("chat.progress.accessibleLabel", {
              label: label ?? t("chat.progress.defaultLabel"),
            })}
            aria-expanded={disclosure.expanded}
            aria-controls={disclosure.controls}
            onClick={disclosure.onToggle}
          >
            <span>{label ?? t("chat.progress.defaultLabel")}</span>
            <ActivityIcon kind="chevron" size={14} className={disclosure.expanded ? "open" : ""} />
          </Button>
        ) : (
          <span className="turn-progress-summary">{label}</span>
        )}
        {indicator}
      </div>
      <div className="turn-progress-divider" />
    </div>
  );
}
