import { SquarePen } from "./interfaceIcons.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function NewTaskButtonGroup({ onCreateTask, disabled = false }: {
  onCreateTask: () => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const mac = navigator.platform.includes("Mac");
  return <Tooltip disabled={disabled}>
    <TooltipTrigger render={<button type="button" className="navigation-task-row new-task-action"
      aria-label="新聊天" aria-keyshortcuts={mac ? "Meta+N" : "Control+N"}
      disabled={disabled} data-testid="task-new-button" onClick={onCreateTask} />}>
      <SquarePen size={16} aria-hidden="true" />
      <span>{intl.formatMessage({ id: "taskList.newThread" })}</span>
    </TooltipTrigger>
    <TooltipContent role="tooltip" side="top" sideOffset={2} className="new-task-shortcut">{mac ? "⌘N" : "Ctrl+N"}</TooltipContent>
  </Tooltip>;
}
