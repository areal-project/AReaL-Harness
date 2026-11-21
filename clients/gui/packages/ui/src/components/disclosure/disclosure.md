---
id: disclosure
title: Disclosure
summary: 原地展开附加信息并保留同一组件身份下的阅读选择。
status: stable
entry: index
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

`R-DISCLOSURE-005` 标题回答展开后能读什么；重要异常或决定不能只藏在 Panel 中。基本外观由包内 CSS 负责。**检查：**`clients/gui/scripts/design-system-conversation-system.mjs`

## 规则

`R-DISCLOSURE-006` 尺寸与展开动效只引用 Token，宿主不覆盖 `.areal-disclosure`、`.areal-disclosure-trigger`、`.areal-disclosure-panel`、`.areal-disclosure-indicator` 内部样式。**为什么：**确保正文与活动折叠区的节奏和无障碍焦点在各页面保持一致。**推广：**需要不同展示形态时通过 props 或 Token 扩展。**检查：**`clients/gui/design-system/verified-components.json`

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-disclosure)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
