import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CollapsibleText } from "./collapsible-text.js";

// R-COLLAPSIBLETEXT-002 / R-COLLAPSIBLETEXT-005:
// 保留原始正文节点，未超出预览高度时不出现无效展开按钮，不擅自修改宿主内容。
describe("CollapsibleText contract (R-COLLAPSIBLETEXT-002, R-COLLAPSIBLETEXT-005)", () => {
  it("keeps full content intact without rendering an idle toggle when not expandable", () => {
    const html = renderToStaticMarkup(
      createElement(CollapsibleText, {
        children: createElement("p", null, "Short intact message"),
      }),
    );
    expect(html).toContain("Short intact message");
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('data-expandable="false"');
    expect(html).not.toContain("collapsible-text-toggle");
  });
});
