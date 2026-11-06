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

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-select)直接使用包导出，生产消费者继续沿原路径。
