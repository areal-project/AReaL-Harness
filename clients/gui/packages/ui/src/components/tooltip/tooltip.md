---
id: tooltip
title: Tooltip
summary: 辅助提示，沿用现有生产实现与交互。
status: stable
entry: index
layer: core
category: overlay
aliases: ["辅助提示"]
related: ["button"]
exports: ["Tooltip", "TooltipContent", "TooltipProvider", "TooltipTrigger"]
---

# Tooltip 辅助提示

## 何时使用

对已有可见操作补充说明。

## 组成

本合同覆盖同模块导出的整组组件：Tooltip, TooltipContent, TooltipProvider, TooltipTrigger。真实API读取生成的TypeScript声明。

## 状态

延迟、打开、四向定位、触发器聚焦。

## 行为

不作为唯一按钮名称，不在提示中放必须完成的业务动作。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-tooltip)直接使用包导出，生产消费者继续沿原路径。
