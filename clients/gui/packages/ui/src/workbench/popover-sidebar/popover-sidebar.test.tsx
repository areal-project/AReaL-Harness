import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PopoverSidebar } from "./popover-sidebar.js";

// R-POPOVERSIDEBAR-002: 折叠态渲染浮层容器并正确暴露 aria-hidden 与 data-open。
describe("PopoverSidebar contract (R-POPOVERSIDEBAR-002)", () => {
  it("renders floating panel states when collapsed and passes through when expanded", () => {
    const closed = renderToStaticMarkup(
      createElement(PopoverSidebar, { collapsed: true, open: false }, "侧栏内容"),
    );
    expect(closed).toContain('data-popover="true"');
    expect(closed).toContain('aria-hidden="true"');

    const opened = renderToStaticMarkup(
      createElement(PopoverSidebar, { collapsed: true, open: true }, "侧栏内容"),
    );
    expect(opened).toContain('data-open="true"');
    expect(opened).toContain('aria-hidden="false"');
  });
});
