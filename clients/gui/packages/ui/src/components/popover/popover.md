---
id: popover
title: Popover
summary: 轻量浮层，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["轻量浮层"]
related: ["button"]
exports: ["Popover", "PopoverContent", "PopoverDescription", "PopoverHeader", "PopoverTitle", "PopoverTrigger"]
---

# Popover 轻量浮层

## 何时使用

上下文配置、非模态轻量详情。

## 组成

本合同覆盖同模块导出的整组组件：Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger。真实API读取生成的TypeScript声明。

## 状态

关闭/打开、定位碰撞、受控、keepMounted。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-popover)直接使用包导出，生产消费者继续沿原路径。
