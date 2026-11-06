---
id: task-title-overflow
title: TaskTitleOverflowText
summary: 任务长标题的测量、截断渐隐与悬停全名。
status: experimental
entry: experimental
layer: workbench
category: composition
aliases: ["任务长标题的测量、渐隐与滚动", "任务长标题截断"]
related: ["button"]
exports: ["TaskTitleOverflowText"]
---

# TaskTitleOverflowText 任务长标题的测量、截断与悬停全名

## 何时使用

任务长标题的测量、截断与悬停全名，沿现有生产用途。

## 组成

本合同覆盖TaskTitleOverflowText。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

引用 [R-UI-COMMON-009](../../../README.md#共同合同)。

## 行为

引用 [R-UI-COMMON-010](../../../README.md#共同合同)。超出宽度时截断并在右侧渐隐，悬停用应用提示显示全名；不滚动文字，扫视任务列表时画面保持静止。

## 内容

引用 [R-UI-COMMON-011](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-012](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-013](../../../README.md#共同合同)。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-task-title-overflow)。真实业务路径沿原生产专项验证。
