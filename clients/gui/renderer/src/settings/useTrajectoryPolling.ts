import { useCallback, useEffect, useRef, useState } from "react";
import type { TrajectoryStatus } from "@areal/workbench/desktop-contract";
import type { Action } from "../services.js";
import { createTrajectoryPoller, type TrajectoryOperation } from "../lib/trajectory-polling.js";

type Poller = ReturnType<typeof createTrajectoryPoller<TrajectoryStatus>>;
const pollers = new WeakMap<Action, Poller>();

export function useTrajectoryPolling(
  action: Action,
  options: {
    connected: boolean;
    intervalMs: number;
    onResult(status: TrajectoryStatus, operation: TrajectoryOperation): void;
    onError(error: unknown, operation: TrajectoryOperation): void;
    onBusy?(operation: TrajectoryOperation | null): void;
  },
) {
  const latest = useRef(options);
  latest.current = options;
  const subscription = useRef<ReturnType<Poller["watch"]> | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!options.connected || !visible) {
      latest.current.onBusy?.(null);
      return;
    }
    let poller = pollers.get(action);
    if (!poller) {
      let snapshot: TrajectoryStatus | undefined;
      poller = createTrajectoryPoller(async (operation) => {
        const value: TrajectoryStatus = await action(
          "trajectory",
          operation === "enable" || operation === "disable"
            ? {
                operation: "setEnabled",
                enabled: operation === "enable",
                expectedRevision: snapshot?.config_revision ?? "",
              }
            : { operation },
        );
        snapshot = value;
        return value;
      });
      pollers.set(action, poller);
    }
    const active = poller.watch({
      intervalMs: options.intervalMs,
      onResult: (value, operation) => latest.current.onResult(value, operation),
      onError: (error, operation) => latest.current.onError(error, operation),
      onBusy: (operation) => latest.current.onBusy?.(operation),
    });
    subscription.current = active;
    return () => {
      active.stop();
      if (subscription.current === active) subscription.current = null;
    };
  }, [action, options.connected, options.intervalMs, visible]);
  return useCallback((operation: TrajectoryOperation = "status") => {
    if (document.visibilityState !== "visible") return false;
    return subscription.current?.refresh(operation) ?? false;
  }, []);
}
