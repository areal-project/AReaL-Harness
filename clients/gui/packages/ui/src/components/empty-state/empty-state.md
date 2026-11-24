---
id: empty-state
title: EmptyState
summary: 居中克制的空状态原语，说明此处承载什么并提供清晰的第一步行动引导。
status: stable
entry: index
layer: core
category: feedback
aliases: ["空状态", "空态", "首次引导"]
related: ["button", "callout", "feedback-notice"]
exports: ["EmptyState"]
---

# EmptyState 空状态

## 何时使用

`R-EMPTYSTATE-001` 首次使用、列表为空或筛选无结果时统一使用 `EmptyState`，不再在页面手写居中空盒或只写孤立的“暂无数据”。需要报错与重试时改用 [FeedbackNotice](../feedback-notice/feedback-notice.md)。

## 组成

包含可选装饰图标、`title`、可选 `description` 与居中 `action` / `secondaryAction` 槽。

## 可访问性

`R-EMPTYSTATE-002` 装饰图标自动带 `aria-hidden="true"`；标题与说明在窄容器与 18px 字号下自然换行且不截断动作按钮。**检查：**`clients/gui/packages/ui/src/components/empty-state/empty-state.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-empty-state)直接使用包导出。
