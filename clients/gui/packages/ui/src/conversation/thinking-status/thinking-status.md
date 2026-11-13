---
id: thinking-status
title: ThinkingStatus
summary: 呈现动态公开模型过程摘要，无摘要时回退Thinking，保留可读动效。
status: experimental
entry: experimental
layer: conversation
category: progress
aliases: ["模型过程摘要", "思考提示"]
related: ["activity-group", "subagent-panel", "task-context"]
---

# ThinkingStatus 模型过程摘要

## 何时使用

宿主确认正在生成或思考时，展示模型已公开提供的短过程摘要；没有摘要才回退 Thinking。等待确认、连接中断、失败或 UNKNOWN 使用真实状态反馈。

## 状态

公开摘要、无摘要回退、长摘要、减少动态效果；模型结算后由宿主移除。空白 label 按无摘要处理。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-thinking-status)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
