---
id: worktree-settings
title: WorktreeSettings
summary: 组合项目、环境、脚本与Action的既有设置布局。
status: experimental
entry: wip
layer: worktree
category: worktree
aliases: ["Worktree设置组合"]
related: ["settings-page", "settings-section", "worktree-directory"]
---

# WorktreeSettings Worktree设置组合

## 何时使用

用于Worktrees General/Environments的目录管理和环境编辑。继续组合既有SettingsPage/Section/Row。

## 组成

Root、Breadcrumb、Project、Environment、Script、Action。平台Tabs、输入、变量Popover和保存动作由宿主作为内容传入。

## 状态

项目/环境空态、编辑、分平台覆盖、Actions空态、保存中、失败与待核对。配置与动作定义不等于脚本已执行。

## 行为

面包屑和列表发出导航意图；原useGuardedNavigation与useDraftBlocker决定能否离开。Setup/Cleanup/Action各自保留平台和草稿，只有宿主保存写入。

## 内容

支持Default/macOS/Linux。仅说明现有变量，不新增自定义变量或密钥能力。脚本正文保留换行、等宽字体和可读路径。

## 可访问性

实际Tabs/Input/Textarea由宿主命名、禁用和关联说明。窄窗单列，页面仍只有SettingsPage滚动所有者。

## 规则

包不认识存储revision或requestId，不改变确认、版本冲突和锁定语义。通用几何在包，产品页面宽度与刷新按钮定位留renderer。

## 示例

独立实例验证项目→环境→脚本、平台值保留、保存中禁用及失败保留；生产WorktreesSettings沿原配置路径使用。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-settings)。
