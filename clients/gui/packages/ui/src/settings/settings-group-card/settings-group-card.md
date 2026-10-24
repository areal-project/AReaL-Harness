---
id: settings-group-card
title: SettingsGroupCard
summary: 用默认或紧凑密度分组设置行。
status: experimental
entry: wip
layer: settings
category: settings
aliases: ["设置分组卡片"]
related: ["settings-section", "settings-row"]
---

# SettingsGroupCard 设置分组卡片

## 何时使用

用于同一主题的设置行组。普通信息卡、对话任务和审批卡保留各自组件。

## 组成

外层卡片、内部card-content与children；density仅支持默认或compact。圆角、边框和分隔线复用现有设置语义。

## 状态

默认与compact密度、宽窄容器、明暗主题。卡片没有选中、禁用或保存状态。

## 行为

卡片建立inline-size容器，行在520px及以下叠排。卡片隐藏溢出以维护圆角，但不承担纵向阅读滚动。

## 内容

一组只承载相关配置；详情使用行detail，长帮助可以由宿主Disclosure渐进展示。

## 可访问性

卡片不新增角色或键盘焦点；实际字段必须具有可访问名称。不要把视觉分隔线当作唯一分组标识。

## 规则

导入settings.css；默认行最小48px，compact为40px。卡片不拥有字段值，也不能批量推断子控件禁用。

## 示例

独立实例展示默认输入组与compact锁定组，窄窗自动叠排；生产DisplaySettings沿原路径消费同一实现。

[打开组件目录实例](../../../../../renderer/design-system.html?ui-library#component-settings-group-card)。
