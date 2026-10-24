---
id: dialog
title: Dialog
summary: 模态对话框，沿用现有生产实现与交互。
status: experimental
entry: wip
layer: core
category: overlay
aliases: ["模态对话框"]
related: ["button"]
exports: ["Dialog", "DialogClose", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogOverlay", "DialogPortal", "DialogTitle", "DialogTrigger"]
---

# Dialog 模态对话框

## 何时使用

需要专注填写或确认的内容。

## 组成

本合同覆盖同模块导出的整组组件：Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger。真实API读取生成的TypeScript声明。

## 状态

打开、关闭、无关闭按钮、无遮罩、受控。

## 行为

保留Base UI焦点约束与恢复；本地化关闭文案由原renderer适配传入。业务busy/dirty守卫由宿主负责。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-dialog)直接使用包导出，生产消费者继续沿原路径。
