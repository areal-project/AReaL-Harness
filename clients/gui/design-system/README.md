# AReaL GUI 设计系统 v1

**只是使用设计系统**（写页面、选组件、写样式）：读 [@areal/ui](../packages/ui/README.md) 与 [Token 速查](../packages/ui/src/generated/tokens.md) 即可，规则的理由在 [design/](../../../design/README.md)。本目录下面的内容面向维护者：交互分类、页面合同、Base 准入、证据与自动化。

GUI 设计知识与后续 Web 复用边界从[设计文档](../../../design/README.md)进入。本目录保留 GUI 设计与 Agent 实现合同。目标是让同类任务得到同类页面：先选已有组合与控件，再填入业务内容。适用于桌面 renderer；Remote 复用组件时遵循同一展示合同，原生平台适配仍归各自所有者。

## 当前阶段

[UI 包与架构](../renderer/design-system.html?ui-library)展示首批私有 workspace 包、生成基础值、真实组件合同、类型与 Agent 索引。采用或修改包内基础能力前读 [Agent 指南](../packages/ui/agent-guide.md)；边界与取舍见 [D-004](../../../design/decisions/004-local-ui-package.md)。其余模式、组件和 Base 沿本目录继续维护。

下一轮整体设计方向见[设计系统建设计划](../../../design/roadmap.md)。该计划基于 AReaL Harness 当前产品任务和生产代码，明确整体候选、产物及迁移顺序，不扩大当前 Base 准入。

先读[设计系统架构](architecture.md)：架构 → Base → 固定题目 → 比较与改进。当前交付包含规范、可运行目录、有限 Base 和固定输入的独立复用结果。版本、冻结状态与具体范围以 Base 为准，不把早期探索题等同于独立验证。下列规则作为现有生产约束与候选模式的入口，具体准入按架构阶段执行。

当前最小实现范围见 [Base 当前范围](base.md)：只准入有真实组件与代表状态验证的基础切片，不把整个目录等同于 Base。

本轮交付、复验入口与范围见[候选交付](delivery.md)。对话信息流从[证据→规则→所有者→检查点](patterns.md#从证据回溯到规则和组件)进入；其[结构化合同](surfaces/conversation-flow.json)已可校验，逐步投影预览及共享过程组已实现，只有列明且已复验的过程/阅读组合进入 Base，完整对话模式仍保留准入缺口。

两张用户标注图对应的[对话流设计候选](conversation-flow.md)定义活动行、默认折叠、纵向滚动及右侧 Changes、关联项目、Subagents、Sources。[独立交互预览](../renderer/design-system.html?conversation-system)支持运行/完成/待关注、来源数量、图片查看和窄窗返回；沿现有系统与 Raft 分层组织，生产对话已采用同一包内组件，接线与验收范围见[对话流规范](conversation-flow.md#生产接线)；Base范围不自动扩大。

九张用户参考图对应的[Worktree 设计规范](worktrees.md)定义 Composer 配置菜单、准备过程、侧栏身份，以及 General / Environments 的布局与状态。生产组合已迁移，代表状态的[视觉对照与交互验收](exercises/worktrees.md)分别记录 renderer 与真实桌面范围；不扩大 Base。

后续从 renderer 题推进到真实桌面的覆盖、顺序和停止条件见[Electron 旅程推进计划](roadmap.md)；该计划与已通过证据分别维护。

共享组件的迁移范围与保留适配见[组件迁移](component-migration.md)。原路径消费同一包实现；后续外观和交互微调先改包内组件及就近MD，再验证实际产品路径。

## 开工顺序

新增或修改页面、组件、布局、样式、动效、UI 文案时：

1. 写清用户任务，先从[用户交互模式](interactions.md)选主要交互族及规则强度，再从[页面组合](patterns.md)选模式与[生产目录](inventory.md)中的所有者，读取适用的[基础规则](foundations.md)及[控件合同](../DESIGN_SYSTEM.md)。
2. 按[证据驱动设计流程（B路线）](structured-flow.md#执行顺序与每步完成条件)固定页面合同、参考和验收条件。动态页面先做视频候选分析、关键帧/日志核查与差异裁决，再修改已确认的缺口；静态小改动按该流程复用有效证据。
3. 沿原所有者实现并重放受影响状态，按[准入与完成条件](governance.md)回写唯一规则位置。交付模式、采纳/拒绝的差异、实际验证与缺口；模型建议和生成页面均经过相同准入。

系统级数据维护在 [registry.json](registry.json)，页面级数据按 [结构化实现流程](structured-flow.md) 引用它；[自动化机制与来源](automation.md) 解释生成链和当前检查边界。

新增生产 UI 文件由[增量设计检查](automation.md#增量设计检查)自动纳入；交付按[完成条件](governance.md#完成条件)报告复用、例外、状态与证据。

## 按问题读取

| 问题 | 唯一规则位置 |
| --- | --- |
| 人、Agent、审批与交接的含义是什么 | [人与 Agent](../../../design/people-and-agents/README.md) |
| 共享的控件选择、阅读与反馈怎样组织 | [组件](../../../design/components/README.md)、[交互模式](../../../design/patterns/README.md) |
| 按用户意图选 GUI 交互类别、必须/默认/可探索规则、处理例外 | [interactions.md](interactions.md)（[English](interactions.en.md)） |
| 字体、色彩、层级、尺寸、密度如何选 | [foundations.md](foundations.md) |
| 设置、资源列表、对话、审批、详情怎么组成 | [patterns.md](patterns.md) |
| Worktree 配置、准备、目录与项目环境怎样对齐参考图 | [worktrees.md](worktrees.md) |
| 已有什么、由谁实现、哪些仍未统一 | [inventory.md](inventory.md) |
| 新变体、例外、截图与验收如何进入 | [governance.md](governance.md) |
| 自动化如何工作、哪些已接入 | [automation.md](automation.md) |
| 页面设计、视频分析、关键帧核查与差异筛选的默认顺序 | [structured-flow.md](structured-flow.md) |
| 设计依据、参考观察与采纳如何记录 | [references.md](references.md) |
| Token 名、组件接口与预览命令 | [现有实现指南](../DESIGN_SYSTEM.md) |

## 权威与冲突

- 本目录规定用途、组合和准入；现有实现指南保留控件语义、长文本及预览操作细节。相同规则只在一个位置维护。
- 精确值与主题派生以生产 CSS 和外观设置为准；组件参数以实际导出为准。文档描述目标不等于代码已迁移。
- Codex 是桌面视觉与交互的第一参考；截图只证明所采状态，不授权复制它的产品能力、品牌或平台尺寸。参考观察不能覆盖本仓执行、权限与历史合同。
- 当前用户决定优先。规范与代码不符时，明确指出差异并修正拥有该事实的来源；不能选一个相近数值、复制局部样式后声称已统一。

## 目录与完成边界

本目录只放内部规范与稳定目录。已迁入的基础值、纯组件与就近MD归 `packages/ui/`；未迁入Token和主题偏好继续归原renderer所有者。共享控件与设置、对话、工作台组合使用包内导出，原路径保留适配；编辑器、模型权限、提交、导航守卫与配置保存仍由原业务模块拥有。预览继续放 `renderer/src/design-system/`，组件目录展示同一包的合同、API和独立状态实例。原始截图、DOM 与运行 manifest 保存在本地证据目录，不复制用户数据到公开源码。

目录提供有限选择和增量迁移约束。Base 冻结仅对应其列明范围，不代表全仓视觉已经统一。当前缺口集中在[目录状态](inventory.md#覆盖与缺口)；本次不批量重写业务页，不引入另一套组件库或 Token 生成链。

交互分类是规范入口，既有 P-* 是组合示例，不是互斥页面类型。首个生产迁移见[设置阶段一](exercises/settings-stage1.md)，视觉审查与第二阶段泛化验收分开。

真实生产对话的第二次迁移见[对话阶段二](exercises/conversation-stage2.md)：发送、命令、子代理和面板返回的旧新版同状态证据，视觉审查与完整模式准入分开。

主会话、Side、Panel 与设置的公共路径见[共享工作区](exercises/shared-workspace.md)（[English](exercises/shared-workspace.en.md)）。目录记录有限变体与所有者，生产验证和视觉准入分别判断。
