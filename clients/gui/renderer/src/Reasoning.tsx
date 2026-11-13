import { Button } from "@areal/ui";
import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Data } from "./services.js";
import { stringItems } from "./data-shapes.js";

/** 只展示 Core 明确返回的公开文本，默认折叠，不读取 provider context。 */
export function Reasoning({ item }: { item: Data }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const summary = stringItems(item.summary).filter((part) => part.trim());
  const content = stringItems(item.content).filter((part) => part.trim());
  if (!summary.length && !content.length) return null;
  return (
    <div className="tool-group reasoning" data-testid="reasoning">
      <Button
        unstyled
        data-slot={undefined}
        type="button"
        className="tool-group-summary"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span>思考过程</span>
        <ChevronRight size={14} className={open ? "tool-chevron open" : "tool-chevron"} />
      </Button>
      <div id={id} hidden={!open} className="tool-group-details reasoning-details">
        {!!summary.length && (
          <div>
            <span className="tool-event-heading">摘要</span>
            {summary.map((text: string, index: number) => (
              <p key={index}>{text}</p>
            ))}
          </div>
        )}
        {!!content.length && (
          <div>
            {!!summary.length && <span className="tool-event-heading">思考内容</span>}
            {content.map((text: string, index: number) => (
              <p key={index}>{text}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
