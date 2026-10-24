---
id: settings-page
title: SettingsPage
summary: 设置页面的唯一纵向滚动区、居中内容列与可选标题。
status: experimental
entry: wip
layer: settings
category: settings
aliases: ["设置页面"]
related: ["settings-section", "settings-group-card"]
---

# SettingsPage 设置页面

## 何时使用

用于完整设置工作区。对话、弹窗和小型内嵌表单保留各自已有容器。

## 组成

外层settings-workspace承载滚动与键盘焦点；内层settings-page承载标题、subtitle和children。className添加在内容列，业务宽列适配由宿主提供。

## 状态

有标题、无标题，宽窗、窄窗。加载、保存、失败、结果待核对是宿主内容，不属于页面容器状态。

## 行为

页面只在外层纵向滚动，内容列不建立第二个滚动区。标题存在时提供区域可读名称；切换页、恢复阅读位置和未保存导航守卫由宿主负责。

## 内容

标题使用设置任务名，副标题说明范围。不要把示例保存回执当作真实配置已落盘的依据。

## 可访问性

外层可通过Tab聚焦，使用原生滚动键；有标题时aria-labelledby关联唯一h1。宿主应保持页面标题层级，并在实际路由切换时管理焦点。

## 规则

导入@areal/ui/settings.css。普通列保持728px、桌面内边距64px/32px、窄窗16px；模型设置的1080px例外留在生产适配。包不拥有导航、IPC或偏好存储。

## 示例

组件目录提供同一设置组合的独立实例，可切换反馈并保留本地输入。生产通过原SettingsWorkspace路径转接，不创建第二条设置路由。

[打开组件目录实例](../../../../../renderer/design-system.html?ui-library#component-settings-page)。
