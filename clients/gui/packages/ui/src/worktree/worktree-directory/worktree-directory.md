---
id: worktree-directory
title: WorktreeDirectory
summary: 按项目分组目录身份、展开详情与删除反馈。
status: experimental
entry: experimental
layer: worktree
category: worktree
aliases: ["Worktree目录列表"]
related: ["worktree-settings", "button"]
---

# WorktreeDirectory Worktree目录列表

## 何时使用

用于Worktrees General的已管理目录清单。它呈现原记录，不承担Git或文件系统管理。

## 组成

Root、Group和Item。Item接收name、受控open、details children、删除意图回调和宿主操作状态。

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-directory)。

### 按项目管理目录

`WT-LIST-01`：设置组下方留区块间距，呈现一个紧凑列表，而不是每个项目一张大卡片。项目头行用文件夹图标与项目名；其下工作区行按相同缩进排列：层级入口 / 可识别名称 / 弹性空间 / 查看详情或删除。

- `R-WORKTREEDIRECTORY-007` 名称优先使用绑定会话标题，其次为分支，再无名称时使用短标识。完整路径、分支、环境、状态在展开详情中可读，不能只藏在不可复制的 tooltip。短标识不取代真实身份。
- 行首 Chevron 表达目录层级展开；选中 / 展开 / hover 是三种状态。纯图标删除按钮具名，hover 和键盘聚焦时可辨，不依赖红色小图标解释后果。

页面只有一个主纵向滚动区；目录列表随页滚动，详情中的短字段不额外套独立滚动容器。
