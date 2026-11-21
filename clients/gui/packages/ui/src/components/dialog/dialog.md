---
id: dialog
title: Dialog
summary: 模态对话框，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["模态对话框"]
related: ["button"]
exports: ["Dialog", "DialogClose", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogOverlay", "DialogPortal", "DialogTitle", "DialogTrigger"]
---

# Dialog 模态对话框

## 何时使用

`R-DIALOG-001` 需要专注填写或确认的内容。

## 组成

本合同覆盖同模块导出的整组组件：Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger。真实API读取生成的TypeScript声明。

## 状态

打开、关闭、无关闭按钮、无遮罩、受控。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

`R-DIALOG-002` 模态遮罩与内容容器只引用 Token，宿主不覆盖 `[data-slot="dialog-overlay"]` 与 `[data-slot="dialog-content"]` 内部样式。**为什么：**保证所有模态确认与编辑弹窗在窗口拖拽区、圆角层级与遮罩过渡上行为一致。**推广：**需要变体尺寸或定位时通过 DialogContent props 声明。**检查：**`clients/gui/design-system/verified-components.json`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-dialog)直接使用包导出，生产消费者继续沿原路径。
