---
id: settings-dialog
title: SettingsDialog
summary: 设置弹窗、工具栏与空态。
status: experimental
entry: experimental
layer: settings
category: composition
aliases: ["设置弹窗、工具栏与空态"]
related: ["button"]
exports: ["SettingsDialog", "SettingsToolbar", "EmptySettings"]
---

# SettingsDialog 设置弹窗、工具栏与空态

## 何时使用

`R-SETTINGSDIALOG-001` 设置弹窗、工具栏与空态。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖SettingsDialog, SettingsToolbar, EmptySettings；完整Props从同目录生成TS API读取。

## 状态

引用 [R-UI-COMMON-005](../../../README.md#共同合同)。

## 内容

引用 [R-UI-COMMON-006](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-007](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-008](../../../README.md#共同合同)。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-settings-dialog)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
