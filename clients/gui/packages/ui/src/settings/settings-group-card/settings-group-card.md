---
id: settings-group-card
title: SettingsGroupCard
summary: 用默认或紧凑密度分组设置行。
status: experimental
entry: compositions
layer: settings
category: settings
aliases: ["设置分组卡片"]
related: ["settings-section", "settings-row"]
---

# SettingsGroupCard 设置分组卡片

## 何时使用

`R-SETTINGSGROUPCARD-001` 用于同一主题的设置行组。普通信息卡、对话任务和审批卡保留各自组件。

## 内容

一组只承载相关配置；详情使用行detail，长帮助可以由宿主Disclosure渐进展示。

## 可访问性

`R-SETTINGSGROUPCARD-005` 卡片不新增角色或键盘焦点；实际字段必须具有可访问名称。不要把视觉分隔线当作唯一分组标识。

## 规则

`R-SETTINGSGROUPCARD-006` 导入settings.css；默认行最小48px，compact为40px。卡片不拥有字段值，也不能批量推断子控件禁用。

## 示例

[打开组件目录实例](../../../../../renderer/design-system.html?ui-library#component-settings-group-card)。
