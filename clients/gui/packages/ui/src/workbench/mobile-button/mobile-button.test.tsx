import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MobileButton } from "./mobile-button.js";

describe("MobileButton contract (R-MOBILEBUTTON-001, R-MOBILEBUTTON-002)", () => {
  it("keeps the touch-target minimum for every kind and forwards variant, disabled and data attributes", () => {
    const kinds = [
      "touch",
      "icon",
      "inline",
      "chip",
      "primary",
      "stop",
      "sheet-cancel",
      "sheet-done",
      "summary",
      "setting-row",
      "project-card",
      "work-row",
    ] as const;
    for (const kind of kinds) {
      const html = renderToStaticMarkup(
        <MobileButton kind={kind} variant="ghost" disabled data-action="probe">
          label
        </MobileButton>,
      );
      expect(html, kind).toMatch(/min-h-\(--size-touch-target\)|size-\(--size-touch-target\)/);
      expect(html, kind).toContain('data-variant="ghost"');
      expect(html, kind).toContain('data-action="probe"');
      expect(html, kind).toContain("disabled");
    }
    const stop = renderToStaticMarkup(<MobileButton kind="stop" className="justify-self-end" />);
    expect(stop).toContain("composer-stop-action");
    expect(stop).toContain("justify-self-end");
    // 字号与内边距由 kind 拥有，页面只追加布局类。
    const inline = renderToStaticMarkup(<MobileButton kind="inline" className="max-w-full" />);
    expect(inline).toContain("px-0");
    expect(inline).toContain("text-fixed-control");
  });
});
