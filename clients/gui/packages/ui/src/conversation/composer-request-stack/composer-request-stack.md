---
id: composer-request-stack
title: ComposerRequestStack
summary: 底部待处理请求导航栈，多条审批或问答并存时提供 1 / N 切换而不堆叠挤占视口。
status: stable
entry: compositions
layer: conversation
category: decision
aliases: ["请求栈", "待处理导航", "RequestStack"]
related: ["decision-card", "question-card", "badge", "button"]
exports: ["ComposerRequestStack"]
---

# ComposerRequestStack 底部请求导航栈

## 何时使用

`R-COMPOSERREQUESTSTACK-001` 同一会话同时存在多条待确认审批或提问时，使用本组件统一承载并按 `1 / N` 切换；单条请求时自动隐藏导航栏。

## 可访问性

`R-COMPOSERREQUESTSTACK-002` 上下切换按钮具名并在首尾禁用，页码使用 `aria-live="polite"` 播报。**检查：**`clients/gui/packages/ui/src/conversation/composer-request-stack/composer-request-stack.test.tsx`

## 示例

[对话组合](../../../../../renderer/design-system.html?conversation-system)展示与生产一致的底部请求栈布局。
