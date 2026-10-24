---
id: textarea
title: Textarea
summary: 多行输入，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["多行输入"]
related: ["button"]
exports: ["Textarea"]
---

# Textarea 多行输入

## 何时使用

设置脚本和多行正文输入。

## 组成

本合同覆盖同模块导出的整组组件：Textarea。真实API读取生成的TypeScript声明。

## 状态

空值、长正文、聚焦、禁用、无效。

## 行为

保持原生textarea事件与field-sizing，不承担草稿持久化或发送。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-textarea)直接使用包导出，生产消费者继续沿原路径。
