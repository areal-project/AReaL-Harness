import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useState, type ReactNode } from "react";
import type { Data } from "./services.js";
import { ActivityIcon } from "./ActivityIcon.js";

function durationText(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Terminal duration is a Core receipt, never a sum of tool execution times. */
export function completedTimeLabel(turn: Data): string | undefined {
  return turn.status !== "inProgress" && Number.isSafeInteger(turn.durationMs) && turn.durationMs >= 0
    ? `Working for ${durationText(turn.durationMs)}` : undefined;
}

/** Refresh only the display. History and reconnect retain Core's original start. */
export function TurnElapsed({ turn, connected, disclosure, indicator }: { turn: Data; connected: boolean; indicator?: ReactNode; disclosure?: { expanded: boolean; controls: string; failures?: number; unfinished?: boolean; onToggle: () => void } }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const running = turn.status === "inProgress";
  const hasStart = Number.isSafeInteger(turn.startedAt) && turn.startedAt > 0;
  useEffect(() => {
    if (!running || !connected || !hasStart) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn.id, turn.startedAt, running, connected, hasStart]);
  const label = running
    ? !connected ? "连接已中断，耗时待同步" : hasStart && now >= turn.startedAt * 1000
      ? `Working for ${durationText(now - turn.startedAt * 1000)}` : undefined
    : completedTimeLabel(turn);
  if (!label && !disclosure) return null;
  return <div className="turn-elapsed turn-progress-heading" data-testid="turn-elapsed">
    <div className="turn-progress-label">{disclosure ? <button type="button" className="turn-progress-summary" aria-label={t("chat.progress.accessibleLabel", { label: label ?? t("chat.progress.defaultLabel") })} aria-expanded={disclosure.expanded} aria-controls={disclosure.controls} onClick={disclosure.onToggle}>
      <span>{label ?? t("chat.progress.defaultLabel")}</span>{disclosure.unfinished && <span>{t("chat.progress.unconfirmed")}</span>}<ActivityIcon kind="chevron" size={14} className={disclosure.expanded ? "open" : ""} />
    </button> : <span className="turn-progress-summary">{label}</span>}{indicator}</div>
    <div className="turn-progress-divider" />
  </div>;
}
