---
id: activity-group
title: ActivityGroup
summary: 默认收起连续活动，纵向阅读原记录，关键状态始终可见。
status: experimental
entry: wip
layer: conversation
category: activity
aliases: ["活动组"]
related: ["disclosure", "image-disclosure", "thinking-status"]
---

# ActivityGroup 活动分组

## 何时使用

同一轮、同一项目内连续工具活动的按需阅读；单条活动用presentation=inline直接呈现；数量增长后切回collapsible，保持同一实例和子记录身份。不要跨用户消息、助手说明或最终回答合并。

## 组成

具名摘要、可聚焦的有界滚动区、折叠外的 status 插槽。children 保留原顺序，实际分组与事件身份归宿主投影。

## 状态

默认收起；手动选择在同一实例中保留。父组收起保留子详情，追加输出或完成不重置展开。失败、审批和 UNKNOWN 在 status 中可发现。

## 行为

列表只纵向滚动，摘要不随列表滚走。长命令/代码/路径换行；完整复制由原阅读器负责。展开或查看不会执行、重试或归并不同命令。

## 内容

摘要使用真实类型和数量；未知计数就省略。模型过程摘要使用 [ThinkingStatus](../thinking-status/thinking-status.md)，不替代执行结果。

## 可访问性

沿 Disclosure 键盘语义；滚动区可聚焦。条目必须有可理解名称和合法动作，不能只裁切正文来消除横向滚动。

## 规则

使用原事件 ID 作 key；对象切换重建，状态更新保持身份。高度上限是组件局部选择，不登记全局 Token。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-activity-group)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
