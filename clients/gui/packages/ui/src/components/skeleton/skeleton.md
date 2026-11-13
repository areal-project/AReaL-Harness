---
id: skeleton
title: Skeleton
summary: 加载较久时的内容占位，快请求不出现。
status: stable
entry: index
layer: core
category: control
aliases: ["占位条", "骨架屏"]
related: ["spinner"]
exports: ["Skeleton", "DelayedVisible", "useDelayedVisible"]
---

# Skeleton 占位条

## 何时使用

`R-SKELETON-001` 列表、卡片等有固定形状的内容在加载时用占位条保持版面；单个按钮内的忙碌用 [Spinner](../spinner/spinner.md)。

## 组成

本合同覆盖 Skeleton、`DelayedVisible` 与 `useDelayedVisible`。`DelayedVisible` 是同一规则的组件写法，需保持挂载才能保证最短停留。`shape` 取 `line`、`block`、`pill`，宽高由宿主布局决定。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-004](../../../README.md#共同合同)。检查：`src/lib/delayed-visibility.test.ts`。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-skeleton)直接使用包导出。
