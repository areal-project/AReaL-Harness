---
id: confirm-dialog
title: ConfirmDialog
summary: 不可逆高危操作的阻断确认弹窗，要求明确动词+结果按钮并内置防重复提交态。
status: stable
entry: index
layer: core
category: overlay
aliases: ["确认弹窗", "危险确认", "删除确认"]
related: ["dialog", "button", "callout", "notification-toast"]
exports: ["ConfirmDialog"]
---

# ConfirmDialog 确认弹窗

## 何时使用

`R-CONFIRMDIALOG-001` 仅在不可逆高危操作（如删除未备份数据、移除工作树、覆盖自定义配置）时使用 `ConfirmDialog`。可逆修改应直接执行并用 [NotificationToast](../notification-toast/notification-toast.md) 提供撤销。

## 组成

内部包含 [Dialog](../dialog/dialog.md)、[Button](../button/button.md)、可选 `impact` 提示块（[Callout](../callout/callout.md)），以及 `confirmLabel` 与 `cancelLabel` 动作标签。

## 状态与可访问性

`R-CONFIRMDIALOG-002` `pending` 期间禁用双按钮、隐藏关闭按钮并暴露 `aria-busy="true"`，防止重复提交；`tone` 映射到对应语义 `Button` 变体，键盘与焦点回归继承 Base UI Dialog。**检查：**`clients/gui/packages/ui/src/components/confirm-dialog/confirm-dialog.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-confirm-dialog)直接使用包导出。
