---
id: action-button
title: ActionButton
summary: 紧凑操作，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["紧凑操作"]
related: ["button"]
exports: ["ActionButton"]
---

# ActionButton 紧凑操作

## 何时使用

设置与列表中的有名称动作。

## 组成

本合同覆盖同模块导出的整组组件：ActionButton。真实API读取生成的TypeScript声明。

## 行为

`R-ACTIONBUTTON-002` pending时保留文字、显示转动图标并禁止重复点击，不推断操作已完成。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-action-button)直接使用包导出，生产消费者继续沿原路径。
