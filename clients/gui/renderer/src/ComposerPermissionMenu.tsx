import { AskPermissionIcon, AutoPermissionIcon } from "./permissionIcons.js";
import { Button } from "./components/ui/button.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./components/ui/dropdown-menu.js";
import { permissionChoices, type PermissionMode, type PermissionPreset } from "./permissions.js";
import type { Data } from "./services.js";
import { useI18n } from "./i18n/IntlProvider.js";

export function ComposerPermissionMenu({
  value,
  configuration,
  permissionsSupported,
  fullAccessAvailable,
  capabilitiesPending = false,
  disabled,
  lockedReadOnly,
  onChange,
  onClose,
  presentation = "menu",
}: {
  value: PermissionMode;
  presentation?: "menu" | "inline";
  configuration?: Data;
  permissionsSupported?: boolean;
  fullAccessAvailable?: boolean;
  /** 项目尚未拿到本代能力目录时为 true：保留已选偏好展示，锁定高风险选项，不误报“不支持”。 */
  capabilitiesPending?: boolean;
  disabled?: boolean;
  lockedReadOnly?: boolean;
  onChange: (value: PermissionPreset) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const supported =
    !capabilitiesPending && (permissionsSupported === true || !!configuration?.permissions);
  const fullAccess =
    !capabilitiesPending &&
    (configuration?.permissions
      ? configuration.permissions.fullAccessAvailable === true
      : fullAccessAvailable === true);
  const explicitPreset = configuration ? configuration.options?.permissionPreset != null : true;
  const effectiveValue =
    value === "readOnly"
      ? value
      : capabilitiesPending
        ? value
        : explicitPreset && !supported
          ? "unsupported"
          : value === "fullAccess" && !fullAccess
            ? "restricted"
            : value;
  const selected = permissionChoices.find((option) => option.id === effectiveValue);
  const requested = configuration?.options?.permissionPreset ?? value;
  const Icon = effectiveValue === "ask" ? AskPermissionIcon : AutoPermissionIcon;
  const choices = permissionChoices.map((option) => {
    const ChoiceIcon = option.id === "ask" ? AskPermissionIcon : AutoPermissionIcon;
    return {
      option,
      disabled:
        disabled ||
        lockedReadOnly ||
        (capabilitiesPending
          ? option.id === "fullAccess"
          : !supported || (option.id === "fullAccess" && !fullAccess)),
      content: (
        <>
          <ChoiceIcon />
          <span className="flex min-w-0 flex-col">
            <span className="permission-choice-label">{t(option.labelId)}</span>
            <span className="permission-choice-description text-ui-sm text-foreground-subtle">
              {option.id === "fullAccess" && capabilitiesPending
                ? t("chat.permissions.pendingNotice")
                : option.id === "fullAccess" && supported && !fullAccess
                  ? t("chat.permissions.fullAccessUnavailable")
                  : t(option.descriptionId)}
            </span>
          </span>
        </>
      ),
    };
  });
  if (presentation === "inline")
    return (
      <div
        role="group"
        aria-label={t("chat.permissions.choose")}
        className="flex flex-col gap-inline"
      >
        {choices.map(({ option, disabled, content }) => (
          <Button
            key={option.id}
            variant={value === option.id ? "secondary" : "ghost"}
            aria-pressed={value === option.id}
            data-permission-preset={option.id}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            className="min-h-[var(--size-touch-target)] h-auto w-full justify-start gap-inline whitespace-normal text-start"
          >
            {content}
          </Button>
        ))}
      </div>
    );
  return (
    <DropdownMenu>
      <ControlHintTooltip title={t("chat.permissions.change")}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={t("chat.permissions.change")}
              data-composer-collapse-priority="0"
              className="group/permission size-7 gap-1 rounded-navigation p-0 text-ui-caption text-foreground-subtle @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <Icon />
              <span className="hidden @xl/composer:inline group-data-[composer-compact=true]/permission:hidden">
                {selected
                  ? t(selected.labelId)
                  : t(
                      effectiveValue === "readOnly"
                        ? "chat.permissions.readOnly"
                        : effectiveValue === "plan"
                          ? "chat.permissions.plan"
                          : effectiveValue === "auto"
                            ? "chat.permissions.auto"
                            : effectiveValue === "restricted"
                              ? "chat.permissions.restricted"
                              : effectiveValue === "unsupported"
                                ? "chat.permissions.unsupported"
                                : "chat.permissions.custom",
                    )}
              </span>
            </Button>
          }
        />
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="composer-permission-menu w-[300px]"
        aria-label={t("chat.permissions.choose")}
        finalFocus={() => {
          onClose();
          return false;
        }}
      >
        <DropdownMenuRadioGroup
          value={requested}
          onValueChange={(id) => {
            const choice = permissionChoices.find((option) => option.id === id);
            if (choice) onChange(choice.id);
          }}
        >
          {choices.map(({ option, disabled, content }) => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              disabled={disabled}
              className="permission-choice items-start gap-2 text-ui-caption [&_[data-slot=dropdown-menu-radio-item-indicator]]:top-1/2 [&_[data-slot=dropdown-menu-radio-item-indicator]]:-translate-y-1/2"
            >
              {content}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-3 py-2 text-ui-caption text-foreground-subtle">
          {lockedReadOnly
            ? t("chat.permissions.readOnlySession")
            : capabilitiesPending
              ? t("chat.permissions.pendingNotice")
              : !supported
                ? t("chat.permissions.unsupportedBackend")
                : requested === "autoReview" && configuration?.permissions?.reviewer === "human"
                  ? t("chat.permissions.humanFallback")
                  : t("chat.permissions.limitsNotice")}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
