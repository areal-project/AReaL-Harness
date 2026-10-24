import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

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
