---
id: worktree-status
title: WorktreeStatus
summary: 显示准备摘要、阶段、详情及宿主合法动作。
status: experimental
entry: wip
layer: worktree
category: worktree
aliases: ["Worktree准备状态"]
related: ["worktree-picker", "worktree-workspace"]
---

# WorktreeStatus Worktree准备状态

## 何时使用

用于发送后的Worktree准备过程。现有WorktreeStatus适配器从权威事件投影为可读内容。

## 组成

摘要、可展开阶段、details插槽及controls插槽。组件拥有展开状态，宿主提供state、running、label及阶段显示模型。

## 状态

创建、已创建、绑定、Setup、取消中、取消、失败、未知和就绪均由宿主事实描述。目录已创建不等于会话已绑定/可发送。

## 行为

摘要与终态说明在折叠外；展开显示阶段和日志。相同任务更新保留阅读状态。只查看详情不会重试未知创建。

## 内容

标题说明当前事实；失败与结果待核对保持准确措辞。路径、分支、脚本输出来自原记录，不用假进度百分比推断执行。

## 可访问性

摘要使用status，失败使用alert；详情按钮有aria-expanded/controls。日志保留换行并只纵向滚动。宿主命名操作并负责真实禁用。

## 规则

运行期状态推导仍在原适配器，UI包不导入Core事件类型、不执行取消或创建。controls保持原动作合法性。

## 示例

独立实例可切换运行/失败/未知/就绪、展开日志并触发本地动作；生产Messages和DraftComposer沿原适配使用。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-status)。
