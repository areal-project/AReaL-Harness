import { useRef, useState } from "react";
import type { Action, Snapshot } from "../services.js";
import { SettingsRow, SettingsSwitch } from "./SettingsPageParts.js";

export function MenuBarSetting({ enabled, state, action, connected }: {
  enabled: boolean; state?: Snapshot["menuBar"]; action?: Action; connected: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const save = async (value: boolean) => {
    if (saving.current || !connected || !action || !state?.supported) return;
    saving.current = true; setBusy(true); setError("");
    try { await action("library", { operation: "settings", key: "showInMenuBar", value }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "菜单栏设置保存失败"); }
    finally { saving.current = false; setBusy(false); }
  };
  return <>
    <SettingsRow label="在菜单栏中显示" description="关闭主窗口后，仍可从 macOS 菜单栏返回应用"
      control={<SettingsSwitch aria-label="在菜单栏中显示" checked={enabled}
        disabled={!state?.supported || !connected || !action || busy} onCheckedChange={value => void save(value)} />} />
    {(error || state?.error) && <p role="alert" className="px-4 py-2 text-destructive">{error || state?.error}</p>}
  </>;
}
