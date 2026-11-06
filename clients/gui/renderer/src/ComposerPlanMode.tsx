import type { ComponentType } from "react";
import { GoalIcon, PlanModeIcon } from "./interfaceIcons.js";
import { Button } from "./components/ui/button.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { useI18n } from "./i18n/IntlProvider.js";

// 计划模式与目标模式在新对话和已有对话里是同一个标记，外观只在这里定义。
function ComposerModeChip({
  icon: Icon,
  label,
  exitLabel,
  disabled,
  onExit,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  exitLabel: string;
  disabled?: boolean;
  onExit: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="status" data-composer-mode="">
      <span className="h-4 border-l border-border" aria-hidden="true" />
      <ControlHintTooltip title={exitLabel}>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="gap-1 rounded-full px-2 text-ui-caption leading-[18px] text-foreground-subtle"
          aria-label={exitLabel}
          disabled={disabled}
          onClick={onExit}
        >
          <Icon className="size-4" aria-hidden />
          <span>{label}</span>
        </Button>
      </ControlHintTooltip>
    </div>
  );
}

export function ComposerPlanMode(props: { disabled?: boolean; onExit: () => void }) {
  const { t } = useI18n();
  return (
    <ComposerModeChip
      icon={PlanModeIcon}
      label={t("chat.composer.planMode")}
      exitLabel={t("chat.composer.exitPlanMode")}
      {...props}
    />
  );
}

export function ComposerGoalMode(props: { disabled?: boolean; onExit: () => void }) {
  const { t } = useI18n();
  return (
    <ComposerModeChip
      icon={GoalIcon}
      label={t("chat.composer.goalMode")}
      exitLabel={t("chat.composer.exitGoalMode")}
      {...props}
    />
  );
}
