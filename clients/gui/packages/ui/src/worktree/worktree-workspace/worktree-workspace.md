---
id: worktree-workspace
title: WorktreeWorkspace
summary: 呈现绑定目录、可执行操作与服务结果。
status: experimental
entry: experimental
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

## 内容

`R-WORKTREEWORKSPACE-002` 名称与路径使用实际绑定记录；不能从可见按钮推断后台执行结束。

## 可访问性

`R-WORKTREEWORKSPACE-003` 操作必须有清楚名称和真实disabled；忙碌为status。短时错误由宿主ToastHost播报，详情保留原始结果文字。日志使用明确aria-label，长路径换行。

## 示例

独立实例模拟动作/忙碌/未知，生产继续使用原worktreeAction请求和权威结果。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-workspace)。

## 会话入口与操作位置

`R-WORKTREE-018` 会话头部的工作区入口展示真实目录、分支和已选环境；可用 Actions 位于此入口的详情内。Action 只在实际宿主允许时可运行，显示真实运行、失败和未知结果，不把“已接受”写成“已完成”。Actions 不塞入侧栏会话行，也不扩成另一个常驻工具栏。
