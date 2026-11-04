import { useEffect, useMemo, useSyncExternalStore } from "react";
import { HostClient } from "@areal/client";
import type { PlatformServices } from "./services.js";

export function hostReadsEnabled() {
  try {
    return localStorage.getItem("areal.oneProtocol.reads") === "1";
  } catch {
    return false;
  }
}

export function HostReadStatus({
  bootstrap,
}: {
  bootstrap: NonNullable<PlatformServices["getHostTicket"]>;
}) {
  const client = useMemo(
    () => new HostClient({ bootstrap, origin: "areal-ui://app", events: window }),
    [bootstrap],
  );
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  useEffect(() => {
    client.retry();
    return () => client.close();
  }, [client]);
  return (
    <output
      aria-live="polite"
      data-testid="host-read-status"
      data-freshness={state.freshness}
      data-host-id={state.connection === "ready" ? state.value.hostId : undefined}
      data-generation={state.connection === "ready" ? state.value.generation : undefined}
    >
      Host · {state.connection === "ready" ? state.value.state : state.connection}
    </output>
  );
}
