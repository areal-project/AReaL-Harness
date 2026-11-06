---
id: settings-navigation
title: SettingsNavigation
summary: 设置分类、查询与返回入口。
status: experimental
entry: experimental
layer: workbench
category: composition
aliases: ["设置分类、查询与返回入口"]
related: ["button"]
exports: ["SettingsNavigation"]
---

# SettingsNavigation 设置分类、查询与返回入口

## 何时使用

设置分类、查询与返回入口，沿现有生产用途。

## 组成

本合同覆盖SettingsNavigation。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

引用 [R-UI-COMMON-009](../../../README.md#共同合同)。

## 行为

引用 [R-UI-COMMON-010](../../../README.md#共同合同)。查询先匹配分类名，再匹配宿主传入的页内条目名（`keywords`）；按条目命中时在分类名右侧写出命中的条目，用户不必猜设置藏在哪一页。

## 内容

引用 [R-UI-COMMON-011](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-012](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-013](../../../README.md#共同合同)。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-settings-navigation)。真实业务路径沿原生产专项验证。
