---
id: select
title: Select
summary: 单选菜单，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["单选菜单"]
related: ["button"]
exports: ["Select", "SelectContent", "SelectGroup", "SelectItem", "SelectLabel", "SelectSeparator", "SelectTrigger", "SelectValue", "selectTriggerVariants"]
---

# Select 单选菜单

## 何时使用

从多个候选选择一个值。

## 组成

本合同覆盖同模块导出的整组组件：Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue, selectTriggerVariants。真实API读取生成的TypeScript声明。

## 状态

已选、占位、禁用/禁用项、空列表、长标签。

## 行为

由同一Base UI Root/Trigger/Popup/List/Item维持类型与键盘，定位/层级属于组件，宿主负责选值回执。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-select)直接使用包导出，生产消费者继续沿原路径。
