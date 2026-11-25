import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { DecisionCard } from "./decision-card.js";

describe("DecisionCard contract (R-DECISIONCARD-003)", () => {
  it("keeps full request details collapsed by default and places footer outside scrollable body", () => {
    const html = renderToStaticMarkup(
      <DecisionCard
        kind="approval"
        label="权限确认"
        regionLabel="等待权限确认"
        icon={<span aria-hidden="true">!</span>}
        details={<pre>full command args</pre>}
        footer={<button type="button">允许一次</button>}
      >
        <p>摘要原因</p>
      </DecisionCard>,
    );

    expect(html).toContain('aria-label="等待权限确认"');
    expect(html).toContain("查看完整请求");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("full command args");
    expect(html.indexOf("decision-card-body")).toBeLessThan(html.indexOf("decision-card-footer"));
    expect(html).toContain("</footer></section>");
  });
});
