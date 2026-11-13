---
id: collapsible-text
title: CollapsibleText
summary: 长正文的渐进阅读。
status: experimental
entry: compositions
layer: conversation
category: composition
aliases: ["长正文的渐进阅读"]
related: ["button"]
exports: ["CollapsibleText"]
---

# CollapsibleText 长正文的渐进阅读

## 何时使用

`R-COLLAPSIBLETEXT-001` 长正文的渐进阅读。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖CollapsibleText；完整Props从同目录生成TS API读取。

## 状态

引用 [R-UI-COMMON-005](../../../README.md#共同合同)。

## 行为

引用 [R-UI-COMMON-014](../../../README.md#共同合同)。

## 内容

引用 [R-UI-COMMON-006](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-007](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-015](../../../README.md#共同合同)。

### GUI 接线

共享阅读方式、全文与原文关系由[深入查看与返回](../../../../../../../design/patterns/inspect-and-return.md)维护。本节定义 GUI 的组件、测量、焦点与例外接线。

- **按实际布局折叠**：根据渲染高度判断，覆盖 Markdown、多行与自动换行；宽度、字号或字体变化后重新测量，不只按字符数判断。短文本完整展示，不出现无效展开入口。
- `R-COLLAPSIBLETEXT-002` **预览与全文可逆切换**：默认保留开头预览，提供始终可见的“展开全文 / 收起”按钮；按钮位于裁剪区域之外，不能只在 hover 时出现。聊天默认预览约 8 行，数值归 [collapsible-text.css](collapsible-text.css)。新消费者优先从 `@areal/ui/compositions` 复用本组件，并导入 `@areal/ui/conversation.css`，不要另写字符截断或折叠状态机。
- `R-COLLAPSIBLETEXT-005` **按任务设定例外**：正在编辑的输入、流式主要回复、需要完整核对的审批关键信息以及专用文件/日志阅读器，保留其现有阅读机制；不能为了统一外观隐藏完成当前任务必需的信息。未来长文本设计评审必须说明所选机制与可达全文的路径。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-collapsible-text)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
