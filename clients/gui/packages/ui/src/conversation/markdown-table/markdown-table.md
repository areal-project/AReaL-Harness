---
id: markdown-table
title: MarkdownTable
summary: Markdown表格、虚拟横向阅读及复制导出。
status: experimental
entry: experimental
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

引用 [R-UI-COMMON-009](../../../README.md#共同合同)。

## 行为

`R-MARKDOWNTABLE-001` 横向滚动属于表格内部；隐藏的虚拟滑块也被轨道裁切，宽容器缩窄后不能撑宽页面。

## 内容

引用 [R-UI-COMMON-011](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-012](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-013](../../../README.md#共同合同)。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-markdown-table)。真实业务路径沿原生产专项验证。
