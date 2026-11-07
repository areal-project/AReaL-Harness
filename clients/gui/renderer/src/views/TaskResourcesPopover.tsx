import { Activity, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
import { ConversationStatusCard } from "../ConversationStatusCard.js";
import { Button } from "../components/ui/button.js";
import { TitleTooltip } from "@areal/ui";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { TaskSummaryIcon } from "../homeChromeIcons.js";
import type { Action, Data, PlatformServices } from "../services.js";
import { useWorkspaceChanges } from "../useWorkspaceChanges.js";

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
  fileOpen,
}: {
  fileOpen?: PlatformServices["fileOpen"];
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
  const { t, intl } = useI18n();
  const changes = useWorkspaceChanges(project, thread, action);
  const changed = changes.files.length > 0;
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
        // 点卡片外时焦点先离开，库只报 focus-out；窗口整体失焦（系统文件选择框、切到别的应用）不算关闭。
        if (!next && details.reason === "focus-out") {
          setTimeout(() => {
            if (document.hasFocus()) setOpen(false);
          });
          return;
        }
        setOpen(next);
      }}
    >
      <TitleTooltip
        title={
          changed
            ? `${t("chat.context.changeScope", { count: changes.files.length })} · +${intl.formatNumber(changes.additions)} −${intl.formatNumber(changes.deletions)}`
            : undefined
        }
      >
        <PopoverTrigger
          render={
            <Button
              unstyled
              type="button"
              ref={trigger}
              className={`icon-button task-resources-trigger ${open ? "active" : ""}`}
              data-variant={changed ? "count" : undefined}
              aria-label={t("chat.resources.trigger")}
            />
          }
        >
          <TaskSummaryIcon />
          {changed && (
            <span className="diff-count" aria-hidden="true">
              <b>+{intl.formatNumber(changes.additions)}</b>
              <em>−{intl.formatNumber(changes.deletions)}</em>
            </span>
          )}
        </PopoverTrigger>
      </TitleTooltip>
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
            changes={changes}
            fileOpen={fileOpen}
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
