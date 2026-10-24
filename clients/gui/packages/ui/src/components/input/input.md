---
id: input
title: Input
summary: 输入框，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: control
aliases: ["输入框"]
related: ["button"]
exports: ["Input", "inputVariants"]
---

# Input 输入框

## 何时使用

单行字段、文件及数值输入；保持原size/htmlSize分工。

## 组成

本合同覆盖同模块导出的整组组件：Input, inputVariants。真实API读取生成的TypeScript声明。

## 状态

默认、xs/sm/lg、只读、禁用、无效及文件字段。

## 行为

原生输入事件、ref和输入法沿原控件，不因外观迁移改变提交。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-input)直接使用包导出，生产消费者继续沿原路径。
