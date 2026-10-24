---
id: action-button
title: ActionButton
summary: 紧凑操作，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["紧凑操作"]
related: ["button"]
exports: ["ActionButton"]
---

# ActionButton 紧凑操作

## 何时使用

设置与列表中的有名称动作。

## 组成

本合同覆盖同模块导出的整组组件：ActionButton。真实API读取生成的TypeScript声明。

## 状态

默认、图标、pending、disabled。

## 行为

pending时保留文字、显示转动图标并禁止重复点击，不推断操作已完成。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-action-button)直接使用包导出，生产消费者继续沿原路径。
