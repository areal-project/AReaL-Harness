---
id: image-disclosure
title: ImageDisclosure
summary: 工具活动图片默认收起，可用性变化保留阅读选择和引用身份。
status: experimental
entry: wip
layer: conversation
category: media
aliases: ["图片活动"]
related: ["disclosure", "activity-group", "task-context"]
---

# ImageDisclosure 图片活动

## 何时使用

工具已经查看图片的记录；用户输入附件与最终交付图片继续使用原内容规范，不自动套用默认收起。

## 组成

具名图片入口、可展开内容、不可用反馈。available 由宿主提供真实图片与查看器，unavailable 保留入口和反馈。

## 状态

默认收起；人工展开在父组收起、增量、完成和可用性变化后保留。不可用反馈在折叠外，不能伪装为空。

## 行为

展开读取已有图片，不重新执行工具。组件不读取文件或下载远程资源；加载结果由宿主资源适配器确认。

## 内容

名称可识别、图片保留比例、不撑宽阅读列。不可用时说明当前问题并保留原引用。

## 可访问性

宿主图片提供可理解替代文本，原查看器拥有打开/关闭焦点；折叠沿 Disclosure 语义。

## 规则

原资源 ID 作 key，不从文件名推断可用性。生产ToolEvent已消费同一组件，工具图片默认收起；用户输入附件和最终交付图片沿原规则。宿主将读取错误保留在折叠外。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-image-disclosure)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
