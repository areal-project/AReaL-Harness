# 页面模式与有限选择

<!-- BEGIN GENERATED: patterns -->

完整组合、允许变化和验收重点归 [registry.json](registry.json) 的 `patterns`。

| ID / 用户任务 | 生产参考 |
| --- | --- |
| P-SETTINGS 修改偏好或配置 | [参考](../renderer/src/settings/DisplaySettings.tsx) |
| P-RESOURCES 查找并管理资源 | [参考](../renderer/src/settings/PluginCenter.tsx) |
| P-CONVERSATION 阅读并推进任务 | [参考](../renderer/src/design-system/ConversationFlowExercise.tsx) |
| P-DECISION 回答或批准请求 | [参考](../renderer/src/ApprovalRequest.tsx) |
| P-DETAIL 阅读或编辑详情 | [参考](../renderer/src/settings/common.tsx) |
| P-STATUS 了解状态并恢复 | [参考](../renderer/src/settings/ServiceStatusSettings.tsx) |

<!-- END GENERATED: patterns -->

`R-LAYOUT-002` P-RESOURCES 沿现有 PluginCenter 领域布局组合搜索、分类、列表、详情与反馈，不建立通用列表框架。共享意图与状态边界见[插件资源管理](../../../design/patterns/plugin-resources.md)，实际准入范围与运行证据见[Base](base.md)。目录成员仅表示列明的有限复用，不能扩大为完整插件安装、认证或连接生命周期。

`R-LAYOUT-004` 定时目录使用 P-STATUS 的局部状态反馈。冷 owner 的已发布快照显示“上次记录”和本次读取时间，不能把读取时间当作发布时间；完整性未知不能显示“没有任务”。缓存和成功的局部行在刷新失败时保留，显式“刷新这个项目”才可启动对应 Core。目录读取不扩大到启动其他聊天。

## 控件选择

见本页[设置控件与反馈](#设置控件与反馈)及跨产品[控件选择](../../../design/components/controls.md)。

## 设置组合布局

组件专属合同见[设置组合布局](../packages/ui/src/settings/settings-page/settings-page.md#设置组合布局)。

### 设置控件与反馈

见[组件合同](../packages/ui/src/settings/settings-page/settings-page.md#设置控件与反馈)。

#### 按功能分组并保持对齐

见[组件合同](../packages/ui/src/settings/settings-page/settings-page.md#按功能分组并保持对齐)。

#### 按交互类型选择控件

见[组件合同](../packages/ui/src/settings/settings-page/settings-page.md#按交互类型选择控件)。

#### 用状态反馈代替大段操作说明

见[组件合同](../packages/ui/src/settings/settings-page/settings-page.md#用状态反馈代替大段操作说明)。

## 对话信息流

组件专属合同见[对话信息流](../renderer/src/Messages.md#对话信息流)。

### 输入区与面板组合

组件专属合同见[输入区与面板组合](../packages/ui/src/conversation/composer-surface/composer-surface.md#输入区与面板组合)。

### Electron 宿主与输入边界

以下细化已有 `CONV-INPUT-01`、`CONV-RESOURCE-01` 与 `CONV-PARALLEL-01`，不新建页面模式或执行状态机。验证入口与取证边界见 [E3 专项](../../../design/archive/gui/exercises/conversation-flow.md#真实-electron-宿主与新内容专项-e3)及[E4原生补充](../../../design/archive/gui/exercises/conversation-flow.md#原生宿主补充-e4)。

- `R-LAYOUT-014` **焦点和阅读分开保留**：打开子对话或原生浏览器面板时记住实际入口及所属项目/会话。关闭后优先回该入口；入口已卸载时才回同会话 Composer。恢复使用 `preventScroll`，不能为了键盘可达性把读者拉到另一段历史。跨会话的旧入口不得抢焦点。设置页替换聊天子树时，返回可解析同会话重挂的 Composer，不能只保留已断开的 DOM 引用。
- `R-LAYOUT-015` **输入法先于应用动作**：组合输入期间的 Enter/Space 属于确认上屏，Escape 属于取消组合；不能发送、取消消息编辑或关闭工作区。检查 `isComposing` 及 Chromium `keyCode=229`；非组合状态的下一次 Enter/Escape 才按原提交/取消合同执行。不要把中文粘贴、CDP `insertText` 或合成 composition 当作原生候选验证。

- `R-LAYOUT-019` **窗口激活独立核对**：记录真实窗口身份与 focus/blur 事件；离开再返回后，同一草稿、可见阅读锚点和预期焦点分别核对。BrowserWindow API 激活自有辅助窗口能覆盖该切片，不能冒充物理 Cmd+Tab、跨应用、多显示器或后台自动抢焦点测试。
- `R-LAYOUT-020` **原生网页独立核对**：宿主工具栏、独立 WebContents 的可见内容/交互、视图隐藏分别有证据。主 renderer 截图空白不能推断网页未渲染；隐藏后AX仍列出旧页面，也不能推断它仍可见。关闭面板保留原聊天草稿与阅读位置，不重新调用模型。未触发的候选列表和仅上屏的英文文字，均不得记作原生中文候选通过。

### 从证据回溯到规则和组件

`R-LAYOUT-021` 这里拥有对话组合的设计决策；结构化引用在[信息流合同](surfaces/conversation-flow.json)，观察事实在[参考观察索引](../../../design/archive/gui/reference-observations.md#对话信息流的动态观察)。正文规则不复制到JSON。调用方选择P-CONVERSATION后必须声明全部规则ID和必需检查点；目录检查只能阻断遗漏或虚构引用，不能证明实现遵守。

| 规则 | 依据与判断强度 | 修改所有者 | 合同检查点 |
| --- | --- | --- | --- |
| CONV-OWNER-01 | 本仓既有执行权威和[职责分层](architecture.md#分层与所有权)，不是从Codex外观推断其架构 | 原Core投影 / Messages / 所属详情组件 | ready、busy、failed、unknown |
| CONV-INPUT-01 | OBS-CONV-INPUT：可见建议及用户说明；不推断预测机制 | ConversationComposer输入边界 / Messages已受理内容 | ready |
| CONV-CONTENT-01 | OBS-CONV-TOOL：真实运行与成功输出；内容顺序仍服从本仓投影 | Messages / TurnExecution / ToolEvent | busy、failed、unknown |
| CONV-READ-01 | OBS-CONV-READ：生成中可见锚点和返回后的连续样本；目标规则不复制测量常量 | Messages既有阅读逻辑 | reading-history、following-latest |
| CONV-RESOURCE-01 | OBS-CONV-RESOURCE：图片/子对话入口直接观察；独立网页面板仍未知 | ToolEvent及既有父聊天/资源面板所有者 | busy、completed；资源返回按复验题追加 |
| CONV-COMMAND-01 | OBS-CONV-TOOL支持Shell输入/输出与终态；分批读取的节奏由本仓公开进程投影构造，不声称参考已连续采齐 | processItems / ToolEvent / CommandDetails | command-streaming、tool-details、completed |
| CONV-STATUS-01 | 参考对话流末尾单行扫光状态；审批卡为唯一的等待入口 | TurnActivity / ThinkingStatus / DecisionCard / 宿主 Composer | running、awaiting-decision、completed |
| CONV-PARALLEL-01 | OBS-CONV-RESOURCE支持独立子对话；父子不同步完成是本产品显式约束 | AgentIdentity / conversationPresentation.agentSettlements / ToolEvent / AgentConversationPane / 原父聊天宿主 | parallel-working、child-conversation、completed |
| CONV-SCENARIO-01 | 原动态题仅有命令和重复段落，遗漏资源及子对话路径；复合题用于阻止同类范围遗漏 | ConversationFlowExercise及其输入fixture；生产所有者不迁移 | 全部复合检查点及逐状态对照 |

### 组合与变化边界

`R-LAYOUT-025` 结构化合同的states是验收检查点，不能拿它替代Core状态、重连快照或真实用户操作。

### 当前实现差异

| 所有者 | 当前源码事实 | 迁移/验收缺口 |
| --- | --- | --- |
| ConversationFlowExercise / Messages阅读逻辑 | 同一任务串接命令、子代理、图片、正文与收敛；可自动播放或暂停逐事件推进 | 复合题在生产renderer中验收；不是Core或桌面验收 |
| AgentConversationPane / SentAttachment | 复合题挂载生产子对话与图片预览，读取仅由隔离fixture响应 | 本题仍为fixture；E1另验选定生产子对话、图片返回和GUI重开，原生面板及完整重连矩阵仍未覆盖 |

## 最小实现说明

新页面、公共模式或跨状态的实质修改先按[结构化流程](structured-flow.md)在 `surfaces/` 登记合同；纯文案或沿现有合同的小改动可引用已有合同。变更说明简短引用合同及差异即可：

```text
用户任务：
模式 ID / 生产参考：
复用组件 / Token 角色：
状态与宽窄条件：
例外（没有则写无）：
验证证据与未覆盖项：
```

`R-LAYOUT-032` 例如新增配置导入入口：P-SETTINGS，沿用设置行和 ActionButton，调用方管理文件选择及提交；覆盖空、处理中、失败、成功与窄窗，只有诊断详情可展开。不能借此新建整套导入仪表盘或换主题。
