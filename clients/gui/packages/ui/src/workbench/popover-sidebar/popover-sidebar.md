---
id: popover-sidebar
title: PopoverSidebar
summary: 折叠侧栏的左缘悬停浮出容器，不挤压主阅读区域。
status: stable
entry: compositions
layer: workbench
category: navigation
aliases: ["浮动侧栏", "PopoverSidebar"]
related: ["workbench-shell", "popover"]
exports: ["PopoverSidebar"]
---

# PopoverSidebar 浮动导航侧栏

## 何时使用

`R-POPOVERSIDEBAR-001` 主侧栏折叠收起后，用本组件提供左缘悬停与键盘聚焦浮出浏览，避免反复展开挤压主阅读区。

## 可访问性

`R-POPOVERSIDEBAR-002` 未展开时暴露 `aria-hidden="true"` 且不截获指针；支持 `Escape` 收起。**检查：**`clients/gui/packages/ui/src/workbench/popover-sidebar/popover-sidebar.test.tsx`

## 示例

[工作台架构](../../../../../renderer/design-system.html?ui-library#component-workbench-shell)配合使用。
