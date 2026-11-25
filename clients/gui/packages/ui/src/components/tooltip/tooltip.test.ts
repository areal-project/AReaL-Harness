import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TitleTooltip, createHoverTooltipTracker } from "./tooltip.js";

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

// R-TOOLTIP-001: 提示只补充说明，不替代按钮可见/可访问名称，并保留 aria-description 关联。
describe("TitleTooltip semantics (R-TOOLTIP-001)", () => {
  it("attaches aria-description without clobbering aria-label and returns child unchanged when empty", () => {
    const withTitle = renderToStaticMarkup(
      createElement(TitleTooltip, {
        title: "More details",
        children: createElement("button", { type: "button", "aria-label": "Refresh" }, "Refresh"),
      }),
    );
    expect(withTitle).toContain('aria-label="Refresh"');
    expect(withTitle).toContain('aria-description="More details"');

    const empty = renderToStaticMarkup(
      createElement(TitleTooltip, {
        title: "",
        children: createElement("button", { type: "button", "aria-label": undefined }, "Plain"),
      }),
    );
    expect(empty).toContain(">Plain<");
    expect(empty).not.toContain("aria-description");
  });
});
