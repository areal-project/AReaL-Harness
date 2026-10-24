---
id: popover
title: Popover
summary: 轻量浮层，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["轻量浮层"]
related: ["button"]
exports: ["Popover", "PopoverContent", "PopoverDescription", "PopoverHeader", "PopoverTitle", "PopoverTrigger"]
---

# Popover 轻量浮层

## 何时使用

上下文配置、非模态轻量详情。

## 组成

本合同覆盖同模块导出的整组组件：Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger。真实API读取生成的TypeScript声明。

## 状态

关闭/打开、定位碰撞、受控、keepMounted。

## 行为

Escape/外部点击与焦点返回沿Base UI，不接管业务请求或资源生命周期。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-popover)直接使用包导出，生产消费者继续沿原路径。
