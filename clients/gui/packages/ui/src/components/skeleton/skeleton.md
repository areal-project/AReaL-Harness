---
id: skeleton
title: Skeleton
summary: 加载较久时的内容占位，快请求不出现。
status: experimental
entry: experimental
layer: core
category: control
aliases: ["占位条", "骨架屏"]
related: ["spinner"]
exports: ["Skeleton", "useDelayedVisible"]
---

# Skeleton 占位条

## 何时使用

`R-SKELETON-001` 列表、卡片等有固定形状的内容在加载时用占位条保持版面；单个按钮内的忙碌用 [Spinner](../spinner/spinner.md)。

## 组成

本合同覆盖 Skeleton 与 `useDelayedVisible`。`shape` 取 `line`、`block`、`pill`，宽高由宿主布局决定。

## 状态

`R-SKELETON-002` 宿主用 `useDelayedVisible(loading)` 决定是否显示占位或 Spinner：加载持续 400ms 后才显示，显示后至少保留 400ms，避免快请求闪一下。

## 行为

`R-SKELETON-003` 全部占位条共用一次分步呼吸；减少动效时静止。占位条对辅助技术隐藏，加载状态由宿主的文字或 `aria-busy` 说明。

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-004](../../../README.md#共同合同)。检查：`src/lib/delayed-visibility.test.ts`。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-skeleton)直接使用包导出。
