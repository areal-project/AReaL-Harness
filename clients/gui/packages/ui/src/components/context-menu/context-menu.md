---
id: context-menu
title: ContextMenu
summary: 上下文菜单，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["上下文菜单"]
related: ["button"]
exports: ["ContextMenu", "ContextMenuContent", "ContextMenuItem", "ContextMenuSeparator", "ContextMenuSub", "ContextMenuSubContent", "ContextMenuSubTrigger", "ContextMenuTrigger"]
---

# ContextMenu 上下文菜单

## 何时使用

对象上的快捷操作。

## 组成

本合同覆盖同模块导出的整组组件：ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger。真实API读取生成的TypeScript声明。

## 状态

打开、禁用、子菜单。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-context-menu)直接使用包导出，生产消费者继续沿原路径。
