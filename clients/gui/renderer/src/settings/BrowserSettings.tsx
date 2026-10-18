import {
  SettingsGroupCard,
  SettingsSection,
  SettingsRow,
  SettingsSwitch,
} from "./SettingsPageParts.js";
import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import type { Action, Data } from "../services.js";

/** Only settings wired to the current native preview are editable. */
export function BrowserSettings({ settings = {}, action, connected = false }: { settings?: Data; action?: Action; connected?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  const save = async (key: string, value: string | boolean) => {
    if (!action || !connected || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action('library', { operation: 'settings', key, value }); }
    catch (cause) { setError((cause as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  const destination = (label: string, key: string, fallback: string) => <DropdownMenu>
    <DropdownMenuTrigger render={<Button size="sm" variant="outline" aria-label={label} disabled={!action || !connected || busy}>{(settings[key] ?? fallback) === 'internal' ? '应用内' : '默认浏览器'}<ChevronDown size={12} aria-hidden="true" /></Button>} />
    <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void save(key, 'internal')}>应用内</DropdownMenuItem><DropdownMenuItem onClick={() => void save(key, 'external')}>默认浏览器</DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu>;
  return (
    <div className="settings-sections">
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <SettingsSection title="常规">
      <SettingsGroupCard>
        <SettingsRow
          label="网页 URL 和链接打开位置"
          description="链接默认打开位置"
          control={destination('网页 URL 和链接打开位置', 'browserLinkTarget', 'external')}
        />
        <SettingsRow
          label="本地 URL 打开位置"
          description="本地开发站点默认打开位置"
          control={destination('本地 URL 打开位置', 'browserLocalTarget', 'internal')}
        />
        <SettingsRow
          label="显示完整网址"
          description="在地址栏中显示路径、查询参数和片段"
          control={<SettingsSwitch aria-label="显示完整网址" checked={settings.browserFullAddress === true} disabled={!action || !connected || busy} onCheckedChange={value => void save('browserFullAddress', value)} />}
        />
      </SettingsGroupCard>
      </SettingsSection>
    </div>
  );
}
