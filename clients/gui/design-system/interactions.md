# 用户交互模式

从用户意图选择交互族，再组合页面。页面名称、对象类型和组件列表不是分类入口。同一页可以使用多个交互族，但不创建另一套字体、颜色、滚动、状态或保存机制。

共享设计意图见[意图地图](../../../design/patterns/intents.md)，身份、审批、委派与上下文的共同含义见[人与 Agent](../../../design/people-and-agents/README.md)。下列 I-* 和规则 ID 维护 GUI 的选择、接线与验收，不重新定义执行契约。

## 使用方式与规则强度

3. `R-INTERACTION-031` 记录采用的默认规则及少量例外。必须规则不可由 agent 自行豁免；与当前用户决定冲突时，以用户决定为准并记录影响。

| 强度 | Agent 的责任 |
| --- | --- |
| `R-INTERACTION-002` 必须 must | 保持状态可信、必要上下文和可达性；有冲突先定位原所有者，不临时绕过 |

## 分类索引

<!-- BEGIN GENERATED: interaction-families -->

| ID / 用户意图 | 既有组合 | 生产所有者 | 规则 |
| --- | --- | --- | --- |
| I-NAV 定位与切换 | P-SETTINGS, P-RESOURCES | SettingsNavigation | NAV-CONTEXT-01, NAV-DEFAULT-01 |
| I-INPUT 输入与提交 | P-CONVERSATION, P-SETTINGS, P-DETAIL | ConversationComposer, SettingsRow | INPUT-TRUTH-01, INPUT-DEFAULT-01 |
| I-OBSERVE 等待与观察 | P-CONVERSATION, P-STATUS, P-SETTINGS | TurnExecution, TurnProgress, Feedback | OBSERVE-TRUTH-01, OBSERVE-DEFAULT-01 |
| I-READ 阅读与探索 | P-CONVERSATION, P-DETAIL, P-SETTINGS | CollapsibleText, SettingsDisclosure | READ-CONTINUITY-01, READ-DEFAULT-01 |
| I-RETURN 打开与返回 | P-CONVERSATION, P-DETAIL, P-SETTINGS | AgentConversationPane, SettingsDialog, SidePane, SideChatPane | RETURN-CONTEXT-01, RETURN-DEFAULT-01 |
| I-DECIDE 选择与确认 | P-DECISION, P-SETTINGS, P-DETAIL | SettingsSelect, Switch, DecisionCard | DECIDE-RESULT-01, DECIDE-DEFAULT-01 |
| I-MANAGE 调整与管理 | P-SETTINGS, P-RESOURCES | SettingsPage, SettingsSection, SettingsGroupCard, SettingsRow | MANAGE-OWNER-01, MANAGE-DEFAULT-01 |
| I-RECOVER 异常与恢复 | P-STATUS, P-CONVERSATION, P-SETTINGS, P-RESOURCES, P-DETAIL, P-DECISION | Feedback, EmptySettings | RECOVER-TRUTH-01, RECOVER-DEFAULT-01 |

<!-- END GENERATED: interaction-families -->

## I-NAV 定位与切换

- 意图：知道当前位置，切换工作上下文，返回原任务。
- 状态：当前、可前往、切换中、被未保存修改阻止、无匹配结果。
- `NAV-CONTEXT-01`：必须。选中状态反映当前内容；切换或返回不丢失尚未提交的内容。不得用焦点、悬停冒充选中或绕过原导航守卫。
- `NAV-DEFAULT-01`：默认。一个壳层；导航有稳定名称和显式返回入口；搜索无结果就近说明且可清除。键盘操作依现有控件语义。
- 可探索：按产品任务组织分组、名称和顺序。依据：既有设置导航；完整多窗口切换仍是覆盖缺口。

## I-INPUT 输入与提交

- 意图：表达需求、填写信息、确认系统已受理。
- 状态：空、编辑、组合输入、可提交、提交中、失败、结果未知。
- `INPUT-TRUTH-01`：必须。草稿与已受理结果分开；IME 组合输入不触发提交；失败保留可恢复输入；未知受理不自动重发。
- `INPUT-DEFAULT-01`：默认。标签说明预期输入；校验就近显示；明确采用即时生效或显式保存，不能同时暗示两种方式。
- 依据：Composer、颜色输入的局部草稿、原保存链路。原生候选浮窗未验证。

## I-OBSERVE 等待与观察

- 状态：排队、工作、等待用户、完成、失败、未知；并行子任务各自独立。
- `OBSERVE-TRUTH-01`：必须。状态有文字；请求已受理、实际执行、工具结算、最终完成分别表达；子任务状态不替代父任务状态。
- `OBSERVE-DEFAULT-01`：默认。当前进展轻量可见，过程细节逐步展开；正常结束可收敛，失败与未决事项仍可发现。

## I-READ 阅读与探索

- 意图：理解结果、长内容和必要细节。
- 状态：摘要、展开、折叠、阅读历史、跟随最新。
- `READ-CONTINUITY-01`：必须。隐藏内容不可继续获得焦点；读者主动回看时保持阅读意图；关键决策信息不得仅放在默认隐藏区域。
- `READ-DEFAULT-01`：默认。常用判断和操作直接可见；专业微调、长过程按主题渐进展开，入口名称说明其中内容，采用共享展开控件。不把所有内容装进无语义的“高级”。
- 连续性/视觉/动效：一个主滚动区；展开由内容决定高度，反向与 reduced motion 沿原组件。可探索：正文结构、领域图表。
- 依据：已有对话阅读与设置详情；具体哪些设置常用属于本产品选择；设置首阶段效果已获用户认可。

## I-RETURN 打开与返回

- 意图：检查资源或子任务后继续原工作。
- `R-INTERACTION-015` 状态：关闭、打开、加载、不可用、返回。
- `RETURN-CONTEXT-01`：必须。返回保留父任务、必要草稿和阅读上下文，并恢复合理焦点；关闭阅读不改变后台任务执行状态。
- `RETURN-DEFAULT-01`：默认。持续检查用现有面板，短编辑用既有对话框；不重复叠加弹窗；宽窄布局沿壳层所有者。

## I-DECIDE 选择与确认

- 意图：理解影响并作出选择。
- 状态：可选、已选、禁用、处理中、失败、未知。
- `DECIDE-RESULT-01`：必须。真实当前值与即将执行的选择分开；处理中防止重复操作；未经确认不展示已完成。
- `DECIDE-DEFAULT-01`：默认。双向布尔用开关、两个互斥值用分段、多候选用菜单；一次操作用按钮。具体 API 和尺寸以原控件合同为准。
- 连续性/视觉/动效：选择可辨、禁用原因可读；菜单关闭恢复触发焦点；动效不承担唯一反馈。可探索：领域选项和影响说明。
- 依据：Base 控件与决策题；权限边界仍由原业务所有者决定。

## I-MANAGE 调整与管理

- 意图：改变持续生效的偏好、资源或配置。
- `R-INTERACTION-020` 状态：当前值、编辑、保存中、保存成功、失败、不可用。
- `MANAGE-OWNER-01`：必须。使用既有偏好与业务保存所有者；界面设置不更换执行权威；编辑非当前配色不隐式切换应用主题；恢复默认范围明确。
- `MANAGE-DEFAULT-01`：默认。按用户目的分组；常用设置优先，专门微调按主题展开。即时偏好不增设虚假的保存按钮；需确认的持久配置保留原保存入口。
- 连续性/视觉/动效：内容决定行高；窄组沿共享容器重排，长标签不靠缩字或裁切解决。可探索：任务分组、摘要和领域字段。

## I-RECOVER 异常与恢复

- 意图：知道影响并找到可行的继续路径。
- `RECOVER-TRUTH-01`：必须。错误归属明确；未知不改写为失败或成功，不自动重放；恢复动作必须由当前能力支持。
- `RECOVER-DEFAULT-01`：默认。影响和可行动作就近呈现，技术细节渐进展开；局部可选能力失败不遮蔽其余有效内容。
- `R-INTERACTION-024` 连续性/视觉/动效：保留输入和可用内容，错误使用共享语义颜色与文字，不仅依赖颜色或通知。可探索：领域诊断内容。
- 依据：既有状态、保存错误与 UNKNOWN 规则；本次设置旅程未注入全部失败组合。
