import { useRef, useState } from "react";
import type { PlatformServices } from "../services.js";
import { Button } from "../components/ui/button.js";
import { SettingsRow } from "./SettingsPageParts.js";

export function ProjectlessDirectorySetting({ directory, choose, connected }: {
  directory?: string; choose?: PlatformServices["chooseProjectlessDirectory"]; connected: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  const change = async () => {
    if (!choose || !connected || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await choose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "目录设置未保存"); }
    finally { pending.current = false; setBusy(false); }
  };
  return <>
    <SettingsRow label="无项目任务文件夹" description="新项目外任务各自保存到此文件夹中的独立目录；已有任务保留原位置。"
      control={<div className="flex min-w-0 items-center gap-2"><span className="max-w-60 truncate text-xs" title={directory}>{directory ?? "未连接"}</span><Button size="sm" variant="outline" aria-label="更改无项目任务文件夹" disabled={!connected || !choose || busy} onClick={() => void change()}>更改</Button></div>} />
    {error && <p role="alert" className="px-4 py-2 text-destructive">{error}</p>}
  </>;
}
