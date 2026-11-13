---
id: command
title: Command
summary: 命令选择，沿用现有生产实现与交互。
status: experimental
entry: experimental
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

## 内容

引用 [R-UI-COMMON-001](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-002](../../../README.md#共同合同)。

## 规则

引用 [R-UI-COMMON-004](../../../README.md#共同合同)。

## 示例

[独立实例](../../../../../renderer/design-system.html?ui-library#component-command)直接使用包导出，生产消费者继续沿原路径。
