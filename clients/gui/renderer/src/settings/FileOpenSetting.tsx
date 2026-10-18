import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import { SettingsRow } from "./SettingsPageParts.js";
import type { PlatformServices, FileOpenTargets } from "../services.js";

export function FileOpenSetting({ service, preferred, connected }: {
  service?: PlatformServices["fileOpen"]; preferred?: string; connected: boolean;
}) {
  const [catalog, setCatalog] = useState<FileOpenTargets>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), saving = useRef(false);
  useEffect(() => {
    let current = true;
    if (service) void service({ operation: "targets" }).then(value => { if (current) { setCatalog(value as FileOpenTargets); setError(""); } }).catch(cause => { if (current) setError(cause.message); });
    return () => { current = false; };
  }, [service, preferred, connected]);
  const save = async (target: string) => {
    if (!service || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try { await service({ operation: "setDefault", target }); }
    catch (cause) { setError((cause as Error).message); }
    finally { saving.current = false; setBusy(false); }
  };
  return <SettingsRow label="默认文件打开位置" description="默认打开文件和文件夹的位置"
    detail={error && <span role="alert" className="text-destructive">{error}</span>}
    control={<DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="默认文件打开位置" disabled={!service || !connected || !catalog || busy}>{catalog?.preferredLabel ?? "读取中…"}</Button>} />
      <DropdownMenuContent align="end">{catalog?.targets.map(target => <DropdownMenuItem key={target.id} onClick={() => void save(target.id)}>{target.label}</DropdownMenuItem>)}</DropdownMenuContent>
    </DropdownMenu>} />;
}
