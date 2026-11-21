---
name: areal-ui-guide
description: 在 AReaL GUI 里新增或修改组件、页面、样式、Token 或设计规则前使用。给出阅读顺序、本仓库的纠正先验表和组件迁移步骤。
---

# 使用 @areal/ui

本 skill 随 `@areal/ui` 一起维护，内容以当前分支的代码为准。审查已经做完的界面时改用 `areal-ui-critique`。

## 阅读顺序（极简三步）

1. [DESIGN.md](../../../../../../DESIGN.md)：人的审美宪法与 Taste Log（品味纠偏对）。
2. 组件清单与 Token：先查 `pnpm --filter @areal/ui build` 产出的 `dist/llms.txt`（选现有组件）与 [Token 入口](../../token-reference.md)（变量名与用途；数值只在 `tokens.json`）。
3. 仅在需要某个组件细节时，读其同目录合同 `src/**/<组件>.md`；需要实时了解当前生效的全部 Lint 护栏与债务时，运行 `pnpm --dir clients/gui run design:health`。

> 不再默认翻阅历史 `design/` 或 `clients/gui/design-system/` 长篇散文，也**不再新增无自动化检查的纸面规则**。文中 `node scripts/…` 都在 `clients/gui` 目录下运行。

## 纠正先验

下表列出 agent 在本仓库里真实犯过的错。左列是常见直觉，右列是这里的做法。

| 你的直觉 | 在这里的做法 |
| --- | --- |
| 在页面或组件 CSS 里写 `16px`、`12px` 间距、`#888`、`300ms` | 全部引用 Token；缺 Token 时先加到 `tokens.json`，再运行 `pnpm --filter @areal/ui generate`。颜色/字号/圆角由 `design-system-baseline.mjs` 拦截，间距由 `ui-guardrails-lint.mjs` 拦截 |
| 在 `renderer/src` 直接手写 `<button>`、`<input>`、`<select>`、`<textarea>` | 直接复用 `@areal/ui` 共享控件；缺变体先补组件 variant。`ui-guardrails-lint.mjs` 与 `design-system-changes.mjs` 拦截新增裸控件 |
| 给 `@areal/ui` 组件传颜色、间距类或 `style`，或在页面 CSS 里选 `[data-slot=…]` / `.areal-*` | 页面只给布局类；外观差异加成组件的 variant 或 slot。`restyle-lint.mjs` 与 `ui-guardrails-lint.mjs` 拦截新增穿透 |
| 给 DOM 元素写原生 `title="..."` | 一律用 `TitleTooltip` 或给 `Button` 传 `title`（`areal/no-native-title` 拦截） |
| 在用户可见文案里写 `Core`、`Host`、`回执`、`快照`、`核对` 或直接吐 `error.message` | 用面向用户的自然语言与可操作提示（`ui-honesty-lint.mjs`、`terms-lint.mjs`、`copy-budget.mjs` 拦截） |
| 给组件加 `kind="explore" \| "command"` 这类万能开关 | 用组合部件表达结构，如 `ActivityRow` + `ActivityRowText` + `ActivityRowStatus` |
| 在 md 正文里写具体像素/色值，或手改 `rule-registry.json` | 数值只在 `tokens.json`；合同正文改动后运行 `node scripts/design-rules.mjs --write` |
| 在 md 里手写行为示例表 | 改行为表（如 `activity-runs.cases.json`），再运行 `node scripts/design-generated.mjs --write` |
| 行内按钮用宿主 CSS 随悬停显隐 | 一律用 [HoverActions](../../src/components/hover-actions/hover-actions.md)；打开态用 `[data-popup-open]`，不要写 `[data-state="open"]` |
| 只跑 `verify:design` 就说界面没问题 | 再跑 `design:health`、`audit:ui`（亮/暗实测）与真实 Web 检查，视觉结论以浏览器实拍为准 |

## 规则放在哪里（减少文档原则）

| 位置 | 放什么 |
| --- | --- |
| 根目录 [DESIGN.md](../../../../../../DESIGN.md) | 人的审美宪法与品味纠偏对（Taste Log），总长保持极薄 |
| 本 skill 与 `areal-ui-critique` | 怎么做、怎么审；纠正先验与审查清单 |
| CI 确定性 Lint（`verify:design` + `ui-guardrails-lint` + `design:health`） | **一切能机器判断的硬边界**；新规则优先写成带棘轮的 Lint，不再堆砌无检查的文字规则 |
| 组件旁的 `*.md` 合同 | 只在组件需要独立行为合同时保留，严格 ≤ 80 行 |

能写成检查的规则不再写进长文档；写不成检查的审美偏好沉淀进 `DESIGN.md` 的 Taste Log；“默认这样做”的建议直接靠组件默认值表达。

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
pnpm --dir clients/gui run design:health
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
pnpm --dir clients/gui run audit:ui
```
