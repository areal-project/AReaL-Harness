import { useSyncExternalStore } from "react";
import type { PlatformServices } from "./services.js";

export function hostReadsEnabled() {
  try {
    return localStorage.getItem("areal.oneProtocol.reads") === "1";
  } catch {
    return false;
  }
}

/** A2 写开关：只在读开关之上生效，桌面停止与审批/回答改走 Host 回执。 */
export function hostWritesEnabled() {
  try {
    return hostReadsEnabled() && localStorage.getItem("areal.oneProtocol.writes") === "1";
  } catch {
    return false;
  }
}

const STATE_TEXT: Record<string, string> = {
  ready: "已连接",
  running: "运行中",
  connecting: "连接中",
  reconnecting: "重新连接中",
  stale: "等待刷新",
  unavailable: "不可用",
  closed: "已断开",
};

export function HostReadStatus({ reads }: { reads: NonNullable<PlatformServices["reads"]> }) {
  const state = useSyncExternalStore(reads.subscribe, reads.status);
  return (
    // 只给辅助技术与验收读；可见的话会排在 #root 之外把页面撑高。
    <output
      className="sr-only"
      aria-live="polite"
      data-testid="host-read-status"
      data-freshness={state.freshness}
      data-host-id={state.connection === "ready" ? state.identity.hostId : undefined}
      data-generation={state.connection === "ready" ? state.identity.hostGeneration : undefined}
    >
      {`Host 状态：${STATE_TEXT[state.connection === "ready" ? (state.value?.state ?? "ready") : state.connection] ?? "未知"}`}
    </output>
  );
}
