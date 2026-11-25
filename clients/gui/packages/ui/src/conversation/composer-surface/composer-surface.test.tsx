import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ComposerSurface } from "./composer-surface.js";

describe("ComposerSurface contract (R-COMPOSERSURFACE-002, R-COMPOSERSURFACE-004, R-COMPOSERSURFACE-005, R-COMPOSERSURFACE-006, R-LAYOUT-013)", () => {
  it("renders default, compact, and dragging states while preserving host editor, context, overlay, and toolbar slots", () => {
    const defaultHtml = renderToStaticMarkup(
      <ComposerSurface
        editor={<textarea aria-label="输入消息" defaultValue="草稿内容" />}
        toolbar={<button type="button">发送</button>}
        context={<div>附件上下文</div>}
      />,
    );
    expect(defaultHtml).toContain('data-layout="default"');
    expect(defaultHtml).not.toContain("data-dragging");
    expect(defaultHtml).toContain("附件上下文");
    expect(defaultHtml).toContain("草稿内容");
    expect(defaultHtml.indexOf("输入消息")).toBeLessThan(defaultHtml.indexOf("发送"));

    const compactHtml = renderToStaticMarkup(
      <ComposerSurface
        layout="compact"
        dragging
        overlay={<div>松开以添加</div>}
        editor={<textarea aria-label="输入消息" defaultValue="草稿内容" />}
        toolbar={<button type="button">发送</button>}
      />,
    );
    expect(compactHtml).toContain('data-layout="compact"');
    expect(compactHtml).toContain('data-dragging="true"');
    expect(compactHtml).toContain("松开以添加");
  });
});
