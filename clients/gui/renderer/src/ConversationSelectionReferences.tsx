import { QuoteIcon, Trash2Icon, XIcon } from "lucide-react";
import { useI18n } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import type { ConversationSelectionReference } from "./conversationSelectionReference.js";

type DisplayReference = Pick<ConversationSelectionReference, "text"> & Partial<Omit<ConversationSelectionReference, "text">>;

export function ConversationSelectionReferences({ references, disabled, onRemove, onRemoveAll }: {
  references: readonly DisplayReference[];
  disabled?: boolean;
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const { t } = useI18n();
  if (!references.length) return null;
  const label = t("chat.selection.count", { count: references.length });
  const removable = !!onRemoveAll || !!onRemove && references.some(reference => reference.id);
  const removeAll = () => {
    if (onRemoveAll) onRemoveAll();
    else references.forEach(reference => { if (reference.id) onRemove?.(reference.id); });
  };
  return <div className="conversation-selection-references" aria-label={t("chat.selection.references")}>
    <Popover>
      <div className="conversation-selection-pill" data-removable={removable || undefined}>
        <PopoverTrigger openOnHover delay={0} closeDelay={0}
          render={<Button type="button" variant="ghost" className="conversation-selection-reference-trigger" />}
          aria-label={label} data-conversation-selection-reference-count={references.length}>
          <QuoteIcon className="size-4" aria-hidden="true" /><span>{label}</span>
        </PopoverTrigger>
        {removable && <Button type="button" variant="ghost" size="icon-xs" className="conversation-selection-remove-all"
          aria-label={t("chat.selection.removeAll")} title={t("chat.selection.removeAll")} disabled={disabled}
          onClick={event => { event.stopPropagation(); removeAll(); }}><XIcon className="size-3.5" /></Button>}
      </div>
      <PopoverContent align="start" side="top" className="conversation-selection-details" data-testid="conversation-selection-details" aria-label={label}>
        <div className="conversation-selection-detail-list">
          {references.map((reference, index) => <div className="conversation-selection-reference" key={reference.id ?? `${index}:${reference.text}`}
            data-testid="conversation-selection-reference" data-reference-id={reference.id} data-source-session-id={reference.sourceSessionId} data-source-row-id={reference.sourceRowId}>
            <QuoteIcon className="conversation-selection-row-icon size-4" aria-hidden="true" />
            <div className="conversation-selection-reference-body">
              <div className="conversation-selection-reference-text">{reference.text}</div>
              {reference.contentType && reference.sourceRowId && <div className="conversation-selection-reference-source" title={reference.sourceSessionId}>
                {t(`chat.selection.type.${reference.contentType}`)} · #{reference.sourceRowId}
              </div>}
            </div>
            {onRemove && reference.id && <Button type="button" variant="ghost" size="icon-xs" className="conversation-selection-remove"
              aria-label={t("chat.selection.removeReference")} disabled={disabled} onClick={() => onRemove(reference.id!)}>
              <Trash2Icon className="size-3.5" />
            </Button>}
          </div>)}
        </div>
      </PopoverContent>
    </Popover>
  </div>;
}
