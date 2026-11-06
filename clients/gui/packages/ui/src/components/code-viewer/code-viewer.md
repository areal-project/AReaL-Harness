---
id: code-viewer
title: CodeViewer
summary: 代码阅读、行号、选区与注释呈现。
status: experimental
entry: experimental
layer: core
category: reading
aliases: ["代码阅读、行号、选区与注释呈现"]
related: ["button"]
exports: ["CodeViewer", "CodeCommentAnnotation", "resolveCodeViewerColorScheme", "isCodeCommentSubmitShortcut", "isCodeCommentCancelShortcut", "formatCodeCommentSubmitShortcutLabel", "formatCodeCommentCancelShortcutLabel"]
---

# CodeViewer 代码阅读、行号、选区与注释呈现

## 何时使用

`R-CODEVIEWER-001` 代码阅读、行号、选区与注释呈现。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖CodeViewer, CodeCommentAnnotation, resolveCodeViewerColorScheme, isCodeCommentSubmitShortcut, isCodeCommentCancelShortcut, formatCodeCommentSubmitShortcutLabel, formatCodeCommentCancelShortcutLabel；完整Props从同目录生成TS API读取。

## 状态

引用 [R-UI-COMMON-005](../../../README.md#共同合同)。

## 内容

引用 [R-UI-COMMON-006](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-007](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-008](../../../README.md#共同合同)。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-code-viewer)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
