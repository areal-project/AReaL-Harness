import { useEffect, useRef, useState } from "react";
import type { PlatformServices } from "../services.js";
import type { RecoveryOwner } from "../recoveryPresentation.js";

type PresentationGate = {
  themeReady: boolean;
  startupReady: boolean | undefined;
  restorationFailed: boolean;
  projectFailureReady: boolean;
};

export function useStartupPresentation(
  services: PlatformServices,
  gate: PresentationGate,
  restoration: (RecoveryOwner & { pending: boolean; error: string }) | undefined,
  restorationOwner: RecoveryOwner,
) {
  const { themeReady, startupReady, restorationFailed, projectFailureReady } = gate;
  const [shellReady, setShellReady] = useState(false);
  const [initialPresentation, setInitialPresentation] = useState<"pending" | "failed" | "ready">(
    "pending",
  );
  const initialReleased = initialPresentation === "ready";
  const [startupDelayed, setStartupDelayed] = useState(false);
  useEffect(() => {
    if (restorationFailed || startupReady || projectFailureReady)
      setInitialPresentation((previous) =>
        previous === "ready" ? previous : startupReady || projectFailureReady ? "ready" : "failed",
      );
  }, [startupReady, restorationFailed, projectFailureReady]);
  useEffect(() => {
    setStartupDelayed(false);
    if (initialReleased) return;
    const timer = window.setTimeout(() => setStartupDelayed(true), 15000);
    return () => window.clearTimeout(timer);
  }, [
    initialReleased,
    restoration,
    restorationOwner.projectId,
    restorationOwner.threadId,
    restorationOwner.connectionGeneration,
  ]);
  const presented = useRef(false);
  useEffect(() => {
    if (!themeReady || presented.current) return;
    let active = true,
      frame = 0;
    void document.fonts.ready.then(() => {
      if (!active) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!active) return;
          presented.current = true;
          setShellReady(true);
          void services.presentReady?.().catch(() => {});
        });
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [themeReady, services]);
  return { shellReady, initialReleased, startupDelayed };
}
