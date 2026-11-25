---
id: badge
title: Badge
summary: 通用语义状态徽标，用于紧凑计数、状态标记与来源标签。
status: stable
entry: index
layer: core
category: display
aliases: ["徽标", "状态标签", "Tag"]
related: ["button", "tooltip"]
exports: ["Badge"]
---

# Badge 语义徽标

## 何时使用

`R-BADGE-001` 需要以紧凑胶囊呈现状态、计数或分类标签时使用 `Badge`，不手写私有标签类。

## 组成

支持 `tone`（`neutral | info | success | warning | danger`）、`size`（`sm | md`）与可选行首 `icon`。

## 状态

`R-BADGE-002` 状态色必须伴随可读文字或图标，不单靠颜色传递语义。**检查：**`clients/gui/packages/ui/src/components/badge/badge.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-badge)直接使用包导出。
