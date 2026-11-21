---
id: thread-find-bar
title: ThreadFindBar
summary: 会话右上角紧凑查找浮条，支持匹配计数、上下跳转与 Esc 关闭。
status: stable
entry: compositions
layer: conversation
category: input
aliases: ["会话查找", "FindBar"]
related: ["input", "button", "tooltip"]
exports: ["ThreadFindBar"]
---

# ThreadFindBar 会话内查找浮条

## 何时使用

`R-THREADFINDBAR-001` 在当前会话内快速检索消息、命令输出或文件路径时浮起展示，不推动正文布局。

## 可访问性

`R-THREADFINDBAR-002` 容器暴露 `role="search"`，匹配数用 `aria-live="polite"` 播报，无匹配时禁用上下跳转按钮。**检查：**`clients/gui/packages/ui/src/conversation/thread-find-bar/thread-find-bar.test.tsx`

## 示例

[对话组合](../../../../../renderer/design-system.html?conversation-system)展示与生产一致的会话查找条。
