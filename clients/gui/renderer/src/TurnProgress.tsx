import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ActivityIcon } from "./ActivityIcon.js";
import { CircleAlert } from "lucide-react";
import { TurnElapsed } from "./TurnElapsed.js";
import type { Data } from "./services.js";

/** Local disclosure only. The parent supplies ordered content; hidden children stay
 * mounted so inspecting history never resets command details or replays work. */
export function TurnProgress({ settled, summaryAvailable, failures, failureDetails, unfinished, children, label, turn, connected = false }: {
  settled: boolean; summaryAvailable: boolean; failures: number; unfinished: boolean; children: ReactNode; label?: string;
  turn?: Data; connected?: boolean; failureDetails?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!settled);
  const manual = useRef(false);
  useEffect(() => { if (!manual.current) setOpen(!settled); }, [settled]);
  const id = useId();
  const expanded = !summaryAvailable || open;
  const indicator = failures > 0 ? <details className="turn-failure-indicator">
    <summary aria-label={t("chat.progress.toolFailures", { count: failures })} title={t("chat.progress.toolFailures", { count: failures })}><CircleAlert size={14} /></summary>
    <div className="turn-failure-details">{failureDetails}</div>
  </details> : null;
  return <Collapsible.Root open={expanded} className="turn-progress">
    {summaryAvailable && (turn ? <TurnElapsed turn={turn} connected={connected} indicator={indicator} disclosure={{ expanded, controls: id, failures, unfinished, onToggle: () => { manual.current = true; setOpen(!open); } }} /> : <div className="turn-progress-heading"><div className="turn-progress-label"><button className="turn-progress-summary" type="button" aria-label={t("chat.progress.accessibleLabel", { label: label ?? t("chat.progress.defaultLabel") })} aria-expanded={expanded} aria-controls={id} onClick={() => { manual.current = true; setOpen(!open); }}>
      <span>{label ?? t("chat.progress.defaultLabel")}</span>{unfinished && <span>{t("chat.progress.unconfirmed")}</span>}<ActivityIcon kind="chevron" size={14} className={expanded ? "open" : ""} />
    </button>{indicator}</div><div className="turn-progress-divider" /></div>)}
    <Collapsible.Panel keepMounted id={id} className="turn-progress-body conversation-disclosure">{children}</Collapsible.Panel>
  </Collapsible.Root>;
}
