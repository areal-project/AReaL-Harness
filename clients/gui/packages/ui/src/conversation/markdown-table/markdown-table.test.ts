import { describe, expect, it } from "vite-plus/test";
import {
  resolveMarkdownTableVirtualScrollbarMetrics,
  resolveMarkdownTableVirtualScrollMax,
} from "./table-layout.js";

// R-MARKDOWNTABLE-001: 横向滚动属于表格内部，虚拟滑块裁切在轨道内，不撑宽页面。
describe("MarkdownTable virtual scrollbar containment (R-MARKDOWNTABLE-001)", () => {
  it("clamps thumb width and position inside track width when table overflows", () => {
    const scrollMax = resolveMarkdownTableVirtualScrollMax({ tableWidth: 1200, trackWidth: 400 });
    expect(scrollMax).toBe(800);
    const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: 9999,
      scrollMax,
      tableWidth: 1200,
      trackWidth: 400,
    });
    expect(metrics.thumbWidth).toBeLessThanOrEqual(400);
    expect(metrics.thumbLeft + metrics.thumbWidth).toBeLessThanOrEqual(400.001);
  });

  it("reports zero overflow and full-track thumb when table fits container", () => {
    expect(resolveMarkdownTableVirtualScrollMax({ tableWidth: 320, trackWidth: 400 })).toBe(0);
    const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: 0,
      scrollMax: 0,
      tableWidth: 320,
      trackWidth: 400,
    });
    expect(metrics.thumbLeft).toBe(0);
    expect(metrics.thumbWidth).toBe(400);
  });
});
