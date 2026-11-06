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

`R-MARKDOWNTABLE-002` 保留原虚拟滚动、列测量和预览。放大入口有可见文字；复制、导出、放大浮在表格右上角，悬停或键盘聚焦时出现，触屏常显，不单独占一行；溢出时在表格下方显示横滚提示与滚动条；内联滚动区域可聚焦并通过左右方向键阅读。Dialog关闭回到触发入口，预览保留固定表头、复制与CSV导出。文案labels及onNotify由宿主注入；原路径保留翻译与全局Toast通道，不在包内读Intl或应用事件。宿主提供sourceMarkdown时，复制保留源码的列对齐、链接、行内代码与强调；完整回答中的引用式链接包含所用定义，嵌套表格移除外层引用/列表缩进。纯React表格未提供源码时沿用文本重建。CSV仍按显示文本导出，保留UTF-8 BOM及公式防护。

## 内容

引用 [R-UI-COMMON-011](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-012](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-013](../../../README.md#共同合同)。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-markdown-table)。真实业务路径沿原生产专项验证。
