---
id: worked-for-divider
title: WorkedForDivider
summary: 对话流中分隔工具过程与最终结论的克制耗时分隔条。
status: stable
entry: compositions
layer: conversation
category: activity
aliases: ["耗时分隔条", "WorkedFor"]
related: ["activity-group", "thinking-status"]
exports: ["WorkedForDivider"]
---

# WorkedForDivider 耗时分隔条

## 何时使用

`R-WORKEDFOR-001` 一轮工具活动完成并进入最终结论前，用本组件呈现阶段耗时与细分割线，不给过程增加卡片边框。

## 可访问性

`R-WORKEDFOR-002` 容器暴露 `role="separator"` 与可读耗时名称；可选点击触发使用原生按钮语义。**检查：**`clients/gui/packages/ui/src/conversation/worked-for-divider/worked-for-divider.test.tsx`

## 示例

[对话组合](../../../../../renderer/design-system.html?conversation-system)展示与生产一致的耗时分隔呈现。
