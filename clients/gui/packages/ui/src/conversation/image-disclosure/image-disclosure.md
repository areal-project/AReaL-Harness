---
id: image-disclosure
title: ImageDisclosure
summary: 工具活动图片默认收起，可用性变化保留阅读选择和引用身份。
status: experimental
entry: experimental
layer: conversation
category: media
aliases: ["图片活动"]
related: ["disclosure", "activity-group", "task-context"]
---

# ImageDisclosure 图片活动

## 何时使用

`R-IMAGEDISCLOSURE-001` 工具已经查看图片的记录；用户输入附件与最终交付图片继续使用原内容规范，不自动套用默认收起。

## 组成

`R-IMAGEDISCLOSURE-002` 具名图片入口、可展开内容、不可用反馈。available 由宿主提供真实图片与查看器，unavailable 保留入口和反馈。

## 状态

`R-IMAGEDISCLOSURE-003` 默认收起；人工展开在父组收起、增量、完成和可用性变化后保留。不可用反馈在折叠外，不能伪装为空。

## 内容

`R-IMAGEDISCLOSURE-005` 名称可识别、图片保留比例、不撑宽阅读列。不可用时说明当前问题并保留原引用。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-image-disclosure)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
