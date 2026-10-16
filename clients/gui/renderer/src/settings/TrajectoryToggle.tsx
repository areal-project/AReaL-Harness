import type { TrajectoryStatus } from "@areal/workbench/desktop-contract";
import { Switch } from "../components/ui/switch.js";
import "./trajectory-settings.css";

export function TrajectoryToggle({
    status,
    busy,
    stale,
    onChange,
}: {
    status: TrajectoryStatus;
    busy: boolean;
    stale: boolean;
    onChange(enabled: boolean): void;
}) {
    const pending = status.capture_apply_pending || !!status.capture_apply_error;
    const enabled = status.enabled && !stale && !pending && status.state === "ready";
    const label = stale
        ? "状态待确认"
        : status.enabled
          ? pending
              ? "已开启 · 待应用"
              : status.state === "ready"
                ? "已开启"
                : "已开启 · 需检查"
          : "未开启";
    return (
        <div
            className="trajectory-toggle-control"
            data-upload-state={enabled ? "enabled" : "attention"}
        >
            <span className="trajectory-toggle-label" aria-live="polite">
                {label}
            </span>
            <Switch
                aria-label="启用数据飞轮"
                className="trajectory-toggle"
                checked={status.enabled}
                disabled={
                    busy ||
                    stale ||
                    !/^[a-f0-9]{64}$/.test(status.config_revision ?? "") ||
                    (!status.enabled && (!status.endpoint || status.endpoint === "<invalid>"))
                }
                onCheckedChange={onChange}
            />
        </div>
    );
}
