---
id: disclosure
title: Disclosure
summary: 原地展开附加信息并保留同一组件身份下的阅读选择。
status: experimental
entry: wip
layer: core
category: disclosure
aliases: ["折叠"]
related: ["button", "activity-group", "image-disclosure"]
---

# Disclosure 折叠

## 何时使用

按需展开一段附加信息；一次动作使用 [Button](../button/button.md)，任务活动列表使用 [ActivityGroup](../../conversation/activity-group/activity-group.md)。

## 组成

Root、具名 Trigger、指示箭头、Panel。textRole 区分内容附注和界面标签；displayLabel 精简可见名称，label 保留完整可访问名称。

## 状态

默认收起；同一实例中的手动展开会保留。keepMounted 用于父组收起后仍要保留的子详情。

## 行为

presentation=inline隐藏入口并展开同一Panel；切换为collapsible时沿本实例的人工选择。用于连续活动从单条增长成分组，保持子详情身份。

Enter/Space 切换 expanded；折叠只改变阅读，不停止执行。切换不同对象使用原身份 key，不把完成/运行状态作为 key。

## 内容

标题回答展开后能读什么；重要异常或决定不能只藏在 Panel 中。基本外观由包内 CSS 负责。

## 可访问性

Base UI Collapsible 提供 expanded/controls 和隐藏内容的焦点约束。宿主负责关闭资源后的焦点返回。

## 规则

沿 reduced motion 偏好。实验入口只用于已授权场景，不通过目录登记自动升级为稳定。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-disclosure)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
