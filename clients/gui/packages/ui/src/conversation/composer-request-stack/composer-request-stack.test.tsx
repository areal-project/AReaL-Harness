import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ComposerRequestStack } from "./composer-request-stack.js";

// R-COMPOSERREQUESTSTACK-002: 多请求显示 1/N 导航并在首尾禁用按钮，单请求隐藏导航栏。
describe("ComposerRequestStack contract (R-COMPOSERREQUESTSTACK-002)", () => {
  it("renders pagination controls when multiple requests exist and hides them for a single item", () => {
    const multi = renderToStaticMarkup(
      createElement(
        ComposerRequestStack,
        { index: 0, total: 3, onIndexChange: () => {} },
        "审批卡",
      ),
    );
    expect(multi).toContain("1 / 3");
    expect(multi).toContain('aria-label="上一项请求"');
    expect(multi).toContain("disabled");

    const single = renderToStaticMarkup(
      createElement(
        ComposerRequestStack,
        { index: 0, total: 1, onIndexChange: () => {} },
        "单条审批卡",
      ),
    );
    expect(single).not.toContain('data-slot="composer-request-navigation"');
  });
});
