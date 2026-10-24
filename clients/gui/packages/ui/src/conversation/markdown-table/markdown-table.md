---
id: markdown-table
title: MarkdownTable
summary: Markdown表格、虚拟横向阅读及复制导出。
status: experimental
entry: wip
layer: conversation
category: composition
aliases: ["Markdown表格、虚拟横向阅读及复制导出"]
related: ["button"]
exports: ["buildMarkdownTableText", "buildCsvTableText", "resolveMarkdownTableStickyScrollbarMode", "resolveMarkdownTableStickyScrollbarOffset", "resolveMarkdownTableFrameDistances", "resolveMarkdownTableVirtualScrollbarMetrics", "resolveMarkdownTableVirtualScrollMax", "MarkdownTable", "MarkdownTableHeader", "MarkdownTableBody", "MarkdownTableRow", "MarkdownTableHead", "MarkdownTableCell"]
---

# MarkdownTable Markdown表格、虚拟横向阅读及复制导出

## 何时使用

Markdown表格、虚拟横向阅读及复制导出，沿现有生产用途。

## 组成

本合同覆盖buildMarkdownTableText, buildCsvTableText, resolveMarkdownTableStickyScrollbarMode, resolveMarkdownTableStickyScrollbarOffset, resolveMarkdownTableFrameDistances, resolveMarkdownTableVirtualScrollbarMetrics, resolveMarkdownTableVirtualScrollMax, MarkdownTable, MarkdownTableHeader, MarkdownTableBody, MarkdownTableRow, MarkdownTableHead, MarkdownTableCell。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

默认、内容增长、聚焦、不可用，以及宿主提供的忙碌/失败/未确认；同一对象保留原身份与阅读状态。

## 行为

横向滚动属于表格内部；隐藏的虚拟滑块也被轨道裁切，宽容器缩窄后不能撑宽页面。

保留原虚拟滚动、列测量和预览。文案labels及onNotify由宿主注入；原路径保留翻译与全局Toast通道，不在包内读Intl或应用事件。

## 内容

名称、标签、说明与结果由宿主投影；不能由视觉状态推断实际操作已完成。

## 可访问性

保留ref、aria、键盘、焦点及减少动态效果。字号增长与窄容器下动作仍须可达。

## 规则

原renderer路径保留翻译、偏好和业务适配；包只拥有UI。实验导出不代表稳定API、完整产品能力或安装包通过。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-markdown-table)。真实业务路径沿原生产专项验证。
