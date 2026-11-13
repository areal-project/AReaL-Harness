---
name: areal-ui-guide
description: 在 AReaL GUI 里新增或修改组件、页面、样式、Token 或设计规则前使用。给出阅读顺序、本仓库的纠正先验表和组件迁移步骤。
---

# 使用 @areal/ui

本 skill 随 `@areal/ui` 一起维护，内容以当前分支的代码为准。审查已经做完的界面时改用 `areal-ui-critique`。

## 阅读顺序

1. [包说明](../../README.md)：入口、分层与成熟度。
2. [Token 入口](../../token-reference.md)：变量名与用途；数值只在 `tokens.json`。
3. 所选组件旁的合同 `src/**/<组件>.md`：何时使用、状态、键盘与规则。
4. 改共享规则、准入或生成器时，再读[维护者入口](../../../../design-system/README.md#开工顺序)。

文中 `node scripts/…` 都在 `clients/gui` 目录下运行。组件清单在 `pnpm --filter @areal/ui build` 后的 `dist/llms.txt` 与 `dist/components.json`。

## 纠正先验

下表列出 agent 在本仓库里真实犯过的错。左列是常见直觉，右列是这里的做法。

| 你的直觉 | 在这里的做法 |
| --- | --- |
| 在组件 CSS 里写 `16px`、`#888`、`300ms` | 引用 Token；缺 Token 时先加到 `tokens.json`，再运行 `pnpm --filter @areal/ui generate` |
| 给 `@areal/ui` 组件传颜色、间距类或 `style`，或在页面 CSS 里选 `[data-slot=…]` | 页面只给布局类；外观差异加成组件的 variant 或 slot。`node scripts/restyle-lint.mjs` 拦截新增（R-CHECK-022） |
| 在 `workbench.css` 里用 `.turn-execution .areal-activity-*` 调组件外观 | 给组件加部件或 Token，宿主只管布局 |
| 给组件加 `kind="explore" \| "command"` 这类万能开关 | 用组合部件表达结构，如 `ActivityRow` + `ActivityRowText` + `ActivityRowStatus` |
| 在 md 正文里写数值（如“列表限高 224px”） | 写 Token 名（`--activity-list-max-height`），数值只在 `tokens.json` |
| 手改 `rule-registry.json` 的哈希、标题或 owner | 改合同正文后运行 `node scripts/design-rules.mjs --write` |
| 在 md 里手写行为示例表 | 改行为表（如 `activity-runs.cases.json`），再运行 `node scripts/design-generated.mjs --write` |
| 把外部画布或截图里的数值当来源 | 画布只用于讨论，定下的数值写进 `tokens.json` |
| 行内按钮用宿主 CSS 随悬停显隐 | 一律用 [HoverActions](../../src/components/hover-actions/hover-actions.md)；打开态用 `[data-popup-open]`，不要写 `[data-state="open"]` |
| 只跑 `verify:design` 就说界面没问题 | 再跑 `design:build` 和 `test:design`，视觉结论以浏览器检查为准 |

## 规则放在哪里

| 位置 | 放什么 |
| --- | --- |
| 仓库根 `AGENTS.md` | 八条全局判断，十几行以内 |
| 本 skill 与 `areal-ui-critique` | 怎么做、怎么审；纠正先验和审查清单 |
| 组件旁的 `*.md` 合同 | 只属于这个组件、需要判断的强制规则，每个组件不超过 10 条 |
| CI（lint、基线脚本、`verify:design`） | 能机器判断的一切；新规则先尝试写成检查 |

能写成检查的规则不再写进合同正文；写不成检查、只是“默认这样做”的建议直接删掉，靠组件本身的默认值表达。

## 迁移一个组件

对话流活动组与活动行是第一个按这套方法迁移的场景，后续组件照同样步骤做：

1. 把组件 CSS 里的数值换成 Token，缺的先加进 `tokens.json`。
2. 把宿主 CSS 里选中组件内部 class 的规则移回组件；外观差异用部件或 Token 表达。
3. 把合同压到 80 行以内。强制规则写成“规则 + **为什么：** + **推广：** + **检查：**”，检查写测试路径，测试里写明规则 ID。
4. 行为有输入输出时，写成 `*.cases.json` 行为表：测试逐条执行，文档表格由 `design-generated.mjs` 生成。
5. 在 [verified-components.json](../../../../design-system/verified-components.json) 登记组件，运行 `node scripts/design-rules.mjs --write`、`node scripts/design-verified.mjs` 和 `pnpm verify:design`，全部通过才算迁移完成。

## 交付前

依次运行，全部通过后再交给 `areal-ui-critique` 做视觉审查：

```sh
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui check
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
```
