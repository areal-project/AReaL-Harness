---
id: button
title: Button
summary: 发出一次动作或打开入口，外观不代表业务已经受理。
status: stable
entry: index
layer: core
category: actions
aliases: ["按钮"]
related: ["disclosure"]
---

# Button 按钮

## 何时使用

| 场景 | 选择 |
| --- | --- |
| 提交、打开或执行一次动作 | Button |
| 按需展开阅读 | [Disclosure](../disclosure/disclosure.md) |
| `R-BUTTON-001` 持续状态/取值选择 | 原 Switch / Select，不用按钮模拟 |

## 内容

`R-BUTTON-005` 可见文字命名动作；纯图标按钮提供 aria-label。`title` 渲染为共享提示而不是浏览器原生提示，不承担可访问名称。普通动作使用原有限变体，不用 className 补齐基本外观。

## 规则

`R-BUTTON-008` 变体只表达通用动作层级：`default`、`secondary`、`outline`、`ghost`、`link`、`destructive`、`destructive-subtle`、`warning`。某个产品区域专用的外观放在所属组合里，例如输入区主动作用 conversation 层的 `ComposerActionButton`，不新增 Button 变体。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-button)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。
