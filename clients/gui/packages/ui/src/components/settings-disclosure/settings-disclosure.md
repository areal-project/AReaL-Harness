---
id: settings-disclosure
title: SettingsDisclosure
summary: 高级与详情分组的原地展开，默认收起，右侧文字按钮。
status: experimental
entry: compositions
layer: core
category: composition
aliases: ["明确展开和收起的详情"]
related: ["button"]
exports: ["SettingsDisclosure"]
---

# SettingsDisclosure 明确展开和收起的详情

## 何时使用

`R-SETTINGSDISCLOSURE-001` 高级功能、诊断与原始数据的原地展开（依据 P6），默认收起；标题在左，“展开/收起”文字按钮在右，不显示三角。设置页以外的面板与对话框同样使用它，长正文改用 CollapsibleText。

## 组成

本合同覆盖SettingsDisclosure；完整Props从同目录生成TS API读取。

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

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-settings-disclosure)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
