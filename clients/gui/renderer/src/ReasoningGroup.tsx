import { ActivityRowButton, ActivityRowChevron } from "@areal/ui/experimental";
import { Fragment, useId, useState, type ReactNode } from "react";
import type { Data } from "./services.js";
import { readingDisclosure, rememberDisclosure } from "./conversationReading.js";
import { useI18n } from "./i18n/IntlProvider.js";

/** Public reasoning stays available without repeating a row for every model step. */
export function ReasoningGroup({
  items,
  readingKey,
  renderGap,
}: {
  items: Data[];
  readingKey?: string;
  renderGap?: (item: Data) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(
    () => (readingKey ? readingDisclosure(readingKey) : undefined) ?? false,
  );
  const count = items.filter((item) => item.type === "reasoning").length;
  const sections: ({ type: "gap"; item: Data } | { type: "reasoning"; items: Data[] })[] = [];
  for (const item of items) {
    const last = sections.at(-1);
    if (item.type === "historyPageGap") sections.push({ type: "gap", item });
    else if (last?.type === "reasoning") last.items.push(item);
    else sections.push({ type: "reasoning", items: [item] });
  }
  const id = useId();
  return (
    <div className="reasoning-group" data-testid="reasoning-group">
      <ActivityRowButton
        className="tool-summary-row reasoning-summary"
        aria-label={t("common.turn.reasoning")}
        title={t("common.turn.reasoningCount", { count })}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (readingKey) rememberDisclosure(readingKey, !open);
          setOpen(!open);
        }}
      >
        <span>{t("common.turn.reasoningCount", { count })}</span>
        <ActivityRowChevron open={open} />
      </ActivityRowButton>
      <div id={id}>
        {sections.map((section) =>
          section.type === "gap" ? (
            <Fragment key={section.item.id}>{renderGap?.(section.item)}</Fragment>
          ) : (
            <div
              key={section.items[0].id}
              className="reasoning-group-details reasoning-details"
              hidden={!open}
            >
              {section.items.map((item) => (
                <div
                  key={item.id}
                  className="reasoning-group-entry"
                  data-side-item-id={item.id}
                  data-testid="reasoning"
                >
                  {(item.summary ?? [])
                    .filter((part: unknown) => typeof part === "string" && part.trim())
                    .map((part: string, index: number) => (
                      <p key={`summary-${index}`}>{part}</p>
                    ))}
                  {(item.content ?? [])
                    .filter((part: unknown) => typeof part === "string" && part.trim())
                    .map((part: string, index: number) => (
                      <p key={`content-${index}`}>{part}</p>
                    ))}
                </div>
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
