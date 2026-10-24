# v1 候选交付与复验

本页保留早期候选的探索记录。当前有限 Base 的版本、成员、实现来源与兼容规则以 [Base](base.md)为准，已完成运行见[证据索引](base-evidence.md)，整体阶段见[建设计划](../../../design/roadmap.md)。早期探索不替代冻结后的独立复用实验。

## 早期候选探索记录

本轮有界目标已形成可审阅版本：围绕 AReaL 的设置、内容与决策任务，先固定架构与所有者，再准入 Base候选，随后通过设置与内容/决策探索题检查并修正。v1指规范和目录的首版；Base当前为候选0.1.3，正式冻结、盲测和用户视觉接受分别保留。

## 已落地的约束

| 交付 | 如何减少页面自由发挥 | 事实与边界 |
| --- | --- | --- |
| 架构与职责 | 精确值、控件、组合、业务状态各回唯一所有者 | renderer数值和主题仍归既有源码；不是全仓统一完成 |
| 单源目录 | 角色/组件/模式只能引用现有生产源 | 24组件、6模式、28个Token名；目录不复制数值 |
| 生成与校验 | catalog和文档生成区同步，拒绝缺槽位/状态及非法引用 | 4个页面合同；不是自动证明JSX依从 |
| Base候选0.1.3 | 限定5基础控件、14组合、2模式及代表状态 | 不把所有目录成员视为已验收Base |
| 固定题与独立证据 | 先固定内容、条件、反证，再运行并归因 | 同会话探索，非盲测；原图和私有材料留本地 |

来源与取舍见[自动化](automation.md)、[参考](references.md)；做页面按[入口顺序](README.md#开工顺序)选择模式与生产组件。没有适用模式时，写清真实缺口再修改公共所有者，不新增页面Token或复制控件CSS。

## 反馈如何进入公共系统

- [设置迁移题](exercises/settings-reflow.md)：同内容Codex对照暴露控件紧凑档歧义，在共享 SettingsSelect 和预览开关选择处修正；窄容器长文案继续遵循既有上下排列规则。
- [设置说明题](exercises/settings-contrast.md)：核对参考明暗和对比度端点后，只提高深色设置说明默认层级；浅色、偏好斜率、自定义颜色及其它角色保留。
- [内容/决策题](exercises/decision-transfer.md)：验证已有Base组合承载另一类任务。长内容保留全文，窄卡参数可滚动到末尾，回执后仍等待权威状态；失败、处理中、未知分别呈现。该题没有引出新的生产样式或Base改值。
- [对话动态题](exercises/conversation-flow.md)：Codex参考已关联正文增长、可见阅读锚点、返回最新录像和独立工具状态；回溯出的七条规则接入P-CONVERSATION及[结构化输入](surfaces/conversation-flow.json)。本地逐步投影题已驱动共享过程组迁移，Base0.1.3仅增加已复验的过程/阅读组合；完整对话模式、资源宿主和真实执行仍有缺口。

这条反馈链借鉴 REA 的问题/观察/反证、步骤连续性、材料有效性与未知保留，不安装另一套证据平台。原始证据只关闭其实际表面和状态的问题；生成脚本不自动升级视觉基线。

## 复验

从仓库根运行：

```sh
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
pnpm --dir clients/gui test:design --settings-exercise
pnpm --dir clients/gui test:design --settings-contrast
pnpm --dir clients/gui test:design --decision-exercise
pnpm --dir clients/gui test:design --conversation-exercise
node clients/gui/scripts/verify-public.mjs
python3 scripts/check-docs.py
```

开发预览入口为 `design-system.html`，题目查询分别为 `?settings-exercise`、`?decision-exercise`与`?conversation-exercise`。runner返回每次隔离run的材料目录；manifest绑定commit/工作树差分、构建资产、浏览器、实际条件、步骤、原图哈希及失败诊断。不是重新执行就自动替代既有失败证据。

## 仍然明确保留的限制

CSS审计只有列明的4个文件；没有全仓JSX依从阻断。当前代表组合不证明所有平台、任意自定义主题、真实Core/Runtime、供应商或安装包。Codex参考覆盖已采集的设置与对话状态；对话规则的声明检查不证明AReaL动态实现，内容/决策题没有同状态Codex目标，不能声称该场景保真。

本轮到此收敛，不批量重写业务页或继续无界采集。后续由具体页面需求触发增量迁移；正式Base冻结或独立盲测需明确范围及判据，用户保有最终视觉验收权。已授权的Codex CDP实例与profile继续长期保留，结束心跳不结束该应用。
