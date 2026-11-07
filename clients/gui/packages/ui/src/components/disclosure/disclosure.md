---
id: disclosure
title: Disclosure
summary: 原地展开附加信息并保留同一组件身份下的阅读选择。
status: experimental
entry: experimental
layer: core
category: disclosure
aliases: ["折叠"]
related: ["button", "activity-group", "image-disclosure"]
---

# Disclosure 折叠

## 何时使用

按需展开一段附加信息；一次动作使用 [Button](../button/button.md)，任务活动列表使用 [ActivityGroup](../../conversation/activity-group/activity-group.md)。

## 状态

`R-DISCLOSURE-002` 默认收起；同一实例中的手动展开会保留。keepMounted 用于父组收起后仍要保留的子详情。宿主可通过 open 与 onOpenChange 管理阅读选择，以语义对象身份保存并在重新挂载时恢复。未传 open 时仍由组件保存本实例的选择。

## 内容

`R-DISCLOSURE-005` 标题回答展开后能读什么；重要异常或决定不能只藏在 Panel 中。基本外观由包内 CSS 负责。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-disclosure)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
