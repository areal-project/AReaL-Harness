import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ActivityIcon } from "./ActivityIcon.js";

/** Local disclosure only. The parent supplies ordered content; hidden children stay
 * mounted so inspecting history never resets command details or replays work. */
export function TurnProgress({ settled, summaryAvailable, failures, unfinished, children, label = "本轮过程" }: {
  settled: boolean; summaryAvailable: boolean; failures: number; unfinished: boolean; children: ReactNode; label?: string;
}) {
  const [open, setOpen] = useState(!settled);
  const manual = useRef(false);
  useEffect(() => { if (!manual.current) setOpen(!settled); }, [settled]);
  const id = useId();
  const expanded = !summaryAvailable || open;
  return <div className="turn-progress">
    {summaryAvailable && <div className="turn-progress-heading"><div className="turn-progress-label"><button className="turn-progress-summary" type="button" aria-label={label} aria-expanded={expanded} aria-controls={id} onClick={() => { manual.current = true; setOpen(!open); }}>
      <span>{label}</span>{!!failures && <span className="execution-failures">{failures} 次工具失败</span>}{unfinished && <span>结果待确认</span>}<ActivityIcon kind="chevron" size={14} className={expanded ? "open" : ""} />
    </button></div><div className="turn-progress-divider" /></div>}
    <div id={id} className="turn-progress-body" hidden={!expanded}>{children}</div>
  </div>;
}
