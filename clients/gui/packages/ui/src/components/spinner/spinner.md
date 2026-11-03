---
id: spinner
title: Spinner
summary: 加载标识，沿用现有生产实现与交互。
status: experimental
entry: experimental
layer: core
category: control
aliases: ["加载标识"]
related: ["button"]
exports: ["Spinner"]
---

# Spinner 加载标识

## 何时使用

`R-SPINNER-001` 明确的忙碌视觉，不代替状态说明。

## 组成

本合同覆盖同模块导出的整组组件：Spinner。真实API读取生成的TypeScript声明。

## 状态

`R-SPINNER-002` 默认尺寸、宿主className、局部加载。只在可见且窗口在前台时转动；短于 400ms 的加载用 [Skeleton](../skeleton/skeleton.md) 合同里的 `useDelayedVisible` 决定是否显示。

## 行为

`R-SPINNER-003` 宿主传入本地化label；显示转动不代表服务端开始或停止。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-004](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-spinner)直接使用包导出，生产消费者继续沿原路径。
