import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Callout } from "./callout.js";

// R-CALLOUT-002: 验证 danger 暴露 alert 语义、info 暴露 note 语义且完整渲染标题与正文。
describe("Callout contract (R-CALLOUT-002)", () => {
  it("exposes appropriate ARIA roles for danger and info tones", () => {
    const info = renderToStaticMarkup(
      createElement(Callout, { tone: "info", title: "说明" }, "自定义模板将被覆盖"),
    );
    const danger = renderToStaticMarkup(
      createElement(Callout, { tone: "danger" }, "该操作不可撤销"),
    );
    expect(info).toContain('role="note"');
    expect(info).toContain("自定义模板将被覆盖");
    expect(danger).toContain('role="alert"');
    expect(danger).toContain("该操作不可撤销");
  });
});
