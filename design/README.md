# AReaL 设计文档

这里是 AReaL Harness 的设计地图，供设计师、客户端工程师和 Agent 使用。从用户任务进入，找到负责该判断的唯一文档，再前往实现与验证位置。

本目录是设计规则的源头，[@areal/ui](../clients/gui/packages/ui/README.md) 是它的实现：改变外观的修改同时更新这里的规则与理由；两者不一致时修改其中之一，不让它们并存（[P5](principles/README.md#p5-共享规则只维护一次)）。写代码时从 @areal/ui 的说明和 [Token 速查](../clients/gui/packages/ui/src/generated/tokens.md) 开始。

设计系统以桌面 GUI 为准，先完成 GUI 的视觉、交互与生产迁移。后续 Web 复用适用的设计原则、Token、组件和模式，并按浏览器能力适配。TUI、CLI 不在本设计系统的建设与验收范围内。设计知识仍集中在根目录 `design/`，范围取舍见[D-001](decisions/001-shared-design-knowledge.md)。

本目录只维护中文。外部使用与 API 文档由 `docs/` 维护。文档归档不改变产品行为、GUI Base 准入或视觉基线。

## 设计知识地图

| 目录 | 回答的问题 | 维护边界 |
| --- | --- | --- |
| [设计原则](principles/README.md) | 为什么这样设计，怎样取舍 | GUI 的设计理由，具体规则指向所属主题 |
| [设计基础](foundations/README.md) | 颜色、文字、空间、图标和动效怎样表达 | [表达角色](foundations/roles.md)说明用途，[Token 地图](foundations/tokens.md)指向真实数值源 |
| [内容与文案](content/README.md) | 对象怎样命名，动作与状态怎样表达 | 界面用词建议，引用人机关系与执行事实 |
| [人与 Agent](people-and-agents/README.md) | 谁负责工作，人控制什么，结果依据什么 | 身份、控制、审批、委派、交接、上下文与证据的产品含义 |
| [交互模式](patterns/README.md) | 用户怎样完成一个完整任务 | [意图地图](patterns/intents.md)、过程阅读、深入查看、设置、反馈与恢复 |
| [组件与组合](components/README.md) | 该选什么组件，谁维护接口与行为 | 控件选择与职责，链接真实合同和 GUI 生产示例 |
| [产品与工作台](products/README.md) | 完整路径的信息放在哪里，怎样进入与返回 | 当前桌面工作台与预览、真实控制器的边界 |
| [设计决策](decisions/README.md) | 已经选择什么，何时重新评估 | 一项重要取舍一篇记录，状态在该记录中维护 |

[设计系统架构](architecture.md)说明知识、实现与验证如何依赖。[建设计划](roadmap.md)维护当前缺口、下一步产物与完成条件。具体工作先选主题，只有改变跨主题职责时才回到架构与决策。作者流程见[修改设计文档](contributing.md)。

## 阅读与预览

打开 `/design-system.html?dashboard` 查看建设看板，了解目标、当前阶段、下一步与验证边界。看板是带日期的来源摘要，具体计划与准入仍由原文档维护。

从仓库根运行 `pnpm --dir clients/gui design:dev` 打开现有预览。文档入口使用 `?docs=design/README.md`，内容和示例仍由各自所有者维护。`pnpm --dir clients/gui design:build` 检查预览构建。组件合同与真实示例从[组件目录](components/README.md)进入，预览证据的边界见[工作台](products/workbench/README.md#预览与真实路径分别核对)。

完整体验从[工作台候选](products/workbench/candidate.md)进入，打开 `/design-system.html?product-candidate` 连续体验提交、过程、审批、资源与设置。

## 客户端地图

| 客户端 | 现有设计与实现入口 | 平台责任 |
| --- | --- | --- |
| 桌面 GUI | [GUI 设计入口](../clients/gui/design-system/README.md)、[组件指南](../clients/gui/DESIGN_SYSTEM.md)、[生产目录](../clients/gui/design-system/inventory.md) | React 控件、布局、窗口与原生视图的适配和准入 |
| Remote Web | [RemoteWorkbench](../clients/gui/renderer/src/remote/RemoteWorkbench.tsx) | 复用的 GUI 组件，以及浏览器权限和偏好边界 |
| 本地 Web | [界面](../clients/web/app.js)、[样式](../clients/web/style.css) | 独立 Web 实现及主题偏好，不等同于 Remote Web |

Web 两行记录现有接线，供后续复用时核对，不表示完整设计系统已经接入 Web，也不构成当前 GUI 交付的前置条件。

## 唯一维护位置

GUI 的设计含义在本目录维护。GUI 实现规则引用这些含义，并拥有组件、数值、规则 ID、布局和准入。Web 复用时只补浏览器适配与验证。Core、Runtime 及已有服务契约仍拥有执行、权限、恢复与历史事实。

新增要求先判断归属。修改设计含义时更新对应主题；移动正文时同步迁移引用并删除旧定义。原始取证与平台运行报告留在原位置，目录存在不证明 GUI 或 Web 已经实现或验收。
