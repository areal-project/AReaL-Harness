---
id: thread-summary-panel
title: ThreadSummaryPanel
summary: 会话顶部置顶摘要面板，支持展开卡片与紧凑浮条双态切换。
status: stable
entry: compositions
layer: conversation
category: summary
aliases: ["Pin Summary", "置顶摘要", "会话摘要面板"]
related: ["activity-group", "disclosure", "button"]
exports: ["ThreadSummaryPanel", "ThreadSummaryItem"]
---

# ThreadSummaryPanel 会话置顶摘要

## 何时使用

`R-THREADSUMMARY-001` 在会话顶部固定呈现当前任务的关键上下文（变更文件、待确认项、活跃子任务或关联计划），供用户随时展开、收起或取消固定；面板自身不持有业务数据。

## 组成

头部触发按钮（展开/收起）、行内摘要元信息、固定开关与可选动作槽；展开区域包含按条目组织的 `ThreadSummaryItem`，高度受 `--thread-summary-max-height` 约束。

## 状态

`R-THREADSUMMARY-002` 展开卡片（`variant="card"`）、紧凑浮条（`variant="compact"`）与固定/取消固定态。**检查：**`clients/gui/packages/ui/src/conversation/thread-summary-panel/thread-summary-panel.test.tsx`

## 可访问性

`R-THREADSUMMARY-003` 触发按钮暴露真实 `aria-expanded`，固定按钮暴露 `aria-pressed` 与可读标签，不使用原生 `title` 属性。**检查：**`clients/gui/packages/ui/src/conversation/thread-summary-panel/thread-summary-panel.test.tsx`

## 示例

[对话组合](../../../../../renderer/design-system.html?conversation-system)提供与生产一致的置顶摘要呈现。
