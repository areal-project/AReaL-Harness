---
id: worktree-directory
title: WorktreeDirectory
summary: 按项目分组目录身份、展开详情与删除反馈。
status: experimental
entry: wip
layer: worktree
category: worktree
aliases: ["Worktree目录列表"]
related: ["worktree-settings", "button"]
---

# WorktreeDirectory Worktree目录列表

## 何时使用

用于Worktrees General的已管理目录清单。它呈现原记录，不承担Git或文件系统管理。

## 组成

Root、Group和Item。Item接收name、受控open、details children、删除意图回调和宿主操作状态。

## 状态

收起/展开、删除中、删除受阻及未知。行状态独立，错误不因其他行刷新而变成成功。

## 行为

查看和删除是分开的按钮。删除回调只表达意图；确认、requestId、锁与安全检查由原宿主负责。删除受阻时目录记录保留。

## 内容

名称优先任务名/分支，路径与请求身份在详情中可读；不展示未实现的恢复快照能力。

## 可访问性

展开有独立唯一id与aria关系；删除按钮带目录名，真实disabled阻止重复操作。路径与详情窄窗换行。

## 规则

Item不会自动确认、重试或移除目录。提示Toast消失不清除原删除结果；具体受阻原因仍可在详情核对。

## 示例

独立实例可查看长路径和模拟删除受阻；生产调用原deleteWorktree并保留确认和Core安全约束。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-directory)。
