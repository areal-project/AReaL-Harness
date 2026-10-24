---
id: composer-toolbar
title: ComposerToolbar
summary: 分配前置工具与后置配置/主动作，保持编辑器附近的操作顺序。
status: experimental
entry: wip
layer: conversation
category: input
aliases: ["对话输入工具栏"]
related: ["composer-surface", "button"]
exports: ["ComposerToolbar", "ComposerActionButton"]
---

# ComposerToolbar 对话输入工具栏

## 何时使用

ComposerSurface内的附件、权限、模型与发送/停止入口，已经用于主聊天、Side与草稿。

## 组成

leading与trailing两个必要插槽；原data-composer-leading-actions/content与trailing-actions保留给现有宽度测量适配。

## 状态

默认、窄容器换行、宿主提供的不可用/发送中/运行中控件。工具栏自身不生成执行状态。

## 行为

前置工具在前，后置动作靠末端；compact几何由同一ComposerSurface控制。键盘焦点按真实控件顺序，不通过视觉排序改变提交动作。

## 内容

模型和权限显示当前真实选值；主动作有可读名称。超长模型名可省略，但完整名称与不可用原因由原菜单保留。

## 可访问性

使用原按钮/菜单语义；图标入口由宿主命名。禁用必须作用于真实按钮，不以pointer-events代替禁用语义。

## 规则

发送/继续等主动作使用 `ComposerActionButton`：胶囊形、前景色底、禁用时退为次要表面，默认 `size="icon"`。它不是基础 Button 的变体，停止、排队保存等次要动作继续用 Button 的 `secondary`。

不导入模型目录、权限策略或UI导航；不将选择模型等同于已应用，也不把停止受理显示为任务终止。

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-composer-toolbar)嵌入与ComposerSurface相同组合，生产仍消费原模型/权限菜单。
