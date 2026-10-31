---
id: attachment-card
title: AttachmentCard
summary: 草稿与队列附件卡、移除与标注入口。
status: experimental
entry: experimental
layer: conversation
category: composition
aliases: ["草稿与队列附件卡、移除与标注入口"]
related: ["button"]
exports: ["AttachmentCard"]
---

# AttachmentCard 草稿与队列附件卡、移除与标注入口

## 何时使用

草稿与队列附件卡、移除与标注入口，沿现有生产用途。

## 组成

本合同覆盖AttachmentCard。API由同目录TS声明生成，复合组件共用一份合同。

## 状态

引用 [R-UI-COMMON-009](../../../README.md#共同合同)。

## 行为

引用 [R-UI-COMMON-010](../../../README.md#共同合同)。

## 内容

引用 [R-UI-COMMON-011](../../../README.md#共同合同)。

## 可访问性

引用 [R-UI-COMMON-012](../../../README.md#共同合同)。

## 规则

`R-ATTACHMENTCARD-001` 仅拥有Root/Open/Remove/Icon/Text/Error/WithNote/Note的外观和语义。文件读取、MIME/字节校验、Blob URL创建释放、注释及上传归宿主。 图片和其他实际附件统一使用96×96固定预览卡，位于正文上方。图片按原比例完整适配；文件名不撑大卡片，完整名称可查看。卡片不展示准备、上传、就绪或失败状态文字。读取和上传错误统一通过顶部反馈弹窗展示，一次失败仅通知一次；简短摘要与可展开详情分离。确定失败的附件保留重试与移除入口，结果未知时沿原核对流程，不提供重试。已有的图片预览、文本展开与移除入口保持可用。

## 示例

[组件目录与可操作实例](../../../../../renderer/design-system.html?ui-library#component-attachment-card)。真实业务路径沿原生产专项验证。
