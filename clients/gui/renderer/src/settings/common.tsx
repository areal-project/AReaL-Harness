import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog.js";
import type { Action, Data } from "../services.js";
export type SettingsProps = { project: Data; thread?: Data; action: Action };
export function useResource(load: () => Promise<Data>, identity: string) {
  const loader = useRef(load);
  loader.current = load;
  const epoch = useRef(0);
  const [state, setState] = useState<{
    value?: Data;
    loading: boolean;
    error?: string;
  }>({ loading: true });
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const value = await loader.current();
      if (request === epoch.current) setState({ value, loading: false });
      return value;
    } catch (error) {
      if (request === epoch.current)
        setState((s) => ({
          ...s,
          loading: false,
          error: (error as Error).message,
        }));
      return undefined;
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [identity, refresh]);
  return { ...state, refresh };
}
export { Feedback } from "../components/ui/feedback.js";
export function SettingsToolbar({
  description,
  loading,
  disabled,
  onRefresh,
  onAdd,
  addLabel = "新建",
  addDisabled,
}: {
  description: string;
  loading?: boolean;
  disabled?: boolean;
  onRefresh?: () => void;
  onAdd?: () => void;
  addLabel?: string;
  addDisabled?: boolean;
}) {
  return (
    <div className="settings-toolbar">
      <p>{description}</p>
      <div>
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon-md"
            aria-label="刷新"
            disabled={disabled || loading}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        )}
        {onAdd && (
          <Button disabled={disabled || addDisabled} onClick={onAdd}>
            <Plus />
            {addLabel}
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
  className,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  busy?: boolean;
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
