---
id: dropdown-menu
title: DropdownMenu
summary: 操作菜单，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["操作菜单"]
related: ["button"]
exports: ["DropdownMenu", "DropdownMenuPortal", "DropdownMenuTrigger", "DropdownMenuContent", "DropdownMenuGroup", "DropdownMenuLabel", "DropdownMenuItem", "DropdownMenuCheckboxItem", "DropdownMenuRadioGroup", "DropdownMenuRadioItem", "DropdownMenuSeparator", "DropdownMenuShortcut", "DropdownMenuSub", "DropdownMenuSubTrigger", "DropdownMenuSubContent"]
---

# DropdownMenu 操作菜单

## 何时使用

按钮触发的分组操作、单选/多选及子菜单。

## 组成

本合同覆盖同模块导出的整组组件：DropdownMenu, DropdownMenuPortal, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent。真实API读取生成的TypeScript声明。

## 状态

打开、禁用项、checkbox/radio、sub菜单。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-dropdown-menu)直接使用包导出，生产消费者继续沿原路径。
