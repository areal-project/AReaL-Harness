---
id: task-list-item
title: MemoTaskItem
summary: 任务行的标题、状态、工作区身份与动作。
status: experimental
entry: experimental
layer: workbench
category: composition
aliases: ["任务行的标题、状态、工作区身份与动作"]
related: ["button"]
exports: ["MemoTaskItem"]
---

# MemoTaskItem 任务行的标题、状态、工作区身份与动作

## 何时使用

任务行的标题、状态、工作区身份与动作，沿现有生产用途。

## 组成

本合同覆盖MemoTaskItem。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

引用 [R-UI-COMMON-009](../../../README.md#共同合同)。

## 行为

引用 [R-UI-COMMON-010](../../../README.md#共同合同)。

## 内容

引用 [R-UI-COMMON-011](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-012](../../../README.md#共同合同)。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-task-list-item)。真实业务路径沿原生产专项验证。

## Worktree 身份

`WT-IDENTITY-01`（WT-R04～06）：会话名称仍为侧栏主内容；尾部以一个紧凑 GitFork 标明 Worktree。不得为每个会话常驻第二行 UUID 分支或完整路径。正在准备时可以显示准备态，已绑定后才标为“在 Worktree 工作”，取消且未绑定不能留下成功标识。

标识使用可读名称 / tooltip，说明“Worktree”、当前状态与完整分支；目录在工作区详情可读。它与未读点、运行状态分别占位，不相互覆盖。颜色只辅助状态，减弱动效后仍能区分正在准备与已绑定。
