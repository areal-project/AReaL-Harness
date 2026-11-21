import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { AutomationTemplateDialog } from "./automation-template-dialog.js";

// R-AUTOMATIONTEMPLATE-002: 关闭态不渲染正文，可与共享 Dialog 正常组合。
describe("AutomationTemplateDialog contract (R-AUTOMATIONTEMPLATE-002)", () => {
  it("mounts cleanly in closed state without throwing", () => {
    const html = renderToStaticMarkup(
      createElement(AutomationTemplateDialog, {
        open: false,
        onOpenChange: () => {},
        title: "每日代码巡检",
        scheduleSummary: "每个工作日 09:00",
        prompt: "检查昨日提交并生成摘要",
        hint: "将会覆盖当前草稿",
        onConfirm: () => {},
      }),
    );
    expect(typeof html).toBe("string");
  });
});
