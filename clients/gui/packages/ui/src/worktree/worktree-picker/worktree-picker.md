---
id: worktree-picker
title: WorktreePicker
summary: 配置菜单行、同层返回页与键盘选项列表。
status: experimental
entry: experimental
layer: worktree
category: worktree
aliases: ["Worktree配置选择"]
related: ["worktree-status", "button"]
---

# WorktreePicker Worktree配置选择

## 何时使用

用于Composer内选择分支与环境。浮层定位、开关和返回焦点沿原宿主Popover。

## 状态

本地来源/新Worktree、分支/环境子页、查询空态、加载、失败、环境失效。宿主提供disabled与准确说明。

## 可访问性

`R-WORKTREEPICKER-004` 真实开关命名并禁用；选项有aria-selected与单个Tab入口，加载/错误不能选择。搜索由宿主标注，不用颜色代替选中。

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-picker)。

## Composer：上下文条与配置菜单

`WT-PICKER-01`（WT-R09）：入口在 Composer 上方的上下文条最右侧。左侧为项目文件夹 / 项目名、本机图标 / “此电脑”；齿轮独占尾部点击区域。上下文条与输入框组成同一视觉单元，不再加独立设置标题或外层卡片。长项目名优先截断，齿轮始终可达。

主菜单顺序固定如下；这是一组菜单行，不是纵向表单。

```text
配置本地环境                         次级标题
↗  新 Worktree                       [开关]
⑂  分支                   当前分支…    ›
⚙  环境                   未选择环境    ›
```

| 条件 | 呈现与动作 |
| --- | --- |
| `R-WORKTREEPICKER-008` 合法 Git 项目，新 Worktree 关闭 | 每个新会话默认关闭，不继承旧偏好；开关与三行均保留；分支显示当前来源；环境禁用。来源分支可以预选，但必须说明它仅影响新 Worktree，不在原目录 checkout |
| 新 Worktree 开启 | 分支与环境入口可用；无环境也是合法选择。开启、切换来源或选择环境只修改草稿，不创建目录 |
| `R-WORKTREEPICKER-009` 非 Git / 项目外模式 | 不提供可用的创建开关；若保留入口则给出“需要 Git 项目”的原因。环境始终是项目配置，不能从另一项目补值 |
| `R-WORKTREEPICKER-010` 读取选项中 / 失败 | 原值保留；读取状态在现有标题行内显示指示，并提供可访问的状态文字，不在底部临时增减占位行；首次读取与再次刷新均保持主菜单高度及齿轮锚点稳定。失败有明确重读入口，不能显示“无分支 / 无环境”冒充空集合 |

### 分支与环境子页

`WT-PICKER-02`（WT-R08）：进入分支选择时替换同一浮层的内容，齿轮锚点不变，不在第一层旁边再堆一个弹窗。顶部为返回按钮与“分支”，下方搜索，再是分组列表。选中行使用一个轻量背景和尾部勾；hover、focus 与 selected 分开表达。

- `R-WORKTREEPICKER-012` 当前来源、Local branches、Remote branches 只在有相应数据时出现。当前分支与选中起点不是同一含义，不能只靠蓝点区分。
- 搜索过滤可用分支；空查询、无匹配、读取失败三种状态分别呈现。列表有界纵向滚动，搜索和返回留在列表外；长名称可在聚焦或详情中读全。

`WT-PICKER-03`：环境子页沿相同的返回、选择、选中标记与滚动结构。首项“无环境”，随后仅列当前项目已保存环境；底部“配置环境…”进入设置的当前项目环境页。无环境时保留简短空态和配置入口，不要求用户先建环境才能发送。

`R-WORKTREEPICKER-015` 从配置入口进入设置保留项目、Prompt、附件、来源分支及选择。保存并返回后刷新同一项目的可选环境；已删除的选择显示失效并要求重新选择，不能静默换成另一环境。设置返回恢复该项目的合理入口与焦点，不自动发送。
