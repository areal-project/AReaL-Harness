---
id: hover-actions
title: HoverActions
summary: 行内悬停出现的操作区；弹出层打开期间锚点不移位、不消失。
status: stable
entry: index
layer: core
category: control
aliases: ["悬停操作区", "行操作"]
related: ["dropdown-menu", "button"]
exports: ["HoverActions"]
---

# HoverActions 悬停操作区

## 何时使用

`R-HOVERACTIONS-001` 行内只在悬停或键盘聚焦时出现的按钮（“更多”、置顶、新建等）必须放在 HoverActions 里，不在宿主 CSS 里手写显隐。 **检查：**`clients/gui/scripts/popup-anchor-lint.mjs`。

## 组成

本合同覆盖同模块导出的整组组件：HoverActions。它渲染一个 `span[data-slot="hover-actions"]`，放在行元素的直接子级，行就是悬停范围。

## 状态

`R-HOVERACTIONS-002` 隐藏只用 `opacity` 和 `pointer-events`，操作区始终占据同一位置；宿主若要让出标题空间，只改标题的 padding，不改操作区的 width、display 或 position。 **检查：**`clients/gui/scripts/popup-anchor-lint.mjs`。

## 行为

`R-HOVERACTIONS-003` 行被悬停、行内有键盘焦点，或行内有触发器带 `data-popup-open`（Base UI 的打开态）时显示。弹出层打开期间鼠标移出行，操作区保持可见，锚点不移位。不要用 Radix 的 `data-state="open"`，Base UI 不输出它。 **检查：**`clients/gui/scripts/design-system-popup-anchors.mjs`。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。触屏（`hover: none`）下始终显示。

## 规则

引用 [R-UI-COMMON-004](../../../README.md#共同合同)。`clients/gui/scripts/popup-anchor-lint.mjs` 拦截失效的 `data-state` 选择器和悬停时改布局的规则。

## 示例

项目行与任务行的操作区（`renderer/src/views/ConversationNavigation.tsx`、`src/workbench/task-list-item/task-list-item.tsx`）。
