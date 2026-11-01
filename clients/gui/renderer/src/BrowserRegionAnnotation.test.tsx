import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  BrowserRegionAnnotation,
  annotationRegionAroundPoint,
  type RegionDraft,
} from "./BrowserRegionAnnotation.js";
import { browserMessages } from "./i18n/messages/browser.js";

vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({
    t: (id: keyof typeof browserMessages) => browserMessages[id]["zh-CN"],
  }),
}));

const capture: RegionDraft["capture"] = {
  captureId: "capture",
  projectId: "project",
  threadId: "thread",
  pageId: "page",
  coreInstanceId: "core",
  pageGeneration: 1,
  documentEpoch: 1,
  controlEpoch: 1,
  viewportRevision: 1,
  capturedAt: "2026-10-31T00:00:00Z",
  url: "https://example.test/",
  imageBase64: "frozen-image",
  viewport: {
    width: 800,
    height: 600,
    scrollX: 0,
    scrollY: 0,
    pageZoom: 1,
    guiZoom: 1,
    deviceScaleFactor: 2,
    nativeBounds: { x: 0, y: 0, width: 800, height: 600 },
    bitmapWidth: 1600,
    bitmapHeight: 1200,
  },
};

describe("annotation region near an unresolved element", () => {
  it("uses a 160 by 96 CSS pixel crop with the capture bitmap ratios", () => {
    expect(annotationRegionAroundPoint(capture, { x: 800, y: 600 })).toEqual({
      x: 640,
      y: 504,
      width: 320,
      height: 192,
    });
  });

  it("uses explicit independent bitmap scales rather than the device DPR", () => {
    const scaled = {
      ...capture,
      viewport: { ...capture.viewport, bitmapScale: { x: 1.25, y: 1.5 } },
    };
    expect(annotationRegionAroundPoint(scaled, { x: 800, y: 600 })).toEqual({
      x: 700,
      y: 528,
      width: 200,
      height: 144,
    });
  });

  it.each([
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    [
      { x: 1599, y: 0 },
      { x: 1280, y: 0 },
    ],
    [
      { x: 0, y: 1199 },
      { x: 0, y: 1008 },
    ],
    [
      { x: 2000, y: 2000 },
      { x: 1280, y: 1008 },
    ],
    [
      { x: -20, y: -30 },
      { x: 0, y: 0 },
    ],
  ])("keeps the entire crop inside the bitmap at %j", (point, origin) => {
    expect(annotationRegionAroundPoint(capture, point)).toEqual({
      ...origin,
      width: 320,
      height: 192,
    });
  });

  it("keeps a nonempty crop on a one pixel bitmap", () => {
    const tiny = {
      ...capture,
      viewport: { ...capture.viewport, bitmapWidth: 1, bitmapHeight: 1 },
    };
    expect(annotationRegionAroundPoint(tiny, { x: 0, y: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it.each(["页面在截图后发生变化，请重新截图后点选元素", "此位置没有可验证的 DOM 元素身份"])(
    "shows an editable region immediately after %s",
    (unavailableReason) => {
      const point = { x: 800, y: 600 };
      const draft: RegionDraft = {
        capture,
        point,
        region: annotationRegionAroundPoint(capture, point),
        comment: "请调整这里的间距",
        mode: "element",
        unavailableReason,
      };
      const markup = renderToStaticMarkup(
        createElement(BrowserRegionAnnotation, {
          draft,
          busy: false,
          notes: [],
          nextNumber: 1,
          onChange: vi.fn(),
          onCancel: vi.fn(),
          onStage: vi.fn(),
          onSelectElement: vi.fn(),
        }),
      );
      expect(markup).toContain('role="dialog" aria-label="编辑当前标注"');
      expect(markup).toContain("请调整这里的间距");
      expect(markup).toMatch(/aria-label="加入聊天草稿"[^>]*>/);
      expect(markup).not.toMatch(/aria-label="加入聊天草稿"[^>]*disabled/);
      expect(markup).toContain(browserMessages["browser.annotation.regionFallback"]["zh-CN"]);
      expect(markup).not.toContain(unavailableReason);
      expect(markup).toMatch(/aria-label="点选元素" aria-pressed="true"/);
    },
  );
});
