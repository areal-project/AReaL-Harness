import { useSyncExternalStore } from "react";
import { useI18n, type MessageId } from "./i18n/IntlProvider.js";
import type { PlatformServices } from "./services.js";

const STATE_MESSAGES: Record<string, MessageId> = {
  ready: "hostRead.state.ready",
  running: "hostRead.state.running",
  connecting: "hostRead.state.connecting",
  reconnecting: "hostRead.state.reconnecting",
  stale: "hostRead.state.stale",
  unavailable: "hostRead.state.unavailable",
  closed: "hostRead.state.closed",
};

export function HostReadStatus({ reads }: { reads: NonNullable<PlatformServices["reads"]> }) {
  const state = useSyncExternalStore(reads.subscribe, reads.status);
  const { t } = useI18n();
  const key = state.connection === "ready" ? (state.value?.state ?? "ready") : state.connection;
  const status = t(STATE_MESSAGES[key] ?? "hostRead.state.unknown");
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
      {t("hostRead.status", { status })}
    </output>
  );
}
