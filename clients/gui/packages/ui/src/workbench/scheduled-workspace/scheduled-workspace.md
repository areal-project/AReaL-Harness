---
id: scheduled-workspace
title: ScheduledWorkspace
summary: 定时任务的紧凑状态分组、任务行与模板入口。
status: experimental
entry: experimental
layer: workbench
category: composition
aliases: ["定时任务工作区"]
related: ["button", "task-list-item"]
---

# ScheduledWorkspace 定时任务工作区

## 何时使用

跨项目浏览定时任务、选择已有任务或从模板创建。宿主管理目录、权限和原请求恢复；组件只展示提供的内容。

## 组成

Root 是容器，Group 按状态分组，Item 展示名称和一行计划摘要，Welcome 与 Template 提供轻量创建入口。搜索、筛选及读取失败动作由宿主插入侧栏。

TaskRow 是会话里的定时任务卡片（`variant="card"`）和右侧面板的单行（`variant="compact"`）：图标、名称、一行“规则 · 下次时间”、状态和操作槽。Status 是状态点加文字。操作菜单由宿主放进 `actions`，组件不发请求。

## 状态

`R-SCHEDULEDWORKSPACE-001` 已开启、已暂停、已结束；初次读取、部分结果、读取失败、无任务和搜索无匹配必须区分。未完成目录读取不得推断空态。正在创建保留原请求身份，不因切换界面重新创建。

## 内容

`R-SCHEDULEDWORKSPACE-003` 名称与下次运行时间优先；暂停和结束保留真实状态。任务名截断时 title 保留完整内容。模板是小图标加文字入口，避免大卡片形成视觉负担。

`R-SCHEDULEDWORKSPACE-006` TaskRow 只显示名称、规则与下次时间、状态三类信息；完整指令、工作目录和模型放进编辑或详情，不在卡片重复。状态限于已开启、运行中、已暂停、需要处理、已结束、已删除；需要处理必须由宿主给出原因（悬停或详情可读）。compact 变体在已开启时省略状态文字，操作在悬停、聚焦或菜单打开时出现。

## 规则

`R-SCHEDULEDWORKSPACE-005` 包不导入 Core 类型，不请求服务，不持有任务状态。宿主不能因隐藏加载诊断而删除目录完整性检查、重试和未知写入保护。

## 示例

[交互实例](../../../../../renderer/design-system.html?ui-library#component-scheduled-workspace)：切换有任务/空态，选择任务，按状态分组；生产适配见 TaskCenter。
