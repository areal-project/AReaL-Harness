import { PlanModeIcon as Lightbulb } from "./interfaceIcons.js";
import { Button } from "./components/ui/button.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";

export function ComposerPlanMode({ disabled, onExit }: { disabled?: boolean; onExit: () => void }) {
  return <div className="flex shrink-0 items-center gap-1" role="status">
    <span className="h-4 border-l border-border" aria-hidden="true" />
    <ControlHintTooltip title="退出计划模式">
      <Button type="button" variant="ghost" size="default" className="gap-1 rounded-full px-2 text-ui-caption leading-[18px] text-foreground-subtle"
        aria-label="退出计划模式" disabled={disabled} onClick={onExit}>
        <Lightbulb className="size-4" aria-hidden="true" />
        <span>计划模式</span>
      </Button>
    </ControlHintTooltip>
  </div>;
}
