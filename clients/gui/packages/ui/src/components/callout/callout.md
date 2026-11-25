---
id: callout
title: Callout
summary: 轻量内联提示块，用于表单说明、审批原因与操作影响提醒。
status: stable
entry: index
layer: core
category: feedback
aliases: ["提示块", "内联提醒", "Banner"]
related: ["feedback-notice", "button"]
exports: ["Callout"]
---

# Callout 内联提示块

## 何时使用

`R-CALLOUT-001` 在设置分组、审批原因或弹窗内说明操作影响时使用 `Callout`；系统级错误恢复仍使用 [FeedbackNotice](../feedback-notice/feedback-notice.md)。

## 组成

语义图标、`title`（可选）、说明正文与右侧可选 `actions` 槽；尺寸与圆角全部来自 Token。

## 可访问性

`R-CALLOUT-002` `tone="danger"` 暴露 `role="alert"`，其余语义暴露 `role="note"`，文字在可用宽度内完整换行。**检查：**`clients/gui/packages/ui/src/components/callout/callout.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-callout)直接使用包导出。
