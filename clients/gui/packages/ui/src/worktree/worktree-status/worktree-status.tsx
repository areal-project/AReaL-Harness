import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, CircleDashed, GitFork } from "lucide-react";
import { Button } from "../../components/button/button.js";

export function WorktreeStatus({ state, label, regionLabel, running, message, stages, details, controls, showLabel, hideLabel }: {
  state: string; label: string; regionLabel: string; running: boolean; message?: string;
  stages: readonly { id: string; label: string; current: boolean }[];
  details?: ReactNode; controls?: ReactNode; showLabel: string; hideLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const panel = running || !!controls || open;
  const toggle = details && <Button variant="ghost" size="sm" className="worktree-status-disclosure" aria-expanded={open} aria-controls={id}
    onClick={() => setOpen(value => !value)}>{open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}{open ? hideLabel : showLabel}</Button>;
  return <section aria-label={regionLabel} className="worktree-status" data-testid="worktree-status" data-worktree-state={state}>
    <div className="worktree-status-heading" role={state === "failed" ? "alert" : "status"}><GitFork className="size-3.5" aria-hidden="true" /><p>{label}</p></div>
    {!running && message && <p className="worktree-picker-note">{message}</p>}
    {panel && <div className={running || controls ? "worktree-status-panel" : undefined}>
      {running && <ol className="worktree-status-stages">{(open ? stages : stages.filter(stage => stage.current).slice(-1)).map(stage => <li className="worktree-status-stage" key={stage.id} data-current={stage.current}>
        {stage.current ? <CircleDashed className="size-3" aria-hidden="true" /> : <Check className="size-3" aria-hidden="true" />}<span>{stage.label}</span></li>)}</ol>}
      <div className="worktree-status-controls">{toggle}{controls && <div className="worktree-status-actions">{controls}</div>}</div>
      {open && <div id={id} className="worktree-status-details">{details}</div>}
    </div>}
    {!panel && toggle}
  </section>;
}
