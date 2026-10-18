import { useId, useState } from "react";
import { ActivityIcon } from "./ActivityIcon.js";
import type { Data } from "./services.js";

/** Public reasoning stays available without repeating a row for every model step. */
export function ReasoningGroup({ items, activity, animate = false }: { items: Data[]; activity?: string; animate?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="reasoning-group" data-testid="reasoning-group">
    <button type="button" className="tool-summary-row reasoning-summary" aria-label="思考过程" title={`思考过程 · ${items.length} 段`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span className={animate ? "execution-label turn-thinking" : undefined} role={activity ? "status" : undefined} aria-live={activity ? "polite" : undefined} data-testid={activity ? "turn-activity" : undefined}>{activity ?? `思考过程 · ${items.length} 段`}</span>
      <ActivityIcon kind="chevron" size={14} className={open ? "tool-chevron open" : "tool-chevron"} />
    </button>
    <div id={id} className="reasoning-group-details reasoning-details" hidden={!open}>
      {items.map(item => <div key={item.id} className="reasoning-group-entry" data-testid="reasoning">
        {(item.summary ?? []).filter((part: unknown) => typeof part === "string" && part.trim()).map((part: string, index: number) => <p key={`summary-${index}`}>{part}</p>)}
        {(item.content ?? []).filter((part: unknown) => typeof part === "string" && part.trim()).map((part: string, index: number) => <p key={`content-${index}`}>{part}</p>)}
      </div>)}
    </div>
  </div>;
}
