import { useSyncExternalStore } from "react";

export type LabsFeatureId = "bots";

const STORAGE_KEY = "areal.gui.labs.v1";
const CHANGE_EVENT = "areal-labs-changed";

/** 本地构建默认提供 Labs 入口，具体实验功能仍需逐项打开。 */
export const labsAvailable =
  import.meta.env.DEV || import.meta.env.VITE_AREAL_LOCAL_BUILD === "true";

const defaultFeatures: Record<LabsFeatureId, boolean> = { bots: false };
const listeners = new Set<() => void>();

function readFeatures(): Record<LabsFeatureId, boolean> {
  if (typeof window === "undefined") return defaultFeatures;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return defaultFeatures;
    return { ...defaultFeatures, bots: (parsed as { bots?: unknown }).bots === true };
  } catch {
    return defaultFeatures;
  }
}

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function featureSnapshot(feature: LabsFeatureId): boolean {
  return labsAvailable && readFeatures()[feature];
}

export function useLabsFeature(feature: LabsFeatureId): boolean {
  return useSyncExternalStore(
    subscribe,
    () => featureSnapshot(feature),
    () => false,
  );
}

export function setLabsFeature(feature: LabsFeatureId, enabled: boolean): void {
  if (typeof window === "undefined") return;
  const next = { ...readFeatures(), [feature]: enabled };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGE_EVENT));
  notify();
}
