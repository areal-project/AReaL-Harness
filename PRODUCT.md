# AReaL Harness 产品上下文

<!-- impeccable:product-schema 1 -->

## Platform

web

当前设计重点是 Electron + React 桌面 GUI；`web` 是 Impeccable 对该界面技术的分类。桌面窗口、原生视图和系统交互仍遵循 Electron 与宿主平台的约束。Web 客户端按自身能力复用适用设计；CLI、TUI 不在 GUI 设计系统的建设与验收范围内。

## Users

主要用户是使用 Agent 完成开发与复杂工具任务的开发者。他们在项目工作区中提出任务、补充上下文、检查执行过程、处理审批，并审查最终结果。

## Product Purpose

AReaL Harness 是面向工具执行与多 Agent 协作的模块化框架。通过可组合 Core、独立 Runtime、持久会话和多 Agent 协作，帮助用户推进可检查、可恢复的长任务。

成功意味着用户能理解任务当前状态，在需要时介入，并依据实际结果和验证证据判断任务是否完成。

## Positioning

产品以 Clients → Core → Runtime 分层组织交互、权威执行与工具运行。客户端呈现任务并提供控制入口；Core 管理执行与历史；Runtime 承担工具执行、资源限制与清理。多 Agent 协作和长任务延续建立在这些共享边界上。

具体契约由[架构文档](docs/design/architecture.md)维护，能力与限制由[能力清单](docs/features.md)维护。

## Operating Context

- 用户围绕实际项目工作区使用对话、文件、Diff、终端、模型设置和工具能力。
- 典型流程是提交任务、阅读过程、补充输入或处理审批、检查变更与验证结果，随后继续或恢复会话。
- 开发版、安装包、确定性本地模型和真实供应商具有不同的验证边界；一种环境的成功不能替代另一种环境的验收。
- 桌面 GUI 是当前设计系统的优先建设对象；Remote Web 与本地 Web 的接线和复用范围见[设计地图](design/README.md)。

## Capabilities and Constraints

- Core/Runtime 拥有执行与历史事实；Renderer 负责交互呈现，不承载 Agent 执行循环或读取已保存凭据。
- 恢复使用权威快照。不确定是否受理的提交保留不确定状态，不自动重放；停止受理与后台终止分别表达。
- 界面应清楚区分运行、审批、恢复、失败与完成，并让用户找到相应操作和结果证据。
- 能力是否实现、是否接入 GUI、是否通过真实路径验收分别判断；界面预览不构成产品能力证明。
- 当前平台、发行、模型和工具限制以[能力清单](docs/features.md)及对应契约为准，不在本文件重复维护易变清单。

## Brand Commitments

- 使用 AReaL Harness 产品名称和仓库现有品牌资产；奶茶标志见 `docs/assets/milk-tea-logo.svg`。
- Codex App 是桌面视觉与交互的第一参考；参考观察不扩大本产品的能力或权限边界。
- 沿用现有应用、供应商图标和设计系统。视觉规则由[设计地图](design/README.md)与[GUI 设计入口](clients/gui/design-system/README.md)维护。
- GUI 文案维护简体中文和英文，使用清楚、可操作且与执行事实一致的表达。

## Evidence on Hand

- [README](README.md)：产品简介、入口与现有品牌资产。
- [能力与边界](docs/features.md)：已实现能力及明确限制。
- [架构](docs/design/architecture.md)：分层与所有权。
- [人与 Agent](design/people-and-agents/README.md)：控制、审批、委派、交接与证据的产品含义。
- [GUI 设计系统](clients/gui/design-system/README.md)：生产组件、规则和验证入口；预览证据与真实业务验收分别使用。

## Product Principles

1. 围绕用户任务组织信息，让用户能理解进展、介入过程并检查结果。
2. 执行事实优先；呈现状态和恢复操作依据权威历史与回执。
3. 长任务与多 Agent 协作保持可追踪、可检查，明确用户控制与审批入口。
4. 复用既有设计与共享契约，由现有所有者维护规则，减少重复定义。
5. 以可观察的用户路径和验证证据判断完成，明确各环境的验收边界。
