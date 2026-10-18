// Adapted from ZCode 872ad960 ChatPromptActionMenu.tsx. The original Popover
// anchor and input focus behavior are retained with Base UI; Core attachment actions
// replace the CLI/plugin/goal/workflow catalog sections.
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { AttachmentIcon as PaperclipIcon } from "../interfaceIcons.js";
import { ComposerPlusIcon } from "../homeChromeIcons.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
export type ComposerMenuAction = {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
};
export function ChatPromptActionMenu({
  actionMenuTitle,
  attachmentAction,
  actions = [],
  disabled,
  disabledReason,
  inputApiRef,
  container,
}: {
  actionMenuTitle: string;
  attachmentAction?: {
    label: string;
    onSelect: () => void;
    testId?: string;
    menuItemTestId?: string;
  };
  actions?: readonly ComposerMenuAction[];
  disabled?: boolean;
  disabledReason?: string;
  inputApiRef: RefObject<Pick<LexicalChatInputHandle, "focus"> | null>;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  container?: HTMLElement | null;
  showPlugins?: boolean;
  excludedSlashCommandNames?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreEditorFocusRef = useRef(false);
  const select = (onSelect: () => void) => {
    if (disabled) return;
    restoreEditorFocusRef.current = true;
    setOpen(false);
    onSelect();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ControlHintTooltip title={disabledReason ?? actionMenuTitle}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="gap-1 rounded-lg text-ui-base"
              onMouseDown={(event) => event.preventDefault()}
              aria-label={actionMenuTitle}
              data-testid={attachmentAction?.testId}
              disabled={disabled}
              title={disabledReason}
            >
              <ComposerPlusIcon />
              <span className="sr-only">{actionMenuTitle}</span>
            </Button>
          }
        />
      </ControlHintTooltip>
      <PopoverContent
        ref={contentRef}
        anchor={container ?? undefined}
        aria-label={actionMenuTitle}
        align="start"
        side="top"
        sideOffset={8}
        className="composer-add-menu w-(--anchor-width) max-w-(--available-width) max-h-80 p-1"
        style={{ gap: 0 }}
        tabIndex={-1}
        initialFocus={contentRef}
        finalFocus={() => {
          if (restoreEditorFocusRef.current) {
            restoreEditorFocusRef.current = false;
            inputApiRef.current?.focus();
            return false;
          }
          return true;
        }}
        onKeyDown={(event) => {
          const buttons = [...(contentRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
          if (!buttons.length) return;
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index <= 0 ? buttons.length : index) - 1;
            buttons[next]?.focus();
          } else if (index === -1 && ["Enter", " "].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            buttons[0]?.click();
          }
        }}
      >
        <div className="px-2 py-1 text-ui-caption leading-[1.42857] text-foreground-subtle">添加</div>
        {attachmentAction && (
          <button
            type="button"
            onClick={() => select(attachmentAction.onSelect)}
            className="flex w-full items-center gap-2 rounded-[15px] px-2 py-[5px] text-left text-ui-caption leading-[1.42857] hover:bg-hover focus-visible:bg-hover outline-none"
          >
            <PaperclipIcon className="size-4 shrink-0" />
            <span
              className="truncate font-normal"
              data-testid={attachmentAction.menuItemTestId}
            >
              {attachmentAction.label}
            </span>
          </button>
        )}
        {actions.map(item => <button key={item.id} type="button" disabled={item.disabled}
          onClick={() => select(item.onSelect)}
          className="flex w-full items-center gap-2 rounded-[15px] px-2 py-[5px] text-left text-ui-caption leading-[1.42857] hover:bg-hover focus-visible:bg-hover outline-none disabled:opacity-50 disabled:cursor-not-allowed">
          <span className="size-4 shrink-0 [&>svg]:size-4">{item.icon}</span>
          <span className="shrink-0">{item.label}</span>
          {item.description && <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{item.description}</span>}
        </button>)}
      </PopoverContent>
    </Popover>
  );
}
