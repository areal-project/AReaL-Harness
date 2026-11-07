---
id: settings-section
title: SettingsSection
summary: 组织设置标题、说明、操作与正文。
status: experimental
entry: compositions
layer: settings
category: settings
aliases: ["设置分区"]
related: ["settings-page", "settings-group-card"]
---

# SettingsSection 设置分区

## 何时使用

用于设置页内同一主题的一组配置。单个字段用SettingsRow，页面标题用SettingsPage。

## 组成

可选title、description、action与必要children。标题区只在有内容时出现，action保持实际控件语义。

## 状态

仅正文、标题/说明、带操作。分区本身没有禁用、处理中或保存结果状态。

## 示例

独立实例包含输入偏好与保存反馈分区，和SettingsPage/GroupCard/Row共同使用。

[打开组件目录实例](../../../../../renderer/design-system.html?ui-library#component-settings-section)。
