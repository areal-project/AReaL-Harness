import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Data } from "./services.js";

/** 只展示 Core 明确返回的公开文本，默认折叠，不读取 provider context。 */
export function Reasoning({ item }: { item: Data }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const summary = (item.summary ?? []).filter((part: unknown) => typeof part === "string" && part.trim());
  const content = (item.content ?? []).filter((part: unknown) => typeof part === "string" && part.trim());
  if (!summary.length && !content.length) return null;
  return <div className="tool-group reasoning" data-testid="reasoning">
    <button type="button" className="tool-group-summary" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span>思考过程</span><ChevronRight size={14} className={open ? "tool-chevron open" : "tool-chevron"} />
    </button>
    <div id={id} hidden={!open} className="tool-group-details reasoning-details">
      {!!summary.length && <div><span className="tool-event-heading">摘要</span>{summary.map((text: string, index: number) => <p key={index}>{text}</p>)}</div>}
      {!!content.length && <div>{!!summary.length && <span className="tool-event-heading">思考内容</span>}{content.map((text: string, index: number) => <p key={index}>{text}</p>)}</div>}
    </div>
  </div>;
}
