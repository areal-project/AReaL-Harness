import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorkedForDivider } from "./worked-for-divider.js";

// R-WORKEDFOR-002: 暴露 separator 语义与可读耗时文案。
describe("WorkedForDivider contract (R-WORKEDFOR-002)", () => {
  it("renders separator role with elapsed duration and optional meta", () => {
    const html = renderToStaticMarkup(
      createElement(WorkedForDivider, { label: "已运行 1 分 24 秒", meta: "4 项活动" }),
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain("已运行 1 分 24 秒");
    expect(html).toContain("4 项活动");
  });
});
