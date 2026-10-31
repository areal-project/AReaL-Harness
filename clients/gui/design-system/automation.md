# 自动化设计系统：来源核对与 v1 取舍

## 工程检查入口

`R-CHECK-001` `node scripts/gui-health.mjs` 输出范围、源码摘要和指标口径。`--check` 对照 `health-baseline.json` 限制大文件增长及新增 >800 行源码；`--write` 只收紧，`--allow-regression=<metric>` 输出豁免，CI 仍核对基准上限。Main/UI CSS 总行数只报告。

`R-CHECK-002` 测试元数据归 `scripts/test-manifest.json`，命令归根 `package.json`。`node scripts/test-manifest.mjs --list --platform=linux --layer=contract --available=git,gui-build` 仅选择满足前提的测试，不执行或证明其他平台；跨进程、原生与安装包证据由原 runner 保留。

## 核对结论

`R-CHECK-003` 闭环：唯一来源、有限组件/组合、可执行约束、独立验证。颜色与截图不能替代组合约束；数据驱动派生物，产品与视觉仍由人判断。

方法见[冻结参考研究](../../../design/archive/gui/automation-research.md)。

## AReaL v1 已接入的闭环

| 输入 / 所有者 | 派生或检查 | 实际消费者 |
| --- | --- | --- |
| 现有生产 CSS、主题与外观设置 | 校验登记 Token 名有生产定义；数值不搬家 | 所有现有生产组件 |
| [registry.json](registry.json) 的 Token 名与角色 | 生成 `renderer/src/design-system/catalog.ts` | 现有组件预览读取生产 computed style |
| `R-CHECK-004` 同一 registry 的组件、模式与 Base 候选范围 | 生成 inventory / patterns / base 中标记的表格区块，导出预览所用候选版本 | Agent 先选模式与生产参考；候选集不等于已冻结版本 |
| [surfaces](surfaces) 中的页面合同 | 核对版本、目标/参考路径、模式/组件/槽位、必需状态及证据元数据 | 当前设置控件预览的实现说明；后续页面采用同样输入 |
| 现有 `verify:design` | 先验证目录与派生物，再执行原 CSS 审计 | 本地和已有 verify 调用链 |

维护命令：

```sh
pnpm --dir clients/gui design:sync
pnpm --dir clients/gui verify:design
```

`R-CHECK-005` 生成器只改 catalog 和标记的文档表格。CSS、组件、页面、设置、基线与截图不受改写。`verify:design` 只读并提示过期修复；源变更后显式同步、审阅，单改生成物会失败。

## 增量设计检查

`R-CHECK-006` `design-system-audit.mjs` 在目录检查和已迁移文件审计之外，检查 Git 中生产 renderer 的 `.css/.tsx/.jsx` 变更，含分支、暂存、工作区和未忽略的新文件；开发预览 `design-system/` 除外。新增生产文件自动纳入。

- `R-CHECK-007` 本地默认与 `HEAD` 比较；提交后检查整条分支时设置 `AREAL_DESIGN_BASE=<base-sha>`。
- `R-CHECK-008` GUI 和 provider 配置 CI 获取完整历史：PR 使用 base 与当前检出的合并提交的 merge-base，push 使用事件的 before，手动运行使用 `HEAD^`；显式传入 `AREAL_DESIGN_BASE`。GitHub Actions 缺少基线或指定提交不可读取时失败，不静默退回 `HEAD`。
- `R-CHECK-009` 逐文件比较违规类型、值和次数；存量不因文案编辑阻断，新增或增长失败。Git 识别的重命名继承基线，复制按新增检查。
- 新增硬编码字号、颜色及静态 JSX 中的 `button/input/select/textarea` 会失败。公共基础控件目录可实现原生控件，仍检查字号和颜色。基础 CSS 可定义设计值，组件局部 CSS 变量的裸色仍受检查。
- `R-CHECK-010` 例外沿原变更准入提供理由与证据；检查器没有整文件免检或自动更新基线入口。确需公共能力时修改原所有者，调整审计策略须显式评审。

`R-CHECK-011` `verify`、`verify:design` 均执行门禁，后者同时检查目录与临时 Git 仓库回归。GUI workflow 保留设计日志，脚本失败使 job 失败；required check 取决于远端保护规则，本地无法证明。

## 尚未接入的自动化

`R-CHECK-012` 入口由本机 Agent 指令和版本化开发指南连接；根 AGENTS 不提交，新工作区需配置。Markdown/PR 模板不能强制客户端读取，执行仍靠检查和评审。

`R-CHECK-013` 静态检查不证明组件采用、视觉/动效/状态可达性，也不覆盖动态 class/style、普通 `.ts` 样式与自定义组件重复实现；同文件等量移动旧违规仍需 diff 审阅。预览和桌面独立验收，视频/视觉未接入自动裁决。

## REA 的问题与证据方法

见[冻结参考研究](../../../design/archive/gui/automation-research.md#rea-的问题与证据方法)。

## 视频分析辅助核查的默认路线

`R-CHECK-014` 页面执行[结构化 B 路线](structured-flow.md#执行顺序与每步完成条件)，准入归 [governance](governance.md#差异筛选准入)。复用[提示词](templates/video-analysis.prompt.md)、[schema](templates/video-analysis.schema.json)、[核查模板](templates/evidence-review.template.json)；尚未接入 `verify:design` 视觉判断或强制模型调用，目录检查不核实帧、误判与执行。

`Q-CONVERSATION-VIDEO-AB-07` 的三段录像、误判裁决与图片缩放修复见[复合题](exercises/conversation-flow.md#视频分析辅助的双路线实验)。样本仅支持工作流程选择。

`R-CHECK-016` 观察器提名差异，实现者结合合同、原件及日志裁决。使用已授权视频接口前核对能力/素材，保留模型、强度、读取/采样限制；不新增外发、登录、执行或发布权限。

## 无障碍与主题证据

当前准入与检查边界引用[无障碍验收](accessibility.md)（[English](accessibility.en.md)）。历史报告见[冻结研究](../../../design/archive/gui/automation-research.md#无障碍与主题证据)。

## 弹出层锚点覆盖

`pnpm --dir clients/gui test:design -- --popup-anchors` 按 `popup-anchors.json` 的入口登记，在 UI 包预览中挂载生产项目侧栏与任务行。打开菜单后移出触发行并逐项悬停，检查菜单与触发按钮的 x/y 位移各不超过 1px、HoverActions opacity 为 1。报告逐项保存测量与截图，失败截图文件名包含入口 ID。此检查只覆盖浏览器预览。

`popup-anchor-lint.mjs` 使用 TypeScript AST 扫描 `renderer/src` 和 `packages/ui/src` 中 HoverActions 内的 DropdownMenuTrigger、PopoverTrigger，按源码文件、Trigger 名称及同类序号与登记表逐一比对；新增入口的预览与登记共同维护。序号从 0 开始，单入口可省略。静态检查继续使用原有只减不增的存量 CSS baseline。

## 仓库内 lint 规则

`R-CHECK-017` 尺寸观察的静态约束与替代写法由 `areal/no-raw-resize-observer` 规则拥有；适用路径和共享实现例外由 `vite.config.mts` 指定。真实尺寸通知与卸载验证见 `test:resize-observer`。**检查：** `clients/gui/oxlint-plugin-areal/rules/no-raw-resize-observer.ts`

`R-CHECK-018` lint 与类型检查豁免的原因要求由 `areal/require-suppression-reason` 规则拥有；新增规则及正反例的维护流程见[测试指南](../../../docs/development/testing.md#仓库内-lint-规则)。**检查：** `clients/gui/oxlint-plugin-areal/rules/require-suppression-reason.ts`

`R-CHECK-019` 折叠只由共享组件拥有（依据 P6）：高级与详情分组用 SettingsDisclosure，默认收起；长正文用 CollapsibleText；对话过程行用 Disclosure 的右侧箭头；同类记录直接列出。renderer 与 UI 包不写原生 details/summary，不直接引入 Base UI Collapsible；例外路径由 `vite.config.mts` 列出。**检查：** `clients/gui/oxlint-plugin-areal/rules/no-raw-disclosure.ts`

`R-CHECK-020` 界面文案每条至多 30 个汉字，确认类（键名含 confirm）至多 50 个；i18n 中文与 renderer 里的中文字面量都计入，交给模型的多行证据文本除外。超出时先删实现机制，确有必要再链接帮助文档。**检查：** `clients/gui/scripts/copy-budget.mjs`
