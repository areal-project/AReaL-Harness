import { Activity, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
import { ConversationStatusCard } from "../ConversationStatusCard.js";
import { Button } from "../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { TaskSummaryIcon } from "../homeChromeIcons.js";
import type { Action, Data } from "../services.js";

export function TaskResourcesPopover({
  project,
  thread,
  action,
  onPanel,
  onAgent,
  onFile,
  scheduledTask,
  revealKey,
  onReveal,
  onAddSchedule,
  onOpenSchedule,
  onReadAgents,
  onAddSource,
  onLink,
}: {
  onAddSource?: () => void;
  onLink?: (url: string) => void;
  onReadAgents?: (restore: () => void) => void;
  project: Data;
  thread: Data;
  action: Action;
  scheduledTask?: Data;
  revealKey?: string;
  onReveal?: (key: string) => void;
  onPanel: (name: string) => void;
  onAgent: (id: string) => void;
  onFile: (path: string) => void;
  onAddSchedule?: () => void;
  onOpenSchedule?: (task: Data) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const composerHandoff = useRef(false);
  useEffect(() => {
    if (revealKey) {
      setOpen(true);
      onReveal?.(revealKey);
    }
  }, [revealKey, onReveal]);
  const navigate =
    <T,>(callback: (value: T) => void) =>
    (value: T) => {
      setOpen(false);
      callback(value);
    };
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (!next && ["outside-press", "focus-out"].includes(details.reason)) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            unstyled
            type="button"
            ref={trigger}
            className={`icon-button ${open ? "active" : ""}`}
            aria-label={t("chat.resources.trigger")}
          />
        }
      >
        <TaskSummaryIcon />
      </PopoverTrigger>
      <PopoverContent
        keepMounted
        finalFocus={() => {
          if (composerHandoff.current) {
            composerHandoff.current = false;
            return false;
          }
          return trigger.current;
        }}
        align="end"
        sideOffset={8}
        className="task-resources-popup"
        aria-label={t("chat.resources.panel")}
      >
        <Activity mode={open ? "visible" : "hidden"}>
          <ConversationStatusCard
            onLink={onLink}
            onAddSource={
              onAddSource
                ? () => {
                    setOpen(false);
                    onAddSource();
                  }
                : undefined
            }
            project={project}
            thread={thread}
            action={action}
            scheduledTask={scheduledTask}
            onAddSchedule={
              onAddSchedule
                ? () => {
                    composerHandoff.current = true;
                    setOpen(false);
                    onAddSchedule();
                  }
                : undefined
            }
            onOpenSchedule={onOpenSchedule ? navigate(onOpenSchedule) : undefined}
            onAgents={() => {
              setOpen(false);
              if (onReadAgents) onReadAgents(() => setOpen(true));
              else onPanel("子代理");
            }}
            onPanel={navigate(onPanel)}
            onAgent={navigate(onAgent)}
            onFile={navigate(onFile)}
          />
        </Activity>
      </PopoverContent>
    </Popover>
  );
}
