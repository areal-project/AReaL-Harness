import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ComposerActionButton, ComposerToolbar } from "./composer-toolbar.js";

// R-COMPOSERTOOLBAR-002 / R-COMPOSERTOOLBAR-004 / R-COMPOSERTOOLBAR-005:
// 保留前后动作顺序与真实按钮禁用语义，不自行伪造执行状态。
describe("ComposerToolbar contract (R-COMPOSERTOOLBAR-002, R-COMPOSERTOOLBAR-004, R-COMPOSERTOOLBAR-005)", () => {
  it("preserves leading/trailing order and real disabled button semantics", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerToolbar, {
        leading: createElement("span", null, "Model A"),
        trailing: createElement(ComposerActionButton, {
          disabled: true,
          "aria-label": "Send",
          children: "Send",
        }),
      }),
    );
    expect(html.indexOf("Model A")).toBeLessThan(html.indexOf("Send"));
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain("disabled");
  });
});
