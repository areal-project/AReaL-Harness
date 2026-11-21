import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Kbd } from "./kbd.js";

// R-KBD-002: 快捷键提示默认 aria-hidden，区分 primary/secondary/keycap 变体。
describe("Kbd contract (R-KBD-002)", () => {
  it("renders accessible decorative kbd variants", () => {
    const primary = renderToStaticMarkup(createElement(Kbd, { variant: "primary" }, "↵"));
    const keycap = renderToStaticMarkup(createElement(Kbd, { variant: "keycap" }, "⌘K"));
    expect(primary).toContain('data-variant="primary"');
    expect(primary).toContain('aria-hidden="true"');
    expect(keycap).toContain('data-variant="keycap"');
    expect(keycap).toContain("⌘K");
  });
});
