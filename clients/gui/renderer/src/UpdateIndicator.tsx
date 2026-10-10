import { useEffect, useState } from "react";
import { RefreshIcon } from "./interfaceIcons.js";
import type { PlatformServices, UpdateState } from "./services.js";

export function UpdateIndicator({ services }: { services: PlatformServices }) {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!services.updateState || !services.onUpdate) return;
    const off = services.onUpdate(setUpdate);
    void services.updateState().then(setUpdate).catch(() => {});
    return off;
  }, [services]);
  if (!update?.enabled || update.status === "idle") return null;
  const canDownload = update.status === "available" || (update.status === "error" && !update.installing);
  const needsResources = update.status === "deferred" && update.detail?.includes("后台资源");
  const percent = typeof update.percent === "number" && Number.isFinite(update.percent) ? Math.max(0, Math.min(100, Math.round(update.percent))) : null;
  const performUpdate = async (action: () => Promise<UpdateState>, failureDetail: string) => {
    try { setUpdate(await action()); }
    catch (error) {
      console.warn("Update action failed", error);
      setUpdate(current => current && { ...current, status: "error", detail: failureDetail });
    }
  };
  const label = update.status === "available" ? `下载更新 ${update.version}`
    : update.status === "error" && !update.installing ? `重试更新 ${update.version}`
    : update.status === "downloading" ? `正在下载更新${percent === null ? "" : ` ${percent}%`}`
    : update.status === "validating" ? "正在校验更新"
    : update.status === "deferred" ? `更新 ${update.version} 已下载，等待安装：${update.detail}`
    : update.status === "error" && update.installing ? `安装未完成，请重新打开应用：${update.detail}`
    : `正在安装更新 ${update.version}`;
  return <div className="areal-update-indicator" data-testid="areal-update-status" role="status" title={update.detail ? `${label}：${update.detail}` : label}>
    {canDownload ? <button type="button" className="areal-update-action" data-testid="areal-update-download"
      aria-label={label} title={update.status === "available" ? "下载完成且任务空闲后会自动重启安装" : label} onClick={() => { if (services.downloadUpdate) void performUpdate(services.downloadUpdate, "无法启动更新下载，请重试。"); }}>
      <RefreshIcon size={16} />
    </button> : needsResources && services.recoverUpdateResources ? <button type="button" className="areal-update-current areal-update-recover" data-testid="areal-update-recover"
      aria-label="检查后台资源并继续安装更新" title={update.detail} onClick={() => { if (services.recoverUpdateResources) void performUpdate(services.recoverUpdateResources, "后台资源检查失败，请重试。"); }}>
      <RefreshIcon size={16} />
      <span className="sr-only">检查后台资源</span>
    </button> : <span className="areal-update-current" aria-label={label}>
      <span aria-hidden="true">{update.status === "downloading" && percent !== null ? `${percent}%` : <RefreshIcon size={16} className={update.status === "downloading" || update.status === "validating" || update.status === "installing" ? "areal-update-spin" : ""} />}</span>
      <span className="sr-only">{label}</span>
    </span>}
    {update.status === "downloading" && <progress data-testid="areal-update-progress" max={100} value={percent ?? undefined} aria-label="更新下载进度" />}
    {update.status === "deferred" && <span className="sr-only">{update.detail}</span>}
    {update.status === "error" && update.detail && <span className="areal-update-error" role="alert">{update.detail}</span>}
  </div>;
}
