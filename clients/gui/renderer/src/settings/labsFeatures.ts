import { useSyncExternalStore } from "react";

export type LabsFeatureId = "bots";

const STORAGE_KEY = "areal.gui.labs.v1";
const CHANGE_EVENT = "areal-labs-changed";

/** 独立的 Labs 实验配置入口始终可见，具体实验功能默认关闭、按需逐项开启。 */
export const labsAvailable = true;

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
