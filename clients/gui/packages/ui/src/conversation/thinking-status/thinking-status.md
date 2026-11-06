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

## 内容

`R-THINKINGSTATUS-003` 只接受已公开的模型摘要，不展示原始隐藏推理。不逐 token 变更辅助技术播报；宿主聚合为可读片段后传入。摘要不证明工具执行成功，完整过程仍在所属时间线。

## 可访问性

`R-THINKINGSTATUS-004` 底层文字始终可读，aria-live=polite/atomic 仅播报一份。产品及系统减少动效时文字立即替换、无位移/扫描；离屏和后台停止循环。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-thinking-status)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
