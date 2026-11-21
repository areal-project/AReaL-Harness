import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ShortcutCapture } from "./shortcut-capture.js";

// R-SHORTCUTCAPTURE-002: 暴露原生按钮 aria-label、aria-pressed 与 Kbd 键帽渲染。
describe("ShortcutCapture contract (R-SHORTCUTCAPTURE-002)", () => {
  it("renders keycap value and reset action with accessible labels", () => {
    const html = renderToStaticMarkup(
      createElement(ShortcutCapture, {
        label: "切换置顶摘要",
        value: "⌘+⇧+S",
        onChange: () => {},
        onReset: () => {},
      }),
    );
    expect(html).toContain('aria-label="切换置顶摘要"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("⌘+⇧+S");
    expect(html).toContain('aria-label="恢复默认快捷键"');
  });
});
