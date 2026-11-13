---
id: task-context
title: TaskContext
summary: 顶部按钮打开的任务上下文卡片，组织变更、项目、子任务和输入来源。
status: experimental
entry: experimental
layer: conversation
category: context
aliases: ["任务上下文卡片"]
related: ["subagent-panel", "image-disclosure", "disclosure"]
---

# TaskContext 任务上下文

## 何时使用

`R-TASKCONTEXT-001` 需要核对当前工作涉及的对象或输入时，从对话顶部按钮打开。它是任务上下文卡片；文件、网页或子任务历史的阅读器是另一用途。

## 组成

具名 aside、标题、actions、可选返回、纵向滚动正文；Section 分区及次级标题，Item 统一图标/头像组、命名动作与尾部元信息，Sources 负责三项预览/查看全部/添加入口。id、hidden 和 onKeyDown 由宿主接线。

## 规则

`R-TASKCONTEXT-007` 来源默认最多三项，超过提供带总数的全部入口。onAdd可选；宿主没有合法添加动作时不渲染加号，不能用空回调伪装能力。宿主拥有数据、草稿与导航，组件不扫描项目、维护 Core 状态或读取凭据。

## 示例

[组件目录与生成API](../../../../../renderer/design-system.html?ui-library#component-task-context)；[生产顶部入口预览](../../../../../renderer/design-system.html?task-context)；[对话组合](../../../../../renderer/design-system.html?conversation-system)。文档站会嵌入该组件的独立可操作示例，原文与实现同目录，Props不另抄一份。

## 右侧任务上下文

`R-TASKCONTEXT-009` 顶部按钮打开的任务上下文卡片回答“当前工作涉及什么”。顺序为当前工作归属与 Changes → 关联项目 → Subagents → Sources。它与中间时间线共用对象身份：时间线按发生顺序叙事，卡片按对象整理入口，不能分别维护一份执行事实。

| 区块 | 摘要形态与内容 | 用户动作与范围 |
| --- | --- | --- |
| `R-TASKCONTEXT-010` Changes / 变更 | 当前项目名称、明确的变更范围、文件数及可信增删统计 | 打开原 Diff/变更面板；工作区变更可能包含用户或其他任务修改，不能全部归为本 Agent 产出 |
| `R-TASKCONTEXT-012` Subagents / 子代理 | 用户要求有列表；设计默认：摘要展示有限头像与按真实状态分类的计数，展开为具名任务列表 | 打开同一个子对话；失败、待决定、未知与运行中状态可见，不能用“11 done”概括混合状态 |

### Sources 管理输入

| 条目组成 | 规则 |
| --- | --- |
| 身份与类型 | 使用原 URI、资源 ID 或引用身份；显示图片/网页/文件等类型，不只凭文件后缀判断 |
| 可识别名称 | 文件名、页面标题或可理解的名称为主；路径/域名为辅助。无标题时展示已有定位信息，不补造名称 |
| `R-TASKCONTEXT-021` 预览与打开 | 图片可预览，网页交给原浏览器/链接入口，文件交给原文件阅读器；不可读取时保留名称与状态 |
| 查看全部 | 超过三项才出现；完整列表在有界区域纵向滚动，支持返回三项预览；零项显示简短空态与可用添加动作 |
| 添加与移除 | “+”沿原附件/引用能力进入主草稿，发送前可移除；不静默写入正在执行的上下文。已发送历史只读，移除草稿引用、释放上传与删除资源是不同动作 |
