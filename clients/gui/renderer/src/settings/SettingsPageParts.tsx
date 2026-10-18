import type { ReactNode } from "react";
import "./SettingsWorkspace.css";
import { Card, CardContent } from "@/components/ui/card.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("settings-section", className)}>
      {(title || action || description) && (
        <div className="settings-section-heading">
          <div className="min-w-0">
            {title && <h2>{title}</h2>}
            {description && <p className="settings-section-desc">{description}</p>}
          </div>
          {action && <div className="settings-section-action">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  detail,
  controlLayout = "default",
  disabled = false,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  detail?: ReactNode;
  controlLayout?: "default" | "wide";
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("settings-field-row", className)} aria-disabled={disabled || undefined}>
      <div
        className={cn(
          "settings-field-layout",
          controlLayout === "wide" && "settings-field-layout-wide",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="settings-field-label">{label}</div>
          {description ? (
            <div className="settings-field-description">{description}</div>
          ) : null}
        </div>
        <div className="settings-field-control">
          {controlLayout === "wide" ? detail : null}
          {control}
        </div>
      </div>
      {detail && controlLayout !== "wide" ? <div className="mt-3">{detail}</div> : null}
    </div>
  );
}

export function SettingsGroupCard({
  children,
  className,
  density,
}: {
  children: ReactNode;
  className?: string;
  density?: "compact";
}) {
  return (
    <Card
      data-density={density}
      className={cn(
        "settings-group-card overflow-hidden border border-border bg-card py-0 shadow-none",
        className,
      )}
    >
      <CardContent className="space-y-0 px-0">{children}</CardContent>
    </Card>
  );
}

export function SettingsLockedValue({ label, value }: { label: string; value: string }) {
  return (
    <button type="button" className="settings-locked-value" aria-label={label} disabled>
      <span>{value}</span>
    </button>
  );
}

export function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle">
      {children}
    </span>
  );
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
    />
  );
}

export function SettingsValueAction({
  value,
  actionLabel = "更改",
  onAction,
  disabled = false,
}: {
  value: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3">
      <span className="min-w-0 text-ui-sm text-foreground-subtle max-w-[280px] truncate">{value}</span>
      {onAction && (
        <Button type="button" variant="secondary" onClick={onAction} disabled={disabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
