---
id: settings-row
title: SettingsRow
summary: 对齐设置名称、说明、控件与详情，保留宿主状态所有权。
status: experimental
entry: wip
layer: settings
category: settings
aliases: ["设置行"]
related: ["settings-group-card", "disclosure"]
---

# SettingsRow 设置行

## 何时使用

用于设置工作区中的字段。导航项和任务活动条目使用原有专用组件。

## 组成

label、description、control、detail插槽；controlLayout为default或wide。default详情在行下，wide详情在控件区域前方。

## 状态

默认、宽控件布局、视觉禁用。保存中、错误、待核对由宿主通过detail/反馈呈现，不从disabled推断结果。

## 行为

默认列适应控件宽度，wide控件列280px；组宽不超过520px时堆叠。禁用行标记aria-disabled并拦截控件区指针操作，宿主仍须禁用实际控件以阻止键盘操作。

## 内容

字段名说明用户可调整的内容，描述说明影响。失败提供明确重试条件，结果未知时先核对回执，不能自动重放写入。

## 可访问性

label插槽是布局内容，不能自动标记任意控件。宿主通过htmlFor/id或aria-label命名实际输入，用aria-describedby连接帮助及错误；真实disabled由控件负责。

## 规则

纯布局组件不保存值、不推导提交状态、不访问服务。SettingsSelect/Switch等业务适配继续由renderer拥有；input/range基础外观沿现有设置规范。

## 示例

独立实例覆盖长说明、wide输入、锁定控件及本地保存反馈。示例状态选择器只控制本地状态，不提供真实配置保存。

[打开组件目录实例](../../../../../renderer/design-system.html?ui-library#component-settings-row)。
