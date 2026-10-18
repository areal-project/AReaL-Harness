import { AskPermissionIcon, AutoPermissionIcon } from "./permissionIcons.js";
import { Button } from "./components/ui/button.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./components/ui/dropdown-menu.js";
import { permissionChoices, type PermissionMode } from "./permissions.js";

const menuChoices = permissionChoices.filter((option) => option.id !== "plan");
const composerLabel = (id: string, fallback?: string) => id === "ask" ? "请求审批" : id === "auto" ? "帮我审批" : fallback;

export function ComposerPermissionMenu({ value, disabled, lockedReadOnly, onChange, onClose }: {
  value: PermissionMode | "custom" | "readOnly"; disabled?: boolean; lockedReadOnly?: boolean;
  onChange: (value: PermissionMode) => void; onClose: () => void;
}) {
  const selected = permissionChoices.find(option => option.id === value);
  const Icon = value === "ask" ? AskPermissionIcon : AutoPermissionIcon;
  return (
    <DropdownMenu>
      <ControlHintTooltip title="更改权限">
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label="更改权限"
              data-composer-collapse-priority="0"
              className="group/permission size-7 gap-1 rounded-navigation p-0 text-ui-caption text-foreground-subtle @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <Icon />
              <span className="hidden @xl/composer:inline group-data-[composer-compact=true]/permission:hidden">
                {composerLabel(value, selected?.label) ?? (value === "readOnly" ? "只读（受限）" : value === "plan" ? "计划" : "自定义权限")}
              </span>
            </Button>
          }
        />
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="composer-permission-menu w-[300px]"
        aria-label="选择权限"
        finalFocus={() => {
          onClose();
          return false;
        }}
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(id) => onChange(id as PermissionMode)}
        >
          {menuChoices.map((option) => {
            const ChoiceIcon = option.id === "ask" ? AskPermissionIcon : AutoPermissionIcon;
            return (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                disabled={lockedReadOnly}
                className="permission-choice items-start gap-2 text-ui-caption"
              >
                <ChoiceIcon />
                <span className="flex min-w-0 flex-col">
                  <span className="permission-choice-label">{composerLabel(option.id, option.label)}</span>
                  <span className="permission-choice-description text-ui-sm text-foreground-subtle">
                    {option.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <p className="px-3 py-2 text-ui-caption text-foreground-subtle">
          {lockedReadOnly
            ? "当前预设限制为只读。"
            : "部署与 Agent 预设的限制始终生效；已入队消息保留原权限。"}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
