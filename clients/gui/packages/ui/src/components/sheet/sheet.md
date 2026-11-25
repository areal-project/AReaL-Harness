---
id: sheet
title: Sheet
summary: 保留主任务上下文的边缘抽屉容器，支持右侧、左侧与底部滑出。
status: stable
entry: index
layer: core
category: overlay
aliases: ["抽屉", "侧边抽屉", "Drawer"]
related: ["dialog", "side-pane-frame", "button"]
exports: ["Sheet", "SheetBody", "SheetClose", "SheetContent", "SheetDescription", "SheetFooter", "SheetHeader", "SheetTitle", "SheetTrigger"]
---

# Sheet 抽屉

## 何时使用

`R-SHEET-001` 需要编辑详情、筛选配置或临时查阅资料同时保留主画面感知时使用 `Sheet`；常驻分栏使用 [SidePaneFrame](../../workbench/side-pane-frame/side-pane-frame.md)，强阻断短任务使用 [Dialog](../dialog/dialog.md)。

## 组成

`Sheet`、`SheetTrigger`、`SheetContent`（`side="right" | "left" | "bottom"`，`size="sm" | "md" | "lg"`）、`SheetHeader`、`SheetTitle`、`SheetDescription`、`SheetBody`、`SheetFooter`、`SheetClose`。

## 可访问性

`R-SHEET-002` 基于 `@base-ui/react/dialog`，保留键盘焦点、Esc 关闭、关闭后归还触发器焦点与 Electron 标题栏 `app-region: no-drag`；动画时长走 `--motion-normal` 且自动响应 reduced motion。**检查：**`clients/gui/packages/ui/src/components/sheet/sheet.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-sheet)直接使用包导出。
