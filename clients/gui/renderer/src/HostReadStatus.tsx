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

export function HostReadStatus({ reads }: { reads: NonNullable<PlatformServices["reads"]> }) {
  const state = useSyncExternalStore(reads.subscribe, reads.status);
  return (
    <output
      aria-live="polite"
      data-testid="host-read-status"
      data-freshness={state.freshness}
      data-host-id={state.connection === "ready" ? state.identity.hostId : undefined}
      data-generation={state.connection === "ready" ? state.identity.hostGeneration : undefined}
    >
      Host ·{" "}
      {state.connection === "ready" ? (state.value?.state ?? state.connection) : state.connection}
    </output>
  );
}
