---
id: tooltip
title: Tooltip
summary: 辅助提示，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["辅助提示"]
related: ["button"]
exports: ["Tooltip", "TooltipContent", "TooltipProvider", "TooltipTrigger"]
---

# Tooltip 辅助提示

## 何时使用

对已有可见操作补充说明。

## 组成

本合同覆盖同模块导出的整组组件：Tooltip, TooltipContent, TooltipProvider, TooltipTrigger。真实API读取生成的TypeScript声明。

`TooltipContent.anchor` 与 Base UI `Tooltip.Positioner.anchor` 同型，支持 DOM 或虚拟锚点，可用于 Lexical 行内节点；省略时使用 `TooltipTrigger`。

## 状态

延迟、打开、四向定位、触发器聚焦。

## 行为

`R-TOOLTIP-001` 不作为唯一按钮名称，不在提示中放必须完成的业务动作。浮层使用 `tooltip` 角色；DOM 宿主用 `aria-describedby` 关联触发节点与提示。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-003](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-tooltip)直接使用包导出，生产消费者继续沿原路径。
