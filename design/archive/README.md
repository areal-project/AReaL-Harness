# 设计归档

这里保存已经完成或被取代的过程记录与调研材料，供追溯决策来源。它们不是现行规则：现行设计规则从[设计地图](../README.md)进入，GUI 规则与准入从 [GUI 设计入口](../../clients/gui/design-system/README.md)进入。

| 文件 | 内容 | 归档原因 |
| --- | --- | --- |
| [gui/delivery.md](gui/delivery.md) | 早期候选交付的范围与复验入口 | 已交付，现行准入以 Base 与 governance 为准 |
| [gui/roadmap.md](gui/roadmap.md)（[English](gui/roadmap.en.md)） | renderer 题到真实桌面的 Electron 旅程推进计划 | 计划已执行，后续计划归 [建设计划](../../clients/gui/design-system/roadmap.md) |
| [gui/component-migration.md](gui/component-migration.md) | 共享组件迁入 @areal/ui 的范围记录 | 迁移已完成，现状以 `@areal/ui` 的 components.json 为准 |
| [content/codex-typography-review.md](content/codex-typography-review.md) | Codex 桌面字体核对 | 结论已写入[基础表达角色](../foundations/roles.md) |
| [content/markdown-reuse-review.md](content/markdown-reuse-review.md) | Markdown 渲染复用评估 | 结论已写入[对话内容呈现系统](../../clients/gui/design-system/content-system.md) |
| [content/native-content-reference-review.md](content/native-content-reference-review.md) | 原生内容参考评审 | 同上 |
| [content/interactive-content-research.md](content/interactive-content-research.md) | 交互内容调研 | 同上 |
| [research/t3code-workbench-review.md](research/t3code-workbench-review.md) | T3 输入、对话流与 Thread 面板的源码清单、AReaL 对照及待评审指标 | 固定源码快照的研究证据，采纳范围待评审，不作为现行规则 |
| [research/t3code-comprehensive-comparison.md](research/t3code-comprehensive-comparison.md) | T3 对话状态、输入、资源面板、PR 与设备的功能对比及源码证据 | 扩大范围的研究快照，含前轮判断修正，不作为现行规则 |
| [research/codex-design-system-review.md](research/codex-design-system-review.md) | Codex 设计系统深度调研与 AReaL GUI 七大模块三阶段优化方案 | 外部调研对照与全模块实施蓝图，正式规则与 Token 按阶段写回所属主题 |

归档文件不再随实现更新。需要恢复其中的规则时，把规则写回所属主题，不在这里修改。

D5 的[迁移路径](d5/migrations.json)记录旧入口与新位置。[组件归属迁移](d5/contract-owner-migrations.json)保留现行规则的移动范围；这些合同仍在组件旁维护，没有作为历史证据归档。[研究与固定题目迁移](d5/observation-migrations.json)记录被后续生产接线取代的观察和冻结开发题。[实验协议](d5/experiment-protocol.md)区分待执行计划与实际 18 次结果。
