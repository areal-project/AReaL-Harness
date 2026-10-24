---
id: worktree-picker
title: WorktreePicker
summary: 配置菜单行、同层返回页与键盘选项列表。
status: experimental
entry: wip
layer: worktree
category: worktree
aliases: ["Worktree配置选择"]
related: ["worktree-status", "button"]
---

# WorktreePicker Worktree配置选择

## 何时使用

用于Composer内选择分支与环境。浮层定位、开关和返回焦点沿原宿主Popover。

## 组成

Root组合内容，不新增影响浮层高度的布局容器；Row组合图标/标签/当前值或实际开关；Page组合返回/搜索/说明；Options组合选项。API由同目录TS生成。

## 状态

本地来源/新Worktree、分支/环境子页、查询空态、加载、失败、环境失效。宿主提供disabled与准确说明。

## 行为

Options方向键/Home/End移动焦点，Enter/Space激活真实按钮。选择只通知宿主，不创建目录。查询、子页、Escape与焦点恢复由原WorktreeStarter维持。

## 内容

分支显示完整title，长名称省略时保留可读名称。仅从已提交版本创建的限制由宿主明确告知；不虚构当前改动复制能力。

## 可访问性

真实开关命名并禁用；选项有aria-selected与单个Tab入口，加载/错误不能选择。搜索由宿主标注，不用颜色代替选中。

## 规则

从@areal/ui/wip导入，样式使用worktree.css。包不请求选项、不读localStorage、不认识projectId或environmentRevision；旧请求归属与数据校验留原宿主。

## 示例

独立实例提供长列表、搜索、失败重试与选择。生产WorktreeStarter消费同一组合，保留原数据与Popover入口。

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-picker)。
