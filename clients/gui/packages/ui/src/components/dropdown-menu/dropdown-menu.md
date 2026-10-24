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

## 行为

维持原Base UI菜单焦点、方向键、Escape与返回；动作权限由宿主判断。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-dropdown-menu)直接使用包导出，生产消费者继续沿原路径。
