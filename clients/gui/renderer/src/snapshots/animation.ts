import type { SnapShotServices, SnapShotSource } from "@areal/workbench/desktop-contract/snapshots";
import { useSyncExternalStore } from "react";
let bridge: SnapShotServices | undefined;
const pending = new Map<
  string,
  { promise: Promise<void>; finish: () => void; timer: ReturnType<typeof setTimeout> }
>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
export function configureSnapShotAnimations(value: SnapShotServices | undefined) {
  bridge = value;
}
export function finishSnapShotAnimation(id: string) {
  const animation = pending.get(id);
  if (!animation) return;
  clearTimeout(animation.timer);
  pending.delete(id);
  notify();
  animation.finish();
}
export function beginSnapShotAnimation(id: string) {
  if (pending.has(id)) return;
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const timer = setTimeout(() => {
    finishSnapShotAnimation(id);
    void bridge?.dismissSnapShotAnimation(id).catch(() => {});
  }, 2000);
  pending.set(id, { promise, finish, timer });
  notify();
}
export function waitForSnapShotAnimation(id: string) {
  return pending.get(id)?.promise ?? Promise.resolve();
}
export function useSnapShotAnimation(id: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => !!id && pending.has(id),
  );
}
export async function landSnapShotAnimation(
  id: string,
  element: HTMLElement,
  source: SnapShotSource,
) {
  if (!pending.has(id) || !bridge || !element.isConnected) return;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const style = getComputedStyle(element);
  try {
    await bridge.setSnapShotAnimationDestination({
      id,
      viewportFrame: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderWidth: parseFloat(style.borderTopWidth) || 0,
      cornerRadius: parseFloat(style.borderTopLeftRadius) || 0,
      details: {
        appName: source.appName,
        windowTitle: source.windowTitle,
        ...(source.appIconDataUrl ? { appIconDataUrl: source.appIconDataUrl } : {}),
      },
    });
  } finally {
    finishSnapShotAnimation(id);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }
}
export function dismissSnapShotAnimations() {
  for (const id of pending.keys()) {
    finishSnapShotAnimation(id);
    void bridge?.dismissSnapShotAnimation(id).catch(() => {});
  }
}
