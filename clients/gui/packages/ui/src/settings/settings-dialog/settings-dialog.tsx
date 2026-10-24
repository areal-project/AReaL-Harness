import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../../components/dialog/dialog.js";
export function SettingsToolbar({
  description,
  loading,
  disabled,
  onRefresh,
  onAdd,
  addLabel,
  addDisabled,
  refreshLabel = "Refresh",
  newLabel = "New",
}: {
  description: string;
  loading?: boolean;
  disabled?: boolean;
  onRefresh?: () => void;
  onAdd?: () => void;
  addLabel?: string;
  addDisabled?: boolean;
  refreshLabel?: string;
  newLabel?: string;
}) {
  return (
    <div className="settings-toolbar">
      <p>{description}</p>
      <div>
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={refreshLabel}
            disabled={disabled || loading}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        )}
        {onAdd && (
          <Button disabled={disabled || addDisabled} onClick={onAdd}>

            {addLabel ?? newLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
export function SettingsDialog({
  title,
  description,
  onClose,
  busy,
  closeLabel = "Close dialog",
  className,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  busy?: boolean;
  closeLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // Settings are conditionally mounted; closing is owned by the caller.
        details.event.stopPropagation();
        details.cancel();
        if (!busy) onClose();
      }}
    >
      <DialogContent
        closeLabel={closeLabel}
        showCloseButton={!busy}
        className={["settings-dialog sm:max-w-2xl", className].filter(Boolean).join(" ")}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function EmptySettings({ children }: { children: ReactNode }) {
  return <div className="settings-empty">{children}</div>;
}
