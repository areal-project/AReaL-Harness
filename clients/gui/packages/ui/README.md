**中文** | [English](README.en.md)

# @areal/ui

AReaL GUI 的基础值、React 组件和组件合同。私有 workspace 包，不发布 npm；消费者声明 `"@areal/ui": "workspace:*"`，先构建本包再构建消费者（GUI 脚本已串联）。

## 使用

普通页面读取本页、[Token 入口](token-reference.md)和所选组件的就近合同。先按用户动作选择已有组件，再绑定宿主提供的值与合法动作。设置分组从 SettingsSection、SettingsGroupCard 和 SettingsRow 开始；审批卡从 DecisionCard 开始；局部状态反馈从 FeedbackNotice 开始。组件的 related 是按需参考，不是开工必读清单。

```tsx
import { Button, Select, Tooltip } from "@areal/ui";          // 稳定入口
import { SettingsRow } from "@areal/ui/compositions";       // Base 准入组合
import { ComposerActionButton } from "@areal/ui/experimental"; // 实验 API
```

| 要找什么 | 去哪里 |
| --- | --- |
| 常用变量叫什么、用在哪 | [Token 入口](token-reference.md)（生成）；完整值按需查 [Token 速查](src/generated/tokens.md) |
| 有哪些组件、该从哪个入口导入 | 构建产物 `dist/components.json`、`dist/llms.txt`，或设计站 `design-system.html?ui-library` |
| 某个组件何时用、状态、键盘、规则 | 组件同目录的 MD 合同 |
| Agent 怎么改、怎么审 | skill [areal-ui-guide](skills/areal-ui-guide/SKILL.md)、[areal-ui-critique](skills/areal-ui-critique/SKILL.md) |
| 修改系统、准入、证据与规则所有权 | [维护者入口](../../design-system/README.md#开工顺序) |
| 分层与成熟度规则 | [组件与组合](../../../../design/components/README.md#分层) |

## 分层与成熟度

`R-ENTRY-009` `src/components`（core）放通用控件；`src/settings`、`src/conversation`、`src/workbench`、`src/worktree` 放领域组合。core 不能导入其他层，组件不能导入 renderer、Core、Node 或 Electron。

生产代码的每个实验导入在 [experimental-allowlist.json](experimental-allowlist.json) 记录文件、符号、所有者和退出条件。检查拒绝未登记导入及失效名单；设计预览不计生产消费者。旧 `wip` 入口和源码深层导入已禁用。SettingsSelect 合同中的 `experimentalExports` 单独标明仍从实验入口导出的辅助符号。

## 修改

改 Token、共享规则、准入或生成器时转入[维护者入口](../../design-system/README.md#开工顺序)。

宿主（renderer）继续拥有用户偏好、业务状态、本地化与执行接线；取舍见 [D-004](../../../../design/decisions/004-local-ui-package.md)。

## 共同合同

下列原文从组件合同的逐字重复段合并。只有显式引用该 ID 的组件采用对应段落，组件特有行为仍在其就近合同中。

`R-UI-COMMON-001` 名称、值、说明和反馈来自宿主；长标签与18px字号不得挤掉实际动作。

`R-UI-COMMON-002` 保留现有原生/Base UI/cmdk键盘语义和ref；实际输入/触发器由宿主提供label，禁用不只改变颜色。

`R-UI-COMMON-003` 从@areal/ui导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

`R-UI-COMMON-004` 从@areal/ui/experimental导入，基础样式使用styles.css。原renderer路径转接同一实现；包不导入Intl、服务、凭据或存储。未提升稳定API或Base准入。

`R-UI-COMMON-005` 默认、内容增长、禁用/忙碌（由宿主提供）、明暗与不同字号；展示更新保留原身份与阅读状态。

`R-UI-COMMON-006` 名称、原因与结果来自宿主事实；未确认不能显示为成功，短时通知不替代原始结果与恢复动作。

`R-UI-COMMON-007` 真实控件保留label、aria、ref和键盘入口。18px字号和窄窗保持内容可读，焦点不因重新包装而丢失。

`R-UI-COMMON-008` 包不依赖renderer、Intl、Store、Core或Electron。原路径仅转接或注入宿主数据；API 保持 experimental，不自动提升稳定 API。

`R-UI-COMMON-009` 默认、内容增长、聚焦、不可用，以及宿主提供的忙碌/失败/未确认；同一对象保留原身份与阅读状态。

`R-UI-COMMON-010` 保留原实现、原生语义和交互动线。只读取props与浏览器布局，不请求Core，不访问保存配置。

`R-UI-COMMON-011` 名称、标签、说明与结果由宿主投影；不能由视觉状态推断实际操作已完成。

`R-UI-COMMON-012` 保留ref、aria、键盘、焦点及减少动态效果。字号增长与窄容器下动作仍须可达。

`R-UI-COMMON-013` 原renderer路径保留翻译、偏好和业务适配；包只拥有UI。实验导出不代表稳定API、完整产品能力或安装包通过。

`R-UI-COMMON-014` 保留原实现和键盘/焦点/滚动语义。原renderer适配提供翻译、偏好与合法动作；UI包只呈现与管理本地交互。

`R-UI-COMMON-015` 包不依赖renderer、Intl、Store、Core或Electron。原路径仅转接或注入宿主数据；API 保持 experimental；Base 准入不自动提升稳定 API。
