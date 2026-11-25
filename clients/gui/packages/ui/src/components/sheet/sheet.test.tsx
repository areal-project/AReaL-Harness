import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Button } from "../button/button.js";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet.js";

// R-SHEET-002: 验证 Sheet 触发器与结构子部件基于 Base UI Dialog 正常渲染且保留 data-slot 语义。
describe("Sheet contract (R-SHEET-002)", () => {
  it("renders trigger and subparts without throwing", () => {
    const html = renderToStaticMarkup(
      createElement(
        Sheet,
        { open: false },
        createElement(
          SheetTrigger,
          { render: createElement(Button, { variant: "outline" }) },
          "打开抽屉",
        ),
        createElement(
          SheetContent,
          { side: "right", size: "md" },
          createElement(
            SheetHeader,
            null,
            createElement(SheetTitle, null, "详情编辑"),
            createElement(SheetDescription, null, "保留主工作区上下文。"),
          ),
          createElement(SheetBody, null, "正文内容"),
          createElement(SheetFooter, null, createElement(Button, null, "保存修改")),
        ),
      ),
    );
    expect(html).toContain('data-slot="sheet-trigger"');
    expect(html).toContain("打开抽屉");
  });
});
