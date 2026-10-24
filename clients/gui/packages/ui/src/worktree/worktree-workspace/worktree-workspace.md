---
id: worktree-workspace
title: WorktreeWorkspace
summary: 呈现绑定目录、可执行操作与服务结果。
status: experimental
entry: wip
layer: worktree
category: worktree
aliases: ["Worktree会话工作区详情"]
related: ["worktree-status", "button"]
---

# WorktreeWorkspace Worktree会话工作区详情

## 何时使用

用于会话Worktree分支入口的轻量详情。原WorktreeActions拥有Popover、记录读取和执行。

## 组成

heading、directory、actions、busy、error、output插槽/显示字段。主UI保持轻量，不复制设置管理页。

## 状态

正在读取、就绪、操作中、失败、输出与结果未知。宿主仅在原记录ready时启用已保存的Action。

## 行为

点击动作由宿主执行一次；组件只呈现。未知结果不显示为成功，也不自动重放操作。输出保留原换行并纵向滚动。

## 内容

名称与路径使用实际绑定记录；不能从可见按钮推断后台执行结束。

## 可访问性

操作必须有清楚名称和真实disabled；忙碌为status。短时错误由宿主ToastHost播报，详情保留原始结果文字。日志使用明确aria-label，长路径换行。

## 规则

包不读取记录、不生成请求UUID、不执行脚本。服务归属、忙碌互斥和错误保留由原适配器负责。

## 示例

独立实例模拟动作/忙碌/未知，生产继续使用原worktreeAction请求和权威结果。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-workspace)。
