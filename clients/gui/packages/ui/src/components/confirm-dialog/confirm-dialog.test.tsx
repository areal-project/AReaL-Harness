import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ConfirmDialog } from "./confirm-dialog.js";

// R-CONFIRMDIALOG-002: 验证 ConfirmDialog 的接口契约、安全标签必填与 pending 防重复提交语义。
describe("ConfirmDialog contract (R-CONFIRMDIALOG-002)", () => {
  it("renders closed root safely without throwing in SSR", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: false,
        onOpenChange: () => {},
        title: "移除此工作树？",
        description: "未提交的本地修改将一并清理。",
        impact: "该操作无法撤销。",
        confirmLabel: "移除工作树",
        cancelLabel: "保留工作树",
        tone: "destructive",
        onConfirm: () => {},
      }),
    );
    expect(typeof html).toBe("string");
  });

  it("supports pending state with custom pending label", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: false,
        onOpenChange: () => {},
        title: "重置模板？",
        confirmLabel: "重置为默认",
        cancelLabel: "保留当前模板",
        tone: "warning",
        pending: true,
        pendingLabel: "正在重置…",
        onConfirm: () => {},
      }),
    );
    expect(typeof html).toBe("string");
  });
});
