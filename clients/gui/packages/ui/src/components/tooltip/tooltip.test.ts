import { describe, expect, it, vi } from "vite-plus/test";
import { createHoverTooltipTracker } from "./tooltip.js";

function scrollTarget() {
  const listeners = new Set<() => void>();
  return {
    target: {
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as Document,
    scroll: () => {
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
}

describe("hover tooltip scroll dismissal", () => {
  it("closes hover-opened tooltips on scroll and stops listening once none are open", () => {
    const page = scrollTarget();
    const tracker = createHoverTooltipTracker(() => page.target);
    const first = vi.fn();
    const second = vi.fn();
    tracker.opened(first);
    tracker.opened(second);
    expect(page.listening()).toBe(1);

    page.scroll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(page.listening()).toBe(0);
  });

  it("leaves a tooltip alone after it closed on its own", () => {
    const page = scrollTarget();
    const tracker = createHoverTooltipTracker(() => page.target);
    const close = vi.fn();
    tracker.opened(close);
    tracker.closed(close);
    expect(page.listening()).toBe(0);

    page.scroll();
    expect(close).not.toHaveBeenCalled();
  });
});
