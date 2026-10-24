---
id: composer-surface
title: ComposerSurface
summary: 组合编辑器、上下文与工具栏，提供一致的输入布局与阻塞说明。
status: experimental
entry: wip
layer: conversation
category: input
aliases: ["对话输入表面"]
related: ["composer-toolbar", "button"]
---

# ComposerSurface 对话输入表面

## 何时使用

主聊天、Side和草稿等任务输入。普通设置值不使用此表面，仍用原Input/SettingsRow。

## 组成

editor、toolbar为必要插槽；context承载附件/引用/可读阻塞理由，overlay承载拖放提示。宿主提供原Lexical编辑器，组件不创建第二个编辑器。

## 状态

默认、compact、聚焦、拖放。空内容、附件、发送中、运行中和模型不可用由宿主提供内容与动作，不转为包内执行状态机。

## 行为

编辑区随内容增高，到局部高度上限后纵向阅读；compact在窄容器回到上下布局。同一草稿保持实例身份，换布局或收起审批不重建编辑器。

## 内容

占位说明输入目标；阻塞发送时呈现准确原因并保留草稿。模型、权限、附件名与引用来源来自真实目录，不能从灰按钮推断后台受理。

## 可访问性

宿主标注编辑器与图标按钮；输入、工具与发送遵循DOM顺序。submitDisabledReason在生产ChatPromptEditor中可见且关联发送按钮，不能只靠hover；中文组合输入、快捷键及提交仍由Lexical拥有。

## 规则

包负责通用几何，模型菜单/审批布局适配留renderer。禁止读Core、localStorage或凭据；不因模型切换、示例状态或反馈擅自发送、清空草稿。

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-composer-surface)包含独立可操作样例；生产路径通过原ComposerSurface转接。模型/权限选择在独立样例中仅为固定选项，不代表真实配置写入。
