---
id: command
title: Command
summary: 命令选择，沿用现有生产实现与交互。
status: experimental
entry: wip
layer: core
category: control
aliases: ["命令选择"]
related: ["button"]
exports: ["Command", "CommandDialog", "CommandInput", "CommandList", "CommandEmpty", "CommandGroup", "CommandItem", "CommandShortcut", "CommandSeparator"]
---

# Command 命令选择

## 何时使用

可搜索的命令列表与可选对话框容器。

## 组成

本合同覆盖同模块导出的整组组件：Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator。真实API读取生成的TypeScript声明。

## 状态

查询、无结果、分组、选中、禁用。

## 行为

复用现有cmdk，候选与执行由宿主提供；不自动把匹配项当作已执行。

## 内容

名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

## 可访问性

保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

## 规则

从@areal/ui/wip导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-command)直接使用包导出，生产消费者继续沿原路径。
