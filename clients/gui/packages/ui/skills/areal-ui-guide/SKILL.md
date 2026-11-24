---
name: areal-ui-guide
description: 在 AReaL GUI 里新增或修改组件、页面、样式、Token 或设计规则前使用。给出阅读顺序、开工前 UX 简报、组件选型决策树、本仓库的纠正先验表和组件迁移步骤。
---

# 使用 @areal/ui

本 skill 随 `@areal/ui` 一起维护，唯一真源为 `clients/gui/packages/ui/skills/areal-ui-guide/SKILL.md`（`.agents/skills/areal-ui-guide` 为指向该目录的符号链接）。审查已经做完的界面时改用 `areal-ui-critique`。

## 阅读顺序（极简三步）

1. [DESIGN.md](../../../../../../DESIGN.md)：人的审美宪法、UX Writing 5 条铁律与 Taste Log（品味纠偏对）。
2. 组件清单与 Token：先查 `pnpm --filter @areal/ui build` 产出的分层版 `dist/llms.txt`（选现有组件）与 [Token 入口](../../token-reference.md)（变量名与用途；数值只在 `tokens.json`）。
3. 仅在需要某个组件细节时，读其同目录合同 `src/**/<组件>.md`；需要实时了解当前生效的全部 Lint 护栏与债务时，运行 `pnpm --dir clients/gui run design:health`。

> 不再默认翻阅历史 `design/` 或 `clients/gui/design-system/` 长篇散文，也**不再新增无自动化检查的纸面规则**。文中 `node scripts/…` 都在 `clients/gui` 目录下运行。

## Step 0：开工前 UX 设计简报（新页面 / 重大改动必做）

在写第一行 JSX 之前，先用 10 行以内文字明确本页骨架，避免功能堆砌与遗漏状态：

1. **核心任务（仅 1 个）与信息分层**：
   - `P0` 默认可见的核心动作与主内容（**单屏主权重按钮 ≤ 1**）。
   - `P1` 辅助元信息（弱化展示，不抢焦点）。
   - `P2` 低频配置与技术细节（默认收起进 `SettingsDisclosure` / `Disclosure` 或二级入口）。
2. **完整 5 状态方案（UI State Matrix）**：
   - **Empty（空态）**：说明此处将承载什么 + 1 个明确的第一步动作（禁写孤立的“暂无数据”）。
   - **Loading（加载态）**：超过 300ms 使用 `Skeleton` 或局部 `Spinner`，快请求不闪烁，不整页卡死。
   - **Error（错误态）**：三段式人话（发生了什么 + 数据安全吗 + 下一步怎么修），技术详情折叠，不吐 `error.message`。
   - **Overflow（极限态）**：50 字超长标题、大量条目、窄窗口与 18px 字号下不截断关键动作、不水平溢出。
   - **Pending（中间态）**：点击后 100ms 内可见忙碌/禁用反馈，防重复提交；未确认状态不伪装成成功。
3. **容错策略（Undo over Confirm）**：可逆修改优先“直接执行 + `NotificationToast` 撤销”；仅不可逆高危操作使用阻断确认弹窗，且按钮写“动词 + 具体结果”（禁止孤立“确定 / 取消”）。
4. **组件与 Token 声明**：按下方决策树声明复用的 L1/L2 组件与语义 Token。

## 组件选型决策树（防止张冠李戴）

| 场景 / 用户意图 | 应该用什么 | 明确不要用什么 |
| --- | --- | --- |
| **轻反馈（无阻断、3 秒自动消失、可带撤销）** | `NotificationToast` | 不要弹模态 `Dialog` 打断用户 |
| **局部 / 页面级持久状态（含重试或恢复动作）** | `FeedbackNotice` | 不要用会自动消失的 Toast 承载必须处理的错误 |
| **静态说明、审批原因、影响提示** | `Callout` | 不要用大段无层级灰色正文或卡片套卡片 |
| **不可逆高危阻断确认** | `ConfirmDialog`（写明动词 + 结果） | 不要对可逆操作弹确认，也不要写“确定 / 取消” |
| **附属轻操作 / 上下文菜单** | `Popover` / `DropdownMenu` / `ContextMenu` | 不要手写绝对定位浮层（必须走 Base UI 锚点防撞墙） |
| **保留主上下文的局部查看 / 编辑** | `SidePaneFrame` / `Sheet` | 不要用居中模态 `Dialog` 遮死主阅读区 |
| **短而聚焦的强打断表单 / 设置任务** | `Dialog` / `SettingsDialog` | 不要叠双层弹窗 |
| **双向布尔开关** | `Switch`（后端必须真支持双向） | 不要拿 `Switch` 伪装单向清理/停止操作 |
| **2～3 个互斥视图 / 模式切换** | `SettingsSegmentedTabs` | 超过 4 项不要塞进分段器 |
| **同级内容页签切换** | `Tabs` | 不要把跨模块主导航做成 Tabs |
| **4+ 选项单选 / 可搜索超长列表** | `Select`（4～12 项） / `Command`（可检索列表） | 不要把 8 个单选项平铺成一排按钮 |
| **无数据 / 首次使用引导** | `EmptyState`（说明 + 1 个主动作） | 不要只写“暂无数据”或贴左上角堆叠 |
| **渐进展开高级设置 / 详情** | `SettingsDisclosure` / `Disclosure` | 不要用左侧三角或手写折叠状态 |

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
| 只跑 `verify:design` 就说界面没问题 | 再跑 `design:health`、`audit:ui`（亮/暗实测）与 `areal-ui-critique` 失忆盲审，视觉结论以浏览器实拍为准 |

## 规则放在哪里（减少文档原则）

| 位置 | 放什么 |
| --- | --- |
| 根目录 [DESIGN.md](../../../../../../DESIGN.md) | 人的审美宪法、UX Writing 铁律与品味纠偏对（Taste Log），总长保持极薄 |
| 本 skill 与 `areal-ui-critique` | 怎么做、怎么审；Step 0 简报、选型决策树、纠正先验与盲审清单 |
| CI 确定性 Lint（`verify:design` + `ui-guardrails-lint` + `design:health`） | **一切能机器判断的硬边界**；新规则优先写成带棘轮的 Lint，不再堆砌无检查的文字规则 |
| 组件旁的 `*.md` 合同 | 只在组件需要独立行为合同时保留，严格 ≤ 80 行 |

能写成检查的规则不再写进长文档；写不成检查的审美偏好沉淀进 `DESIGN.md` 的 Taste Log；“默认这样做”的建议直接靠组件默认值表达。

## 迁移或新增一个组件

**样式写法约定（L1 vs L2/L3）：**
- **L1 基础原语（`packages/ui/src/components/*`）**：优先使用 Tailwind 工具类 + CVA 变体（如 `Button`、`Input`、`Dialog`、`Tabs`），减少无意义的胶水 CSS；外观差异收敛为语义 `variant` / `size` / `tone` props，宿主页面只传布局类（`restyle-lint.mjs` 强制保障）。
- **L2/L3 复杂组合与业务容器（`conversation/*`、`settings/*`、`workbench/*`）**：允许保留独立的同目录语义 `.css`（便于表达复杂状态机、网格与动画），但必须全部引用语义 Token 变量，严禁裸写颜色/字号/圆角/间距魔法值。

1. 把组件 CSS 里的数值换成 Token，缺的先加进 `tokens.json`（只提炼跨组件语义角色，不把一次性局部像素塞进全局 foundation）。
2. 把宿主 CSS 里选中组件内部 class 的规则移回组件；外观差异用 variant / slot 或 Token 表达。
3. 把合同压到 80 行以内，含 frontmatter、`## 何时使用` 与 `## 示例`。强制规则写成“规则 + **为什么：** + **推广：** + **检查：**”，检查写测试路径，测试里写明规则 ID。
4. 行为有输入输出时，写成 `*.cases.json` 行为表：测试逐条执行，文档表格由 `design-generated.mjs` 生成。
5. 在 [verified-components.json](../../../../design-system/verified-components.json) 登记组件，运行 `pnpm --dir clients/gui design:sync`、`node scripts/design-rules.mjs --write`、`node scripts/design-verified.mjs` 和 `pnpm --dir clients/gui verify:design`，全部通过才算完成。

## 交付前

依次运行，全部通过后再交给 `areal-ui-critique` 做视觉与盲审验收：

```sh
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui check
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui run design:health
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
pnpm --dir clients/gui run audit:ui
```
