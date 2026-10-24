---
id: settings-select
title: SettingsSelect
summary: 设置值选择及辅助显示。
status: experimental
entry: wip
layer: settings
category: composition
aliases: ["设置值选择及辅助显示"]
related: ["button"]
exports: ["SettingsSelect", "SettingsLockedValue", "SettingsBadge", "SettingsSwitch", "SettingsValueAction"]
---

# SettingsSelect 设置值选择及辅助显示

## 何时使用

设置值选择及辅助显示。沿现有生产用途，不新增业务入口。

## 组成

本合同覆盖SettingsSelect, SettingsLockedValue, SettingsBadge, SettingsSwitch, SettingsValueAction；完整Props从同目录生成TS API读取。

## 状态

默认、内容增长、禁用/忙碌（由宿主提供）、明暗与不同字号；展示更新保留原身份与阅读状态。

## 行为

保留原实现和键盘/焦点/滚动语义。原renderer适配提供翻译、偏好与合法动作；UI包只呈现与管理本地交互。

## 内容

名称、原因与结果来自宿主事实；未确认不能显示为成功，短时通知不替代原始结果与恢复动作。

## 可访问性

真实控件保留label、aria、ref和键盘入口。18px字号和窄窗保持内容可读，焦点不因重新包装而丢失。

## 规则

包不依赖renderer、Intl、Store、Core或Electron。原路径仅转接或注入宿主数据；保持experimental/wip，不自动提升稳定API。

## 示例

[组件目录与独立实例](../../../../../renderer/design-system.html?ui-library#component-settings-select)消费同一包实现。真实服务、持久化和桌面生命周期由原专项验证。
