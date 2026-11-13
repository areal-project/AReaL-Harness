---
id: worktree-settings
title: WorktreeSettings
summary: 组合项目、环境、脚本与Action的既有设置布局。
status: experimental
entry: experimental
layer: worktree
category: worktree
aliases: ["Worktree设置组合"]
related: ["settings-page", "settings-section", "worktree-directory"]
---

# WorktreeSettings Worktree设置组合

## 何时使用

用于Worktrees General/Environments的目录管理和环境编辑。继续组合既有SettingsPage/Section/Row。

## 组成

Root、Breadcrumb、Project、Environment、Script、Action。平台Tabs、输入、变量Popover和保存动作由宿主作为内容传入。

## 示例

[组件目录](../../../../../renderer/design-system.html?ui-library#component-worktree-settings)。

## 设置：页面骨架与 General

`WT-SETTINGS-01`（WT-R01、03）：设置导航只有 Worktrees 一个入口。页面标题“Worktrees”，简短用途说明，下方 General / Environments 两个轻量导航标签。刷新作为标题区的尾部图标动作，具名且不清空当前编辑。两页共用相同起始边缘和内容列。

### General

顶部“创建与清理”区只有一个设置组，按下面的顺序排列；组内使用轻分隔和共享右对齐控件。

| 行 | 标签 / 说明 | 控件 |
| --- | --- | --- |
| 创建前获取上游 | 准确描述 fetch；不承诺自动合并 | 右侧开关 |

### 按项目管理目录

组件专属合同由[WT-LIST-01 等规则](../worktree-directory/worktree-directory.md#按项目管理目录)维护。

## 设置：Environments 与环境编辑

`WT-ENV-01`（WT-R01）：Environments 默认是项目列表。顶部“选择项目”，右侧“添加项目”沿现有项目添加入口；它不创建一个同名环境。每行项目图标、项目名、必要的归属说明、尾部添加 / 进入入口。点击项目进入其环境列表，已有环境按名称列出，并有“新建环境”。这个中间层为多环境场景的设计决定，不由图 1 的加号推断已存在。

`WT-ENV-02`（WT-R02、07）：编辑内容自上而下为页面标题 → 名称组 → Setup script → Cleanup script → Actions → 保存。

| 区域 | 组成与对齐 |
| --- | --- |
| Cleanup | 标题、执行说明、独立的三平台标签、代码输入；与 Setup 的左边缘、编辑器宽度和节奏一致 |

`R-WORKTREESETTINGS-016` Setup 与 Cleanup **各自拥有当前平台标签**；切 Setup 到 macOS 不改变 Cleanup 或 Action 正在编辑的平台。切换标签保留未保存的其他平台文本。空覆盖回退 Default 的真实规则就近说明；标签不以“空”冒充“禁用”。代码输入使用单一边框和等宽字体，候选最小高度为六行代码的行高加内边距，可增长 / 纵向滚动，不能横向撑宽页面。

Variables 入口打开小型只读说明，列出 `AREAL_WORKTREE_PATH`、`AREAL_PROJECT_PATH`、`AREAL_WORKTREE_BRANCH` 的含义与可复制名称；不显示截图的 `CODEX_*` 变量，不诱导填写凭据。主执行位置为新 Worktree 的项目根；保存脚本不执行脚本。

### Action 的有限形态

`WT-ACTION-01`：已有 Action 行以名称为主、必要的命令摘要为次，尾部“编辑 / 删除”；添加或编辑在所属行下展开名称与脚本，沿同样的平台标签规则。不要让每个 Action 常驻三个大编辑器。顺序沿已保存配置，删除仅移除配置；运行入口在会话工作区详情，不能把设置里的“保存”变成运行。
