# D1（P0）：`@areal/ui` 入口分层（拆分 `wip`）

## 1. 背景与当前问题

- 原始评估时 `@areal/ui` 只有稳定入口（[index.ts](../packages/ui/src/index.ts)，12 条导出语句，都是 core 控件）和 `@areal/ui/wip`（历史 `src/wip.ts`，52 条导出语句）。迁移后入口见 [compositions.ts](../packages/ui/src/compositions.ts) 和 [experimental.ts](../packages/ui/src/experimental.ts)。
- 按 [包说明](../packages/ui/README.md)，`wip` 同时承担两种语义："实验入口"和"领域组合"（settings、conversation、workbench、worktree），另外还有不满 3 个消费者、尚未毕业的 core 控件。
- 矛盾：已经在 [Base](../design-system/base.md) 以 `frozen-beta` 状态准入的成员（`SettingsPage`、`SettingsSection`、`SettingsGroupCard`、`SettingsRow` 等）只能从 `@areal/ui/wip` 导入。入口名称暗示"不稳定"，Base 却声明"冻结"。
- 56 个生产文件引用 `@areal/ui/wip`。使用者和 Agent 没法从导入路径判断某个导出是稳定合同还是实验品，评审也无法判断一次修改是否破坏了冻结成员。

说明：这不代表这 56 个文件都在使用真正不稳定的 API。问题在于**入口语义混淆**，导致稳定性无法从代码中判断，也无法被工具约束。

## 2. 目标与非目标

目标：

- 入口按稳定性分层，导入路径本身就能表达稳定性。
- Base 准入成员与稳定入口之间的一致性由脚本保证。
- 实验入口在生产代码中的使用受到名单约束。

非目标：不在本任务内改动组件的实现和外观；不扩大 Base 准入范围。

## 3. 架构决策

| 决策 | 状态 | 内容 |
| --- | --- | --- |
| D1：三个入口 | 已定 | `@areal/ui`：core 控件（不变）；`@areal/ui/compositions`：领域组合，合同稳定，修改需遵循 Base 的兼容规则；`@areal/ui/experimental`：实验品和尚未毕业的控件 |
| D2：归属规则 | 已定 | Base 中状态为 `frozen-beta` 或更高的成员，必须从 `@areal/ui` 或 `@areal/ui/compositions` 导出；`experimental` 中不能出现 Base 成员 |
| D3：生产使用实验入口 | 已定 | 允许，但要在 `packages/ui/experimental-allowlist.json` 登记：导入文件、符号、负责人、毕业或删除的条件。名单只能缩减或在 PR 中说明理由后新增 |
| D4：`wip` 的过渡 | 已定 | 迁移期间 `./wip` 作为别名，同时导出两个新入口的全部内容并标注废弃；全部消费者迁移后删除 |
| D5：毕业规则 | 已定 | 沿用"core 控件被 3 个及以上生产文件使用后进入稳定入口"；领域组合在 Base 准入时进入 `compositions` |

## 4. 确定性路径

1. 新建 `src/compositions.ts` 和 `src/experimental.ts`，按 D1、D2 把 `wip.ts` 的 52 条导出逐条归类。归类依据 `registry.json` 的 Base 成员表；表格写进 PR 正文。
2. `package.json` 的 `exports` 增加两个入口；`wip.ts` 改为同时重导出两者的别名，并加上 `@deprecated` JSDoc。
3. 写一致性脚本（并入 `verify:design`）：
   - Base 成员 ⊆ `index.ts` ∪ `compositions.ts` 的导出；
   - `experimental.ts` ∩ Base 成员 = ∅；
   - 生产代码引用 `experimental` 的每个符号都在名单中。
4. 用 codemod 把 56 个文件的 `@areal/ui/wip` 导入改到新入口（只改导入路径，不改其他代码）。
5. 删除 `wip` 别名；更新 [包说明](../packages/ui/README.md)（中英）、[Agent 指南](../packages/ui/README.md)、`dist/components.json` 的生成逻辑和 `llms.txt`。

## 5. 不确定性路径

本任务不确定性低，需要人判断的只有一处：

- 某些导出目前处于"已在生产大量使用，但没有 Base 证据"的中间状态，比如有消费者但没有合同文档或状态验证。
- 处置：放进 `experimental` 并登记名单，同时在名单里标注"候选准入"。不为了让它进入 `compositions` 而临时补证据；准入按 [治理](../design-system/governance.md) 正常流程走。

## 6. 实施切片

1. PR-1：新入口文件、`exports`、`wip` 别名、一致性脚本。
2. PR-2：codemod 迁移全部导入。
3. PR-3：删除 `wip`，更新文档和生成物。

## 7. 验收标准

确定性：

- [ ] `grep -rl '@areal/ui/wip' renderer/src packages` 结果为 0（PR-3 后）。
- [ ] 一致性脚本通过；故意把一个 Base 成员移到 `experimental`，脚本失败。
- [ ] 生产代码引用 `experimental` 的数量等于名单条目数。
- [ ] `pnpm --dir clients/gui typecheck`、`verify:design`、`test:design` 全部通过。
- [ ] 构建产物 `dist/components.json` 为每个组件标注所属入口。

不确定性：

- [ ] 归类表（每个导出属于哪个入口及理由）经设计系统负责人确认。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md` 的 GUI 设计入口段落：导入路径表达稳定性；生产代码使用 `@areal/ui/experimental` 必须登记名单 |
| L2 Skill | `.agents/skills/gui-change/SKILL.md`：选组件时的入口判断（先 `@areal/ui`，再 `compositions`，最后才是 `experimental` 并登记） |
| L3 Lint | `no-restricted-imports`：禁止 `@areal/ui/wip`；禁止从 `@areal/ui/src/**` 深层导入；`@areal/ui/experimental` 由一致性脚本按名单管理 |
| L4 CI | 一致性脚本并入 `verify:design`，必跑 |
| L5 棘轮 | `experimentalImports`（down）、`wipImports`（down，目标 0） |

## 9. 风险与回滚

- codemod 漏改或改错：只改 import specifier；typecheck 会拦下符号不存在的导入。
- 回滚：PR-3 之前 `wip` 别名一直可用，任何阶段都可以回退。
