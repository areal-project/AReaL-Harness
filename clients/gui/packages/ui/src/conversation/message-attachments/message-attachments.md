---
id: message-attachments
title: Attachments
summary: 消息媒体、文件与来源附件。
status: experimental
entry: wip
layer: conversation
category: composition
aliases: ["消息媒体、文件与来源附件"]
related: ["button"]
exports: ["getMediaCategory", "getAttachmentLabel", "useAttachmentsContext", "useAttachmentContext", "Attachments", "Attachment", "AttachmentPreview", "AttachmentInfo", "AttachmentRemove"]
---

# Attachments 消息媒体、文件与来源附件

## 何时使用

消息媒体、文件与来源附件，沿现有生产用途。

## 组成

本合同覆盖getMediaCategory, getAttachmentLabel, useAttachmentsContext, useAttachmentContext, Attachments, Attachment, AttachmentPreview, AttachmentInfo, AttachmentRemove。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

默认、内容增长、聚焦、不可用，以及宿主提供的忙碌/失败/未确认；同一对象保留原身份与阅读状态。

## 行为

保留原实现、原生语义和交互动线。只读取props与浏览器布局，不请求Core，不访问保存配置。

## 内容

名称、标签、说明与结果由宿主投影；不能由视觉状态推断实际操作已完成。

## 可访问性

保留ref、aria、键盘、焦点及减少动态效果。字号增长与窄容器下动作仍须可达。

## 规则

保留原AI Elements Apache-2.0来源说明。组件只展示宿主提供的已授权URL/元数据，权限与媒体读取不迁入包。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-message-attachments)。真实业务路径沿原生产专项验证。
