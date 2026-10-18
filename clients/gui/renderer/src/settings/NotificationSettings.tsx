import { useRef, useState } from "react";
import type { Action, Data } from "../services.js";
import { Feedback } from "../components/ui/feedback.js";
import { SettingsSection, SettingsGroupCard, SettingsRow, SettingsSwitch } from "./SettingsPageParts.js";

export function NotificationSettings({ settings, action, connected }: { settings: Data; action?: Action; connected: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const disabled = !connected || !action || busy;
  const save = async (key: string, value: string | boolean) => {
    if (saving.current || !connected || !action) return;
    saving.current = true; setBusy(true); setError("");
    try { await action("library", { operation: "settings", key, value }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "通知设置保存失败"); }
    finally { saving.current = false; setBusy(false); }
  };
  return <SettingsSection title="通知">
    <Feedback error={error} />
    <SettingsGroupCard>
      <SettingsRow label="轮次完成通知" description="设置任务完成后何时提醒" control={
        <select aria-label="轮次完成通知" disabled={disabled} value={settings.turnNotifications ?? "unfocused"} onChange={e => void save("turnNotifications", e.target.value)}>
          <option value="always">始终</option><option value="unfocused">仅在未聚焦时</option><option value="never">从不</option>
        </select>
      } />
      <SettingsRow label="启用权限通知" description="需要你批准工具操作时显示提醒" control={
        <SettingsSwitch aria-label="启用权限通知" disabled={disabled} checked={settings.permissionNotifications !== false} onCheckedChange={v => void save("permissionNotifications", v)} />
      } />
      <SettingsRow label="启用问题通知" description="需要输入才能继续时显示提醒" control={
        <SettingsSwitch aria-label="启用问题通知" disabled={disabled} checked={settings.questionNotifications !== false} onCheckedChange={v => void save("questionNotifications", v)} />
      } />
      <SettingsRow label="通知声音" description="任务完成、权限请求和提问时播放的声音" control={
        <select aria-label="通知声音" disabled={disabled} value={settings.notificationSound ?? "default"} onChange={e => void save("notificationSound", e.target.value)}>
          <option value="default">默认</option><option value="silent">无</option>
        </select>
      } />
    </SettingsGroupCard>
  </SettingsSection>;
}
