import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Button } from "../button/button.js";
import { EmptyState } from "./empty-state.js";

// R-EMPTYSTATE-002: 验证装饰图标隐藏于读屏器、标题/说明/动作槽与 compact 密度完整渲染。
describe("EmptyState contract (R-EMPTYSTATE-002)", () => {
  it("renders title, description, aria-hidden icon and primary action", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "还没有定时任务",
        description: "创建一个按计划自动运行的任务，只需 10 秒。",
        icon: createElement("span", null, "icon"),
        action: createElement(Button, null, "新建定时任务"),
      }),
    );
    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain('data-size="default"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("还没有定时任务");
    expect(html).toContain("新建定时任务");
  });

  it("supports compact density for inline cards and panels", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        size: "compact",
        title: "没有匹配的设置项",
        action: createElement(Button, { variant: "outline" }, "清除筛选"),
      }),
    );
    expect(html).toContain('data-size="compact"');
    expect(html).toContain("清除筛选");
  });
});
