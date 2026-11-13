---
id: card
title: Card
summary: 内容卡，沿用现有生产实现与交互。
status: experimental
entry: experimental
layer: core
category: control
aliases: ["内容卡"]
related: ["button"]
exports: ["Card", "CardHeader", "CardFooter", "CardTitle", "CardAction", "CardDescription", "CardContent"]
---

# Card 内容卡

## 何时使用

沿现有Card结构组合标题、说明、正文、动作和页脚。

## 组成

本合同覆盖同模块导出的整组组件：Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent。真实API读取生成的TypeScript声明。

## 状态

有/无标题、有/无动作、内容增长。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-004](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-card)直接使用包导出，生产消费者继续沿原路径。
