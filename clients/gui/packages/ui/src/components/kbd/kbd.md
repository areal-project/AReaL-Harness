---
id: kbd
title: Kbd
summary: 统一的快捷键提示原语，区分主按钮内、次按钮内与独立键帽三种变体。
status: stable
entry: index
layer: core
category: control
aliases: ["快捷键", "键帽", "Shortcut"]
related: ["button", "tooltip"]
exports: ["Kbd"]
---

# Kbd 快捷键提示

## 何时使用

`R-KBD-001` 在按钮、菜单项、Tooltip 或快捷键说明中呈现按键提示，禁止在页面内手写带硬编码底色的 `<kbd>` 样式。

## 组成

提供 `secondary`、`primary` 与 `keycap` 三种变体。

## 可访问性

`R-KBD-002` 装饰性快捷键提示默认 `aria-hidden="true"`，由宿主按钮的可访问名称或说明承担语义。**检查：**`clients/gui/packages/ui/src/components/kbd/kbd.test.tsx`

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-kbd)直接使用包导出。
