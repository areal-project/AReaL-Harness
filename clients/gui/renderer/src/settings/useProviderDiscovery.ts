import { useEffect, useRef, useState } from "react";
import type { Action } from "../services.js";

export type { DiscoveryConnection } from "../services.js";
import type { DiscoveryConnection, ModelParameters } from "../services.js";
type DiscoveryState =
  | { kind: "idle" | "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; models: string[]; modelParameters?: Record<string, ModelParameters> };

export function useProviderDiscovery(action: Action, connection: DiscoveryConnection | null) {
  const current = useRef({ action, connection });
  current.current = { action, connection };
  const epoch = useRef(0);
  const [state, setState] = useState<DiscoveryState>({ kind: "idle" });
  const invalidate = () => {
    epoch.current++;
    setState({ kind: "idle" });
  };
  const fetch = async (request: number) => {
    const input = current.current.connection;
    if (!input || request !== epoch.current) return;
    setState({ kind: "loading" });
    try {
      const result = await current.current.action("providers", {
        operation: "discover",
        connection: input,
      });
      if (request === epoch.current)
        setState({
          kind: "ready",
          models: [...new Set<string>(result.models)],
          modelParameters: result.modelParameters,
        });
    } catch (error) {
      if (request === epoch.current)
        setState({ kind: "failed", message: (error as Error).message });
    }
  };
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  return {
    state,
    invalidate,
    refresh: () => {
      invalidate();
      void fetch(epoch.current);
    },
  };
}
