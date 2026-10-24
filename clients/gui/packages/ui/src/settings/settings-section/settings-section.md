---
id: settings-section
title: SettingsSection
summary: 组织设置标题、说明、操作与正文。
status: experimental
entry: wip
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

## 行为

标题与操作在窄容器换行，正文保持DOM阅读顺序。不创建额外滚动或自动聚焦。

## 内容

标题概括配置主题，说明交代作用范围。操作明确写出动作，不以分区样式暗示保存成功。

## 可访问性

有标题时使用h2；正文及操作各自提供名称。分区不会替子控件生成label或添加多余键盘焦点。

## 规则

组件只组合插槽，不调用Intl、Store或Core。间距、字号和语义色沿用现有设计系统，不为页面实例复制样式。

## 示例

独立实例包含输入偏好与保存反馈分区，和SettingsPage/GroupCard/Row共同使用。

[打开组件目录实例](../../../../../renderer/design-system.html?ui-library#component-settings-section)。
