import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Badge } from "./badge.js";

// R-BADGE-002: 徽标支持语义 tone 与紧凑尺寸，始终渲染可读文案。
describe("Badge contract (R-BADGE-002)", () => {
  it("renders semantic tones and sizes with readable text", () => {
    const html = renderToStaticMarkup(
      createElement(Badge, { tone: "warning", size: "md" }, "2 项待确认"),
    );
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('data-size="md"');
    expect(html).toContain("2 项待确认");
  });
});
