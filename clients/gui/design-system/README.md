# AReaL GUI 设计系统

这是维护者入口。写页面、选组件和写样式从 [@areal/ui](../packages/ui/README.md)进入。跨产品原则、术语和设计决策从[设计地图](../../../design/README.md)查阅。

## 当前阶段

`R-ENTRY-001` 当前准入范围、冻结版本和限制以 [Base](base.md)及 [registry.json](registry.json)为准。当前实现从[生产目录](inventory.md)与组件就近合同查找。已运行的验证与研究记录归[归档](../../../design/archive/README.md)，不能据此扩大准入。

## 开工顺序

2. `R-ENTRY-047` 修改公共规则或准入时，查[规则登记](rule-registry.json)找到唯一正文所有者。新增规则登记 ID、owner 和必须、默认或可探索强度。其他文档引用 ID。组件参数和数值继续由真实源码拥有。

规则定义、引用、文档盘点和入口字节预算由 `node scripts/design-rules.mjs` 检查。`rule-registry.json`记录规则身份，`document-inventory.json`记录四类文档和迁移去向。字段与校验边界见[规则维护](rule-maintenance.md)。

## 按问题读取

| 问题 | 唯一所有者 |
| --- | --- |
| 人、Agent、审批与交接 | [人与 Agent](../../../design/people-and-agents/README.md) |
| GUI 交互族及规则强度 | [交互模式](interactions.md)（[English](interactions.en.md)） |
| Token 与布局接线 | [基础规则](foundations.md) |
| 设置、对话、审批和详情组合 | [页面模式](patterns.md) |
| Worktree 配置与环境 | [Worktree 合同](worktrees.md) |
| 组件、模式及准入范围 | [目录](inventory.md)、[Base](base.md) |
| 设计变化、证据与完成 | [治理](governance.md) |
| 检查、生成与已知静态边界 | [自动化](automation.md) |
| 无障碍准入 | [无障碍验收](accessibility.md)（[English](accessibility.en.md)） |

## 预览与检查

`R-ENTRY-003` 从仓库根运行 `pnpm --dir clients/gui design:dev`，打开 `/design-system.html`。预览挂载生产组件与本地 fixture，不连接 Core 或供应商。常规设置会读写当前 origin 的 localStorage，验收使用隔离浏览器上下文。服务操作不可用。展示 fixture 不表示真实业务支持未知提交。

```sh
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
```

目录或 Token 源改变后运行 `design:sync`，UI 包基础值还需 `pnpm --dir clients/gui --filter @areal/ui generate`、`build` 和 `check`。生成产物从原脚本重建。具体测试选择与静态覆盖以[自动化](automation.md)和[完成条件](governance.md#完成条件)为准。

## 权威与冲突

`R-ENTRY-005` 当前用户决定优先。规范与代码不符时，明确指出差异并修正拥有该事实的来源；不能选一个相近数值、复制局部样式后声称已统一。

`R-ENTRY-006` Codex 是桌面视觉与交互的第一参考；截图只证明所采状态，不授权复制它的产品能力、品牌或平台尺寸。参考观察不能覆盖本仓执行、权限与历史合同。
