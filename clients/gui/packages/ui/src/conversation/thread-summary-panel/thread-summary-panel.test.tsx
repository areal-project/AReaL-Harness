import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ThreadSummaryItem, ThreadSummaryPanel } from "./thread-summary-panel.js";

// R-THREADSUMMARY-002 / R-THREADSUMMARY-003:
// 验证展开卡片、紧凑浮条与固定按钮的可访问语义。
describe("ThreadSummaryPanel contract (R-THREADSUMMARY-002, R-THREADSUMMARY-003)", () => {
  it("renders expanded card with items and accessible pin state", () => {
    const html = renderToStaticMarkup(
      createElement(
        ThreadSummaryPanel,
        {
          title: "当前任务摘要",
          summary: "3 个文件变更",
          variant: "card",
          open: true,
          pinned: true,
          onPinnedChange: () => {},
        },
        createElement(ThreadSummaryItem, {
          label: "修改了 tokens.json",
          meta: "+95 / -0",
        }),
      ),
    );
    expect(html).toContain('data-variant="card"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("修改了 tokens.json");
    expect(html).toContain("+95 / -0");
  });

  it("collapses body in compact variant and displays inline summary", () => {
    const html = renderToStaticMarkup(
      createElement(
        ThreadSummaryPanel,
        {
          title: "当前任务摘要",
          summary: "2 项待确认",
          variant: "compact",
          open: true,
        },
        createElement(ThreadSummaryItem, { label: "不应展开" }),
      ),
    );
    expect(html).toContain('data-variant="compact"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("2 项待确认");
    expect(html).not.toContain("不应展开");
  });
});
