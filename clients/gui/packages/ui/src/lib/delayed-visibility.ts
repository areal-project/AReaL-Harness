import { useEffect, useState } from "react";

const SHOW_DELAY_MS = 400;
const MIN_VISIBLE_MS = 400;

/**
 * 加载状态只有持续一会儿才显示，显示后至少停留一会儿，快请求不会闪一下。
 * deadline 在等待显示时是显示时刻，显示后是最早可隐藏时刻。
 */
export interface DelayedVisibility {
  readonly shown: boolean;
  readonly deadline: number | null;
}

export const hiddenVisibility: DelayedVisibility = { shown: false, deadline: null };

/** 没有变化时返回原对象，可以在每次渲染时调用。 */
export function stepDelayedVisibility(
  state: DelayedVisibility,
  active: boolean,
  now: number,
): DelayedVisibility {
  if (!state.shown) {
    if (!active) return state.deadline === null ? state : hiddenVisibility;
    if (state.deadline === null) return { shown: false, deadline: now + SHOW_DELAY_MS };
    return now >= state.deadline ? { shown: true, deadline: now + MIN_VISIBLE_MS } : state;
  }
  if (active || state.deadline === null || now < state.deadline) return state;
  return hiddenVisibility;
}

function pendingDeadline(state: DelayedVisibility, active: boolean) {
  if (state.deadline === null) return null;
  return state.shown === active ? null : state.deadline;
}

export function useDelayedVisible(active: boolean): boolean {
  const [state, setState] = useState(hiddenVisibility);
  const next = stepDelayedVisibility(state, active, Date.now());
  if (next !== state) setState(next);
  const wakeAt = pendingDeadline(next, active);
  useEffect(() => {
    if (wakeAt === null) return;
    const timer = setTimeout(
      () => setState((current) => ({ ...current })),
      Math.max(0, wakeAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [wakeAt]);
  return next.shown;
}
