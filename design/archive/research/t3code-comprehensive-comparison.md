# T3 Code 与 AReaL：工作台功能与交互对比

本报告供选择后续改动范围。正文优先列功能差异、缺失入口和不同执行语义。相同能力只在防止误判时说明。原始对比列及原核查段落保留研究时的快照；后续实施与验证写在新增「执行情况」列。

## 证据与术语

- T3 Code 源码：`/Users/sailfish/CodeProject/t3code`，基线 `c8a606c7b73e1e3586d5c06f76c69525f2d4c679`；读取时仅 `pnpm-lock.yaml` 有原有修改。
- AReaL 源码：`/Users/sailfish/CodeProject/AReaL-Harness`，基线 `046db6765f752cd9b71a7de69545de0cee7a88f7`；读取时工作区干净。
- 本轮由三个 GPT-6.1 Terra 子代理分别调查对话流、浏览器/终端/设备、文件/Diff/PR；主代理核查输入区并合并证据。
- **缺失**：T3 有明确入口；本仓对应 GUI 所有者和调用链没有该入口。它不表示 Agent 不能调用外部工具完成类似任务。
- **差异**：双方具备相关能力，但动作、范围、状态或执行语义不同。
- **同类能力**：两侧都有对应动作，不表示平台、权限、边界和交互完全相同。
- **Turn / run**：一轮执行。两仓的内部对象不完全相同，比较时保留各自生命周期。
- **Profile**：浏览器登录数据与网站存储的隔离配置。
- **PR**：托管代码平台中的合并请求。**Linked PR**：与当前对话建立关联的 PR。
- **Device**：T3 的模拟器及部分 Android 真机控制面板，不是 AReaL 手机 Remote。
- 证据类型分别为「源码事实」「项目文档声明」「截图观察」「运行结果」。本轮没有运行结果，性能和稳定性没有实测排名。

路径约定：`apps/`、T3 `packages/` 指 T3 根目录；`clients/`、`core/` 指 AReaL 根目录。带 `t3code/` 或 `AReaL-Harness/` 前缀的路径相对 `/Users/sailfish/CodeProject/`。文件名后的行号定位本轮快照。只引用文件名或 `:行号` 时，沿用同段最近的完整文件路径。

## 推荐方案的读法

「推荐方案」为本次评审意见，不表示已经批准实施。优先：先进入实施候选。保留：沿用本仓现有设计。后续：在基础链路稳定后安排。暂缓：当前收益或需求不足以承担扩展成本。先测：由实测热点决定优化。每项理由均基于本报告已有的功能、语义或验证缺口，不代表实测收益。

## 执行情况的读法

执行列是本次读取产物后的快照，区分代码实施、组件检查、完整应用检查和性能对照。原始对比列中的“没有”“未测”描述研究基线，不覆盖执行列的新结果。后续、暂缓项写明未开始；沿用既有能力不计作本轮新增功能。当前整体尚未完成，不能据单侧样本宣称性能提升。

执行依据如下。路径相对仓库根，I/C/L/W/B/F/D/P 编号沿用执行清单。

- E1：`.scratch/t3-priority/functional-closure/functional-evidence.json`，逐项功能证据与覆盖限制。
- E2：`.scratch/t3-priority/perf/remaining-execution/send-run-3/current-normal-0/result.json` 和 `perf/conversation-flow-final.log`（后者位于 `.scratch/t3-priority/` 下），完整应用发送定位与 normal/reduced motion 组件检查。
- E3：`.scratch/t3-priority/perf/remaining-execution/history-run-8-evidence/manifest.json`，生产历史组件、真实 Desktop owner 与受控 Core 的折叠、图片和分页检查。
- E4：`.scratch/t3-priority/perf/worker-ui-acceptance/`，隔离 worker 候选的真实任务、高亮、选区和评论检查；尚未采纳。
- E5：`.scratch/t3-priority/perf/results.json`、`perf/report.md` 和 `perf/final-comparison.md`（后两者位于 `.scratch/t3-priority/` 下），性能样本、失败与待测范围。
- E6：`.scratch/t3-priority/requirements.json` 和 `perf/remaining-harness/coverage.md`（后者位于 `.scratch/t3-priority/` 下），实施状态、断线/缺帧及终端契约检查。
- E7：`.scratch/t3-priority/turn-diff-final/run-7F3hcL/reading.json` 和 `manifest.json`（同目录），真实 Core 两轮写入后的筛选、文件与正文位置恢复。

## 先看这些差异

| 区域 | 供评审的主要差异 | 详细位置 | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- |
| 中断 | T3 在时间线插入 `Run interrupted`；AReaL 保存停止原因但不以同样分隔行展示用户暂停 | 对话流状态 | 优先：补中断分隔行，明确停止原因，便于回看。 | 已验证：增加用户停止与 Core 恢复的中断分隔行，无工具轮次也显示。见 C01/E1。 |
| 报错重试 | T3 有 provider 重试事件及耗尽终态；AReaL 有共享 Core 的有限重试与当前状态提示；两侧都不能概括为通用一键重试 | 对话流状态 | 优先：统一重试中、恢复、耗尽三种提示，显示次数与下一步。 | 已验证：按同一请求显示次数、等待、恢复或耗尽；未知受理先核对。见 C02、C03/E1。 |
| 切换模型 | T3 在不兼容 provider 身份切换时显示交接行；AReaL 更新 Core 配置并沿用线程上下文 | 对话流状态 | 优先：显示模型变更记录；沿用 Core 上下文，不新增虚构交接过程。 | 已验证：持久记录源、目标模型及下轮生效；重启后保留。见 C04/E1。 |
| 时间 | 两侧均显示执行耗时；AReaL 主消息行缺少 T3 的消息时间展示 | 对话流状态 | 优先：保留执行耗时，补充悬停及键盘聚焦时的消息时间。 | 已验证：正文消息支持悬停、聚焦及完整时间提示；旧历史不补造时间。见 C05/E1。 |
| 发送后定位 | T3 对新用户消息设置近顶部锚点；AReaL 通过响应空间和阅读状态校正布局 | 性能与动效机制 | 优先：发送后锚定本轮用户消息；用户滚动后立即让出控制。 | 已验证：真实应用首发与续发距顶约 32px；用户上滚后输出不抢位置。见 C06、P01/E2。 |
| 输入 | 长文本折叠后的实际提交不同；T3 还提供模型搜索/收藏及受条件限制的多模型派发 | 输入区与模型选择 | 优先：补搜索和附件状态；多模型派发另列后续。 | 已验证：目录引用、折叠正文说明、附件状态与回执复用、搜索收藏；多模型派发未开始。见 I01–I05/E1。 |
| 浏览器 | T3 支持多 profile、浮动预览和更完整的设备视口；AReaL 有共享登录 profile 和自己的控制审批 | Browser | 优先：补设备视口；多 profile 后续，浮动预览暂缓。 | 已验证：预设、宽高、旋转、加载失败与权限提示；多 profile 和浮动预览未开始。见 B01、B02/E1。 |
| 终端 | T3 支持面板内横竖分屏；AReaL 单活动终端并提供 Thread/Turn 生命周期选择 | Terminal | 后续：补横竖分屏，保留 Thread/Turn 生命周期选择。 | 分屏未开始；沿用 Thread/Turn 生命周期。重挂、缺口与预算测量进行中，见 P08/E6。 |
| 文件 | T3 直接预览更多文档类型；AReaL 多种格式走源码或外部应用 | 文件类型 | 优先：补 PDF、CSV/TSV、Mermaid；其他格式分批评估。 | 已验证：PDF、CSV/TSV、独立 Mermaid 预览；其他新增格式未开始。见 F01–F03/E1。 |
| Diff 与撤销 | AReaL 细分 staged/unstaged/commit/task；T3 有回退时还原或保留文件的选择 | Diff、评论与恢复 | 保留细分审查范围；优先打磨定位与评论；文件回退另立专项。 | 已验证：范围阅读恢复、选区评论、删除与带回输入；文件回退未开始。见 D01、D02/E1、E7。 |
| PR | T3 内建列表、详情、审查和对话关联；AReaL 缺少对应 PR 工作台 | PR / Linked PR | 后续：先做关联和只读详情，再做远端写操作。 | 未开始：PR 关联、只读详情与远端审查均未纳入本轮。 |
| Device | T3 控制模拟器和设备屏幕；AReaL 缺少同类内建设备工作台 | Device | 暂缓：独立成设备开发专项，先限定一种平台。 | 未开始：设备发现、屏幕和控制工作台暂缓。 |

## 截图对应的状态

| 截图 | 可确认的观察 | 不能由截图推出的结论 |
| --- | --- | --- |
| 图 1 | 多条中断分隔行；`Provider error after 5/5 retries`；错误正文和时间；右侧上下文卡 | 所有 provider 都重试 5 次；中断恢复一定成功 |
| 图 2 | 分叉来源；`Context handoff` 的源与目标；消息时间；`Scroll to end` | 每次切模型都交接；发送或滚动的完整时序 |
| 图 3、图 4 | `Browser`、`Terminal`、`Files`、`Diff`、`Pull request`、`Linked pull requests`、`Device` 入口；部分 PR 项为禁用状态 | 灰色入口不支持；所有环境均具备设备或 PR 操作权限 |

这些截图证明对应状态可见。静态截图不证明动画、帧率、定位连续性或错误恢复成功。

## 输入区与模型选择

本节沿用上一轮结论，并补查模型选择与附件发送。相同的文件引用、文件树添加到对话、普通附件选择不展开列举。

| ID | 功能 | T3 Code | AReaL | 分类 | 代码证据 | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I01 | 外部目录拖入 | 本地桌面环境取得目录路径后插入引用；远程环境拒绝 | 接受内部工作区引用；外部目录拖入显示不支持 | 缺失：外部目录引用入口 | T3 `apps/web/src/components/chat/ChatComposer.tsx:2468`；AReaL `clients/gui/renderer/src/prompt-editor/ChatPromptEditor.tsx:438` | 优先：允许当前本地工作区内目录拖入并生成引用；远程环境显示明确原因。 | 已验证：原生文件拖入形成当前工作区目录引用；外部目录拒绝，迟到结果不跨线程。见 E1。 |
| I02 | 长文本粘贴阈值 | 通常达到 32 KiB 时生成文本附件；还受输入上限、附件能力与绕过动作影响 | 超过 200 字符或达到 5 行时显示折叠文本 | 差异 | T3 `packages/client-runtime/src/textPaste.ts:1`；AReaL `clients/gui/renderer/src/ComposerAttachments.tsx:35` | 优先：区分折叠展示与附件化；保留短文本行内粘贴，不直接照搬 32 KiB。 | 已完成：保留短文本行内与折叠正文语义，卡片明确正文/附件区别；新说明未单独做视觉专项。见 E1。 |
| I03 | 折叠文本发送 | 创建命名文本 File 并进入附件流程 | `composerInput` 将文本合并回消息正文，不生成上传文件 | 差异：相似外观的提交语义不同 | T3 `apps/web/src/components/chat/useComposerAttachmentIntake.ts:412`；AReaL `clients/gui/renderer/src/ComposerAttachments.tsx:22`、`clients/gui/renderer/src/Composer.tsx:1461` | 保留正文发送语义，并标明折叠文本会进入正文；附件发送另设明确动作。 | 沿用正文发送；折叠卡标明进入正文。独立文本附件动作未新增。见 I02/E1。 |
| I04 | 附件上传时机 | 输入阶段维护上传、失败重试和重新附加状态 | 发送时读取并逐个上传附件；输入中的附件卡没有对应上传重试动作 | 差异 | T3 `apps/web/src/components/chat/ComposerAttachmentStrip.tsx:150`；AReaL `clients/gui/renderer/src/ComposerUploads.ts:4`、`clients/gui/renderer/src/ComposerAttachments.tsx:56` | 优先：逐附件显示准备、上传和失败状态；重试复用成功回执，发送等待准备完成。 | 已验证：逐件准备/上传/失败，跨线程返回只重试失败件；成功回执复用，UNKNOWN 不重传。普通附件为实际 Core 路径，MCP 为提交函数回归。见 E1。 |
| I05 | 模型搜索与收藏 | 在选择器中跨供应商搜索；支持 Favorites | 供应商分栏下单选模型；该选择器没有搜索框或收藏入口 | 缺失：选择器内搜索、收藏 | T3 `apps/web/src/components/chat/ModelPickerContent.tsx:378`、`:644`；AReaL `clients/gui/renderer/src/ComposerModelMenu.tsx:96`、`:212` | 优先：先补跨供应商搜索；收藏随后加入，沿用模型身份。 | 已验证：跨供应商搜索、同名模型区分、收藏重载与键盘选择通过。见 E1。 |
| I06 | 新任务多模型选择 | 草稿路径按 supportsMultipleModels 支持多选 | 模型选择器只传递单个字符串值 | 缺失：一次草稿多模型派发入口 | T3 `apps/web/src/components/chat/ComposerFooterControls.tsx:357`；AReaL `clients/gui/renderer/src/ComposerModelMenu.tsx:64`、`clients/gui/renderer/src/lib/draftModelSelection.ts:5` | 暂缓：先明确多任务数量、执行工作区与费用呈现，再增加多模型派发。 | 未开始：多模型派发暂缓，数量、工作区和费用方案未实施。 |
| I07 | 模型参数选择 | TraitsPicker 按 provider 描述符生成参数控件，包含 effort / fastMode | ComposerModelMenu 提供独立推理强度滑杆及 Fast 开关 | 差异：参数控件与范围不同 | T3 `apps/web/src/components/chat/TraitsPicker.tsx:150`；AReaL `clients/gui/renderer/src/ComposerModelMenu.tsx:310` | 保留现有控件，按模型能力提供有效参数；暂不引入通用 traits 编辑器。 | 沿用推理强度与 Fast 控件；未新增通用 traits 编辑器。 |

模型切换是否新增上下文交接事件、运行中何时生效，以及状态提示，单列在对话状态章节。Fast 开关仅说明请求配置，不作为模型实际速度的证据。

本节结论是源码核查。输入延迟、上传耗时、原生拖拽及 IME 路径未实测。

## 对话流状态

| 编号与分类 | T3 行为及证据 | AReaL 行为及证据 | 结论与未验证范围 | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- | --- |
| 1 差异：中断与恢复 | `run_interrupt_result` 独立显示 Run interrupted 及消息；错误行按失败类别显示（`t3code/apps/web/src/components/chat/V2LifecycleRow.tsx:73`，`t3code/apps/web/src/session-logic.ts:364`）。 | Core 记录 userPause/CoreRecovery（`AReaL-Harness/core/engine/src/turns.rs:569`，`AReaL-Harness/core/engine/src/store.rs:402`）；过程尾对用户暂停抑制额外状态，未确认、未完成、失败分开（`AReaL-Harness/clients/gui/renderer/src/TurnExecution.tsx:143`）；受理不确定的文案见 `AReaL-Harness/clients/gui/renderer/src/recoveryPresentation.ts:61`。 | 停止前是进行中，停止后 T3 有事件分隔行，AReaL 保留原因但该过程尾不另显示暂停状态。截图事件来源及重启后的用户体验未实测。 | 优先：补静态中断分隔行，区分用户停止与连接中断；继续动作作为新提交。 | 已验证：无工具轮次也显示中断分隔行，区分 userPause 与 CoreRecovery。生产组件浏览器检查通过。见 C01/E1。 |
| 2 差异：自动重试 | Pi adapter 接收 auto_retry_start/end，同一错误项更新次数、上限、延迟和终态（`t3code/packages/provider-pi/src/server/adapter.ts:1810`，`t3code/apps/web/src/session-logic.ts:376`）；ACP 有报告入口（`t3code/packages/provider-acp/src/server/adapter.ts:2123`）。 | 流接受前的 408、429、5xx 等按配置及退避重试，不自动重放部分消费的流，Goal 请求另有限制（`AReaL-Harness/core/engine/src/model.rs:1374`、`:1452`）；投影和状态显示重试次数（`AReaL-Harness/clients/gui/packages/workbench/client/core-model.js:249`，`AReaL-Harness/clients/gui/renderer/src/conversationPresentation.ts:246`）。 | T3 可从重试中显示到恢复、停止或耗尽，保留 provider 重试工作项；AReaL 当前状态显示次数。5/5 属截图那次事件，并非所有 provider 的统一上限。真实 provider 故障未测。 | 优先：在原失败项更新次数、等待和终态；保留当前有限重试边界。 | 已验证：按 logicalId 更新次数、等待和终态；Core 事实测试与生产 UI 检查通过。真实供应商故障未测。见 C02/E1。 |
| 3 差异：手动重试 | 失败工作行的 Retry 仅在 workspace preparation failure、run 可重试且回调存在时出现（`t3code/apps/web/src/components/chat/TimelineWorkEntryRow.tsx:207`）；普通 provider error 行无通用重试按钮。 | 失败过程尾显示状态而无通用重试按钮（`AReaL-Harness/clients/gui/renderer/src/TurnExecution.tsx:151`）；可编辑的用户消息通过 `editMessage` 重新提交，受运行、队列和未知受理限制（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:1543`，`AReaL-Harness/clients/gui/renderer/src/UserPromptEdit.tsx:49`、`:72`）。 | 两者所核查失败行都不提供通用一键重试；AReaL 编辑重发与 T3 工作区准备重试是不同动作。实际提交及恢复结果未实测。 | 优先：按错误类型给恢复动作；明确未受理才提供重发，未知受理先核对结果。 | 已验证：缺失原操作时保持 UNKNOWN；实际发送回执丢失后核对原请求，不重复上传或发送。见 C03/E1。 |
| 4 差异：模型切换与上下文交接 | 非兼容 provider 身份切换显示 pending/完成/失败 handoff 和源目标（`t3code/packages/client-runtime/src/handoff.ts:18`，`t3code/apps/web/src/components/chat/V2LifecycleRow.tsx:562`）。 | Composer 禁止运行时配置，发送带 revision 的 configure（`AReaL-Harness/clients/gui/renderer/src/Composer.tsx:605`）；Core 修改并持久化 thread configuration，发出 `areal/thread/configured` 配置事件（`AReaL-Harness/core/engine/src/desktop/state.rs:885`、`:1025`、`:1044`），后续 turn 用自己的配置解析模型（`AReaL-Harness/core/engine/src/turns.rs:273`）。Core 使用该线程上下文（`AReaL-Harness/core/engine/src/context.rs:453`）。 | 该 configure 路径发布配置事件而不创建 T3 式 handoff 时间线项；原有线程上下文由共享 Core 管理。交接摘要质量和真实跨模型结果未测。 | 优先：持久显示源模型与目标模型，说明下轮生效；继续复用 Core 上下文。 | 已验证：源/目标模型持久化，连续切换与重启不重复记录，下一轮请求使用目标模型。Core 与 UI 分层验证。见 C04/E1。 |
| 5 差异：时间 | run 时间计算 Worked for/You stopped after，steer 片段另计（`t3code/apps/web/src/components/chat/MessagesTimeline.logic.ts:1155`）；消息时间悬停或焦点显示（`t3code/apps/web/src/components/chat/TimelineRowParts.tsx:13`，`t3code/apps/web/src/components/chat/TimelineUserMessageRow.tsx:212`）。 | 主时间线首个过程组通过 `TurnProgress` 调 `TurnElapsed`；没有过程组也放置该组件（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:1669`、`:1688`，`AReaL-Harness/clients/gui/renderer/src/TurnProgress.tsx:58`）。运行中以 Core startedAt 每秒更新，断线提示待同步；终态以 durationMs 显示 Worked for（`AReaL-Harness/clients/gui/renderer/src/TurnElapsed.tsx:12`、`:38`）。主时间线用户与助手正文渲染没有消息时间元素（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:799`、`:1474`）。 | 两者均有回合耗时，AReaL 主消息行未呈现 T3 式消息时间；T3 还有 steer 分段耗时。实际格式和视觉未测。 | 优先：保留持久化耗时，补悬停/聚焦消息时间和完整时间提示。 | 已验证：Core 保存正文时间，流增量不改写；UI 聚焦显示完整日期与时区，旧历史不造时间。见 C05/E1。 |
| 6 同类能力：发送与阅读 | 发送预设新消息锚点，跟随时新 run 定位近顶部；虚拟列表留底部空间并等待布局；用户导航可取消排队滚动，返回底部尊重 reduced motion（`t3code/apps/web/src/components/chat/useTimelineFollow.ts:243`、`:271`、`:325`、`:394`、`:545`；`t3code/apps/web/src/components/chat/MessagesTimeline.tsx:819`、`:1301`）。 | 跟随、保持及恢复为不同阅读状态；响应空间和正文锚点应对布局变化，返回最新即时滚动（`AReaL-Harness/clients/gui/renderer/src/conversationReading.ts:53`，`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:593`、`:722`、`:932`、`:979`）；按 owner/revision 恢复历史锚点（`:729`、`:884`）。 | 双方均区分跟随和阅读，T3 显式在新 run 后近顶部锚定。准确视觉位置、快速发送及滚动竞争未实测。 | 优先：采用新消息近顶部锚定；发送、完成和返回最新共用阅读状态。 | 已验证：完整应用两次 Composer 发送及用户让出通过，共 400 个增量、两次主请求，全文匹配。见 C06/E2。 |
| 7 差异：折叠、流与动效 | run、工作组、attempt 分别保存展开状态，展开时暂停末尾维护（`t3code/apps/web/src/components/chat/MessagesTimeline.tsx:404`、`:445`、`:489`）；run 状态和时间戳排除出共享 row context，使用 LegendList（`:697`、`:1301`）。 | 人工展开选择保留；仅进行中、连接正常且没有重试或待处理交互时动画（`AReaL-Harness/clients/gui/renderer/src/TurnExecution.tsx:30`、`:44`）；尺寸变化和阅读锚点处理见 `AReaL-Harness/clients/gui/renderer/src/Messages.tsx:596`，动效要求见 `AReaL-Harness/clients/gui/renderer/src/Messages.md:83`。 | T3 的细粒度展开集合和虚拟列表是源码机制；AReaL 按过程组及阅读状态组织。动画中断、帧率和桌面视觉未测，不作性能结论。 | 保留人工展开选择；先验证阅读稳定，再选择局部渲染优化。 | 部分完成：生产历史夹具通过折叠、延迟图片增高与锚点检查；整体帧率和性能对照待完成。见 P03/E3。 |

## 性能与动效机制（源码对照，未作性能测量）

| 维度 | T3 Code | AReaL | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- |
| 发送后定位 | 跟随中将新 turn 用户消息定位近顶部，锚点准备后以动画滚动（`t3code/apps/web/src/components/chat/useTimelineFollow.ts:271`、`:394`、`:428`）。 | 保留响应空间并通过阅读状态及布局校正处理（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:932`、`:962`）。 | 优先：先定义并验收新用户消息的定位，再调整过渡效果。 | 已验证：首发 32px、续发 31.92px；上滚后继续输出不抢回。见 P01/E2。 |
| smooth / instant | 锚点滚动在非 reduced motion 时 animated；返回尾部的 `scrollToEnd(animated=false)` 默认即时，调用方可请求动画（`t3code/apps/web/src/components/chat/useTimelineFollow.ts:325`、`:428`）。 | 返回最新使用即时 `scrollTo`，避免将动画帧误判为用户离开（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:722`）。 | 保留返回最新的即时定位；发送动画单独评审，并遵守减少动态效果设置。 | 沿用返回最新的即时定位；normal/reduced motion 组件路径通过。未新增发送滚动动画。见 P01/E2。 |
| 折叠与 reduced motion | 具体工作行箭头有 200ms transform（`t3code/apps/web/src/components/chat/TimelineWorkEntryRow.tsx:500`）；通用 Collapsible 支持可选 200ms 高度过渡及 motion-reduce 禁用（`t3code/apps/web/src/components/ui/collapsible.tsx:19`），不能推断所有工作组使用此组件。滚动动画检查系统偏好（`t3code/apps/web/src/components/chat/useTimelineFollow.ts:338`）。 | 过程高度过渡 300ms，reduced motion 下关闭（`AReaL-Harness/clients/gui/renderer/src/workbench.css:2407`）；活动动画依赖状态（`AReaL-Harness/clients/gui/renderer/src/TurnExecution.tsx:44`）。 | 保留现有可逆折叠；用连续录屏比较后统一局部节奏，不直接替换全局时长。 | 部分完成：保留现有可逆折叠，normal/reduced motion 组件检查及历史夹具通过；连续录屏节奏对比未完成。见 E2、E3。 |
| 背景流与动画 | 流投影保持不变的 shell/行身份，流文本增量更新（`t3code/packages/client-runtime/src/state/threadShell.ts:137`、`:365`，`t3code/apps/web/src/components/chat/useTimelineRows.ts:38`）；可见动画在文档不可见或不相交时暂停（`t3code/apps/web/src/lib/visibleAnimation.ts:12`）。这不意味着后台流停止接收。 | 投影按通知更新内容，增量时清理重试状态（`AReaL-Harness/clients/gui/packages/workbench/client/core-model.js:234`、`:273`）；助手正文区分 streaming（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:799`）。这里没有据此推断隐藏窗口是否节流。 | 先测：统计后台更新与动画开销；只暂停不可见动画，不停止必要状态同步。 | 进行中：后台探针进入执行；不可见动画与同步开销尚无最终测量结论。见 P05/E6。 |
| 历史挂载 | 使用 LegendList 及恢复线程位置（`t3code/apps/web/src/components/chat/MessagesTimeline.tsx:723`、`:1301`）。 | 过程内容首次展开后 keepMounted（`AReaL-Harness/clients/gui/renderer/src/TurnProgress.tsx:13`、`:91`）；历史窗口按阅读锚点确保数据（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:884`，`AReaL-Harness/clients/gui/renderer/src/Messages.md:85`）。 | 先测：记录长历史 DOM、内存和选择行为；确认热点后再决定虚拟化范围。 | 部分完成：生产历史夹具通过分页、六页活动轮恢复和锚点检查；长历史 DOM、heap、选区预算最终审计未完成。见 P06/E3、E6。 |
| 节流与缓存 | 返回底部按钮显示防抖 150ms（`t3code/apps/web/src/components/chat/useTimelineFollow.ts:67`）；稳定行和增量投影复用（`t3code/apps/web/src/components/chat/useTimelineRows.ts:15`、`:42`、`:62`）。 | 阅读布局用 requestAnimationFrame 合并调度（`AReaL-Harness/clients/gui/renderer/src/Messages.tsx:1003`、`:1128`）；历史正文分页缓存规则见 `AReaL-Harness/clients/gui/renderer/src/Messages.md:85`。未在所查投影路径中确认统一流节流时长。 | 先测：统计重复派生与布局次数，再加有界缓存或节流，避免延迟重要状态。 | 部分完成：流式输入已有样本与源码归因；前后对照未完成，未据此新增节流或缓存。见 P02、P07/E5。 |

## 测试入口映射（仅定位，未执行）

- T3 provider 重试中间态、耗尽、恢复和中断：`t3code/packages/provider-pi/src/server/adapter.test.ts:3669`、`:3828`、`:3879`；展示逻辑 `t3code/apps/web/src/session-logic.test.ts:181`。
- T3 handoff 推导与后端策略：`t3code/packages/client-runtime/src/handoff.test.ts:89`、`t3code/apps/server/src/orchestration-v2/ContextHandoffService.test.ts:74`、`t3code/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.test.ts:87`。
- T3 时间线实际浏览器测试入口：`t3code/apps/web/src/components/chat/MessagesTimeline.browser.test.tsx:236`；覆盖范围须逐案例核对。
- AReaL 过程终态：`AReaL-Harness/clients/gui/renderer/src/TurnProgress.test.tsx:14`；重试类型与策略：`AReaL-Harness/core/engine/src/model.rs:2000`；实际阅读路径和布局需求对应 `AReaL-Harness/clients/gui/renderer/src/Messages.md:85`。真实 GUI 验收应按仓库 `verify-areal-harness` 技能及对应场景 E2E 运行；这些入口的存在不代表本次测试通过。

## 文件链接、标签与工作区动作

| ID | 项目 | T3 Code | AReaL | 分类与证据 | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- | --- | --- |
| L01 | 消息文件链接的行定位 | 将文件路径、行号及 reveal 请求传入面板；同文件复用标签并更新定位 | 打开链路只传路径，没有该行定位请求 | 缺失；T3 `apps/web/src/components/chat/MarkdownFileLink.tsx:110`、`apps/web/src/rightPanelStore.ts:729`；AReaL `clients/gui/renderer/src/state/useWorkspaceDocuments.tsx:20`、`clients/gui/renderer/src/state/useWorkspacePanels.ts:249` | 优先：补路径加行号定位；同一文件重复点击更新目标，限定正确 worktree。 | 已验证：路径加行号、同文件 120/220 行重复定位、特殊文件名与执行目录归属。行定位为生产组件检查，归属另有实际包请求。见 E1。 |
| L02 | 文件树揭示 | 加载祖先、清理外部定位时的搜索、选择并滚动到文件 | 展开父目录并选择；该 effect 没有清搜索或滚动到选择项 | 差异；T3 `apps/web/src/components/files/FileBrowserPanel.tsx:411`；AReaL `clients/gui/renderer/src/workspace-file-tree/WorkspaceFileTree.tsx:59` | 优先：外部定位时揭示并滚动到文件；保留用户返回原搜索的入口。 | 已验证：揭示后选中并滚动，等待祖先目录加载，支持返回原搜索；生产组件与宿主文件夹检查通过。见 E1。 |
| L03 | 标签批量关闭 | Close others、Close right、Close all | 关闭其他、关闭全部；没有关闭右侧菜单 | 缺失：关闭右侧标签；T3 `apps/web/src/components/RightPanelTabs.tsx:1080`；AReaL `clients/gui/renderer/src/app-shell/SidePane.tsx:364` | 后续：在既有标签菜单补关闭右侧，复用未保存保护。 | 未开始：关闭右侧标签未进入本轮；沿用既有关闭其他与全部。 |
| L04 | 标签保留 | file:path 复用 surface 并按 Thread 保存状态 | 单独的临时预览标签；编辑后固定；脏文件保护后才替换 | 差异；T3 `apps/web/src/rightPanelStore.ts:729`；AReaL `clients/gui/renderer/src/state/useWorkspacePanels.ts:249`、`clients/gui/renderer/src/state/useWorkspaceDocuments.tsx:47` | 保留当前预览、固定和编辑后固定规则，补清晰的视觉区分。 | 沿用预览、固定和脏文件保护；本轮未新增标签视觉方案。 |
| W01 | 项目 Actions | 新增、编辑、导入项目脚本；从当前工作区终端运行 | 有终端与 worktree 环境配置；没有同类通用项目脚本菜单 | 缺失：项目脚本管理/运行入口；T3 `apps/web/src/components/ProjectScriptsControl.tsx:177`、`apps/web/src/components/chat/useChatTerminalActions.ts:197`；AReaL `clients/gui/renderer/src/ConversationStatusCard.tsx:190`、`clients/gui/renderer/src/terminal/TerminalPane.tsx:170` | 后续：先做项目命令的新增、编辑和运行；复用现有终端，导入及生命周期钩子后续。 | 未开始：项目命令管理、导入及运行入口属于后续。 |
| W02 | 当前 Thread 分支切换 | 搜索/创建/切换；新 worktree 基础分支选择不等于立即 checkout | 有新任务基础分支选择与 Diff 分支比较；没有当前线程的等价 checkout 入口 | 缺失；T3 `apps/web/src/components/BranchToolbarBranchSelector.tsx:217`、`:383`；AReaL `clients/gui/renderer/src/WorktreeStarter.tsx:98`、`clients/gui/packages/workbench/client/desktop-contract/workspace.cjs:11` | 后续：先补当前工作区分支选择；运行中的任务禁用切换，创建与 checkout 明确区分。 | 未开始：当前线程 checkout 入口属于后续；保留新任务基础分支选择与 Diff 分支比较。 |
| W03 | 工作区外部打开 | Thread details 的 Open in 以当前执行工作区为对象 | 项目导航菜单能打开/定位目录；文件预览能选默认打开应用 | 差异：入口和对象；T3 `apps/web/src/components/chat/OpenInPicker.tsx:232`；AReaL `clients/gui/renderer/src/views/ConversationNavigation.tsx:288`、`clients/gui/renderer/src/WorkspaceFilePane.tsx:231` | 优先：在详情卡增加打开当前执行工作区，复用现有外部打开服务。 | 已验证：详情卡携线程身份打开实际执行 worktree，Main 请求与 Finder 观察一致；Finder AX 原观察仅保留在报告。见 E1。 |
| W04 | 详情卡组织 | 工作区、Open、Actions、分支、Git、Changes 集中；按空间改变密度 | 资源卡主要组织 Changes、worktree、子代理、来源；Git 操作在审查面板 | 差异；T3 `apps/web/src/components/chat/ThreadDetailsPanel.tsx:146`；AReaL `clients/gui/renderer/src/ConversationStatusCard.tsx:190`、`clients/gui/renderer/src/GitPane.tsx:913` | 优先：收拢环境、工作区、分支和 Changes；Git 详细动作继续进入现有审查面板。 | 已验证：本地 worktree 卡集中显示环境、目录、分支和 Changes，进入同线程审查；云端全组合未测。见 E1。 |

「项目 Actions」运行 shell 命令，其状态与终端相关。T3 所查脚本菜单没有独立 Stop 动作；不能把它当完整任务管理器。AReaL 文件树已有「添加到对话」，项目菜单已有外部打开；这些能力不列为缺失。


## Browser：具体动作

| 分类 / 动作 | T3 | AReaL | 差异与源码证据 | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- | --- |
| 差异：登录与 profile | 按 profile 建立独立 partition，入口可选 profile，支持持久和临时 partition | 各项目共享同一持久 profile；支持导入 Chrome 数据 | `T3 apps/web/src/components/RightPanelTabs.tsx:484`、`apps/desktop/src/preview/BrowserSession.ts:15`、`:271`；`A docs/api/browser.md:7`、`clients/gui/renderer/src/settings/BrowserDataSettings.tsx`。 | 后续：默认沿用共享登录；增加显式 profile 选择，说明隔离范围与登录数据归属。 | 未开始：多 profile 选择属于后续；沿用共享登录配置。 |
| 差异：浮动 | 线程内 MiniPlayer 可打开、拖动/调整大小并返回面板 | 预览是主窗口内原生 WebContentsView；当前 GUI 没有对应聊天内浮动预览入口 | `T3 apps/web/src/components/preview/PreviewView.tsx:404`、`apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx:583`；`A clients/gui/app/src/core/preview-native/presentation.cjs:9`、`clients/gui/app/src/core/main.cjs:635`。A smoke 的 `previewWindowState` 指 `getAllWindows()[0]` 主窗口，并非独立预览窗（`clients/gui/scripts/migration-smoke.mjs:1014`）。 | 暂缓：先打磨固定分屏；确认持续同时查看网页和聊天的需求后再做浮动。 | 未开始：浮动预览暂缓；沿用固定面板。 |
| 差异：设备视口 | 手机/平板等预设，宽高、锁比例及旋转 | 响应式开关和宽度输入（240–2560），未见设备预设、单独高度及旋转控件 | `T3 apps/web/src/browser/BrowserDeviceToolbar.tsx:126`、`:137`、`:191`、`:241`；`packages/shared/src/previewViewport.ts:22`；`A clients/gui/renderer/src/Preview.tsx:1181`。 | 优先：补常用设备预设、宽高和旋转；继续使用真实浏览器视口。 | 已验证：手机/平板、旋转、连续宽高提交与 auto 通过；实际 native 视口 240×2560，包含窄窗和 GUI 缩放观察。见 B01/E1。 |
| 同类能力 / 差异：Agent 控制 | Agent host、自动化 broker 和共享页面活动 | `browser_v1` 经 Core 审批后观察、截图、动作；人工接管撤销控制代次，UNKNOWN 不重放 | `T3 apps/desktop/src/preview/DesktopBrowserHost.ts:213`、`apps/server/src/mcp/PreviewAutomationBroker.ts`；`A docs/api/browser.md:7`、`:25`。两侧授权模型不同；本报告不判定其恢复语义等价。 | 保留 Core 审批与人工接管；补清晰的控制状态和接管入口。 | 沿用 Core 审批与人工接管；UNKNOWN 检查、取消保草稿及显式继续路径通过。未另增一套控制模型。见 B02/E1。 |
| 差异：错误和权限 | 剪贴板读取按 origin 决策，失败页可 Reload | Core 页面审批及宿主错误区分 not_sent / unknown | `T3 apps/desktop/src/preview/BrowserSession.ts:317`、`apps/web/src/components/preview/PreviewUnreachable.tsx:104`；`A clients/gui/app/src/core/browser-host-request.cjs:60`、`docs/api/browser.md:215`。 | 优先：区分加载失败、权限拒绝和未知动作；刷新页面与重试动作分开。 | 已验证：加载错误提供页面刷新，权限拒绝保留原因且不提供错误刷新；UNKNOWN 原动作不重放。见 B02/E1。 |

## Terminal：具体动作

| 分类 / 动作 | T3 | AReaL | 差异与源码证据 | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- | --- |
| 缺失：面板内分屏 | 支持横向/纵向终端组和分屏动作 | 终端面板按 active 渲染一个 TerminalSession，状态无 split tree | `T3 apps/web/src/components/ThreadTerminalDrawer.tsx:1249`、`:1798`；`A clients/gui/renderer/src/terminal/TerminalPane.tsx:170`、`:240`、`terminalWorkspace.ts:7`。A 工作台聊天/面板 split 不属于终端分屏。 | 后续：补终端组及横竖分屏；复用现有会话身份，不因换布局重启 PTY。 | 未开始：终端组和横竖分屏属于后续。 |
| 本仓独有：生命周期选择 | 所查 UI 使用线程终端 | 新终端可选 Thread 或 Turn，后者需正在执行任务并由 Core 校验 | `T3 apps/web/src/components/terminal/useThreadTerminalActions.ts:95`；`A clients/gui/renderer/src/terminal/TerminalPane.tsx:189`。 | 保留 Thread/Turn 选择，创建时说明终止条件。 | 沿用 Thread/Turn 选择；本轮未改终止条件。 |
| 差异：关闭 | 请求关闭并删除历史；失败尝试发送 exit | 显式关闭释放 registry 并终止进程，组件卸载只 detach | `T3 apps/web/src/components/terminal/useThreadTerminalActions.ts:115`；`A clients/gui/renderer/src/terminal/terminalWorkspace.ts:74`、`TerminalSession.tsx:343`、`:540`。 | 保留卸载与终止分离；明确区分隐藏面板、关闭会话和终止进程。 | 沿用卸载与终止分离；终端 service 的 detach 不新建、不终止进程回归通过，完整 PTY 验收待完成。见 P08/E6。 |
| 差异：历史和保活 | 服务端保留最多 5000 行、8 MiB 历史 | 侧栏 PTY/scrollback 通过 registry 在卸载重挂时保活 | `T3 docs/user/terminal.md:3`、`apps/server/src/terminal/Manager.ts:93`；`A clients/gui/renderer/src/terminal/TerminalSession.tsx:118`。服务重启后行为未验证。 | 先测：验证重挂与输出缺口；再确定历史预算，不照搬 T3 行数限制。 | 部分完成：早期 20 行重挂有证据但 runner 最终失败；500 行、真实淘汰缺口和预算验收待完成，尚未调整历史预算。见 P08/E5、E6。 |


## Device

| 功能 | T3 Code | AReaL | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- |
| 设备发现与选择 | 发现运行设备并启动受支持的模拟器 | 没有同类设备工作台；手机 Remote 是另一产品路径 | 暂缓：独立成设备开发专项；先确认目标平台和使用任务。 | 未开始：设备工作台暂缓，未增加发现或启动入口。 |
| 屏幕与手动输入 | 提供屏幕流、点击、拖动和键盘输入 | 没有同类模拟器面板 | 后续：如采纳设备专项，先做只读屏幕与明确的人工控制。 | 未开始：依赖设备专项，尚无新增屏幕或人工控制入口。 |
| Agent 设备控制 | 提供设备工具并绑定线程、宿主与设备 | 本机 computer_v1 不等于同类设备工具 | 后续：屏幕和手动控制稳定后接入 Agent，沿既有权限所有者授权。 | 未开始：依赖屏幕和手动控制；未新增设备工具授权链。 |
| 生命周期与断线 | 关闭观看、设备关机、断线重连分别处理 | 没有同类设备生命周期入口 | 后续：设备专项中明确区分停止观看与关机，先覆盖断线恢复。 | 未开始：设备专项未启动，未新增观看/关机/重连流程。 |
| 设备设置与平台 | 提供平台相关工具；依赖 SDK、宿主和流媒体组件 | 没有同类设备设置面板 | 暂缓：先限定一种平台，暂不同时覆盖 3D、折叠机与远端租用。 | 未开始：平台选择与 SDK 集成暂缓。 |

**证据说明**

- **真实含义与范围**：T3 Device 是线程旁观看并操控 iOS Simulator、Android Emulator 或部分物理 Android 的设备屏幕；可选择运行设备或启动已停止设备，多个 tab，关闭观看不等于关机（`docs/user/devices.md:3`、`:8`、`:15`、`:31`）。`DevicePanel` 按线程归属启动及关机（`apps/web/src/components/device/DevicePanel.tsx:57`、`:95`、`:120`、`:150`）。A 的 `clients/gui/app/src/core/remote-devices.cjs` 和 `clients/gui/renderer/src/settings/MobileDevices.tsx` 属于手机 Remote 配对/客户端管理；不能把它当模拟器屏幕或输入控制。A 的 GUI SidePane 入口提供 terminal 和 browser，没有模拟器 Device 工作台（`clients/gui/renderer/src/app-shell/SidePane.tsx:246`、`:256`）；当前 Core 桌面工具目录公开 `computer_v1` 控制本机授权应用（`core/protocol/src/desktop.rs:8`），与 T3 模拟器发现、流和设备生命周期 UI 是不同能力。A Android Remote 是手机作为客户端远控桌面（`docs/features.md:24`），并非 Android 自动化工具或模拟器控制台；通过 shell/外部工具调用 Android SDK 的可能性不构成内置 Device UI。
- **手动与工具操作**：T3 支持点击、拖动、键盘、Android Home/Back/Recents、iOS 旋转、关机，设备工具支持外观、文字大小、无障碍、位置、权限等，具体依平台和宿主（`docs/user/devices.md:31`、`:43`；`apps/web/src/components/device/DeviceToolsPanel.tsx:297`）。3D 和折叠机姿态有支持范围（`docs/user/devices.md:37`；`apps/web/src/components/device/DeviceStreamView.tsx:218`）。A 无已确认对应操作。Agent 可通过 `device_*`/`agent-device` 控制，访问由独立设置开启，session 身份包含 thread、host、device（`docs/user/devices.md:49`；`apps/server/src/device/DeviceService.ts:459`；`apps/server/src/device/AgentDeviceTarget.ts:42`）。这也不同于浏览器响应式视口模拟。
- **权限、流与失败**：T3 仅可见 surface 建流（`apps/web/src/components/device/DeviceStreamView.tsx:116`），输入断开显示重连，视频错误可重试并刷新过期票据（`:453`、`:468`、`:482`）；设备操作有线程作用域与失败显示（`apps/web/src/components/device/DevicePanel.tsx:62`、`:95`、`:229`）。关掉设备支持停止 helper，模拟器不自动关机（`docs/user/devices.md:15`）。SSH 中断可恢复；Simlock 关闭归还租约并擦除，工具能力受限（`docs/user/devices.md:83`、`:105`）。A Remote 的连接和权限属于另一产品路径，本次不作等价结论。
- **平台与性能**：iOS Simulator 要 macOS/Xcode；Android 要 SDK、模拟器与虚拟设备，模拟器视频需 ffmpeg/libx264；远程非安全 HTTP 上 iOS 降级静态图、Android 无视频（`docs/user/devices.md:21`、`:25`、`:67`）。T3 仅可见 tab 流式播放、设备模型 3D 使用 H.264（`docs/user/devices.md:11`；`apps/web/src/components/device/DeviceStreamView.tsx:218`）。未测真机、远端、SSH、Simlock、视频帧率、延迟、流量或设备工具权限。


## 文件类型：工作区文件与消息内容分开

T3 的分派在 `apps/web/src/components/files/FilePreviewPanel.tsx:1015`、`:1328`；AReaL 文件窗格只有 Markdown 特判，其余可读文本进源码视图（`clients/gui/renderer/src/WorkspaceFilePane.tsx:263`、`:454`、`:464`、`:500`）。下表为静态路径，具体编码、损坏或超限文件可能被拒绝。

| 类型 | T3 工作区文件 | AReaL 工作区文件 / 消息引用 | 推荐方案 | 执行情况 |
|---|---|---| --- | --- |
| PDF | 内嵌浏览器文档预览（`FilePreviewPanel.tsx:1019`、`:1379`） | 消息文件卡外部打开（`clients/gui/renderer/src/WorkspaceMedia.tsx:28`、`:68`；`Messages.tsx:768`）；文件窗格无 PDF 专用 viewer | 优先：补只读 PDF 内嵌预览，同时保留外部打开。 | 已验证：本机 ad-hoc 包双页、125%、重开、损坏提示与 worker 释放通过；修复响应 MIME。保留外部打开入口，未专项实点。见 F01/E1。 |
| Office | 内嵌 docx/xlsx/pptx、ODF 等预览（`packages/shared/src/filePreview.ts:134`；`apps/web/src/components/files/OfficeViewer.tsx:53`） | 消息中的 doc/xls/ppt 系列卡片外部打开（`WorkspaceMedia.tsx:41`、`:68`）；文件窗格无 Office viewer | 后续：有实际文档任务后逐类接入只读预览；先保留外部应用入口。 | 未开始：未新增 Office viewer，沿用外部打开。 |
| Notebook | `.ipynb` 解析并显示保存的 cell/output，非执行；限 v4、8 MB、500 cells（`apps/web/src/components/files/extendedDocumentPreview.ts:426`） | 文件窗格按文本读取后显示 JSON 源码，无 notebook viewer（`WorkspaceFilePane.tsx:500`） | 后续：先补只读 cell/output 展示，继续提供 JSON 源码；执行另列范围。 | 未开始：未新增 cell/output 预览，沿用 JSON 源码。 |
| Font | 字体内嵌预览（`FilePreviewPanel.tsx:1023`；`apps/web/src/components/files/FontFilePreview.tsx:5`） | 无字体专用预览分派；二进制读取可能失败，可外部打开（`WorkspaceFilePane.tsx:134`、`:231`、`:500`） | 暂缓：沿用外部应用；先满足代码与常用文档阅读。 | 未开始：字体预览暂缓，沿用外部应用。 |
| Markdown | 渲染 / 源码切换，rendered task checkbox 可写（`FilePreviewPanel.tsx:906`、`:1097`） | 渲染 / 源码切换，渲染视图可编辑并失焦保存（`WorkspaceFilePane.tsx:301`、`:464`） | 保留渲染编辑与源码切换；强化未保存状态、失焦保存失败和版本冲突提示。 | 沿用渲染编辑与源码切换；本轮未新增保存失败或冲突交互。 |
| CSV / TSV | 文件内表格预览及源码切换（`FilePreviewPanel.tsx:1483`） | 工作区 CSV/TSV 按文本进文件窗格源码（`WorkspaceMedia.tsx:53`；`WorkspaceFilePane.tsx:500`）。消息中的 Markdown 表格另有下载 CSV、扩大预览（`clients/gui/packages/ui/src/conversation/markdown-table/markdown-table.tsx:395`）；这不等于 CSV 文件表格渲染 | 优先：补文件表格预览及源码切换；大文件明确分页或截断。 | 已验证：表格/源码切换，最多 200 行、100 列并提示截断；CSV 有包内证据，TSV 与边界有组件/单测证据。见 F02/E1。 |
| Mermaid | `.mmd`/`.mermaid` 文件图形 / 源码（`FilePreviewPanel.tsx:1086`、`:1466`） | 独立文件按文本源码；消息 Markdown 的 Mermaid 围栏有图形预览（`clients/gui/packages/ui/src/conversation/message-code-block/message-code-block.md:34`） | 优先：复用既有 Mermaid 渲染器，为独立文件增加图形/源码切换。 | 已验证：独立文件图形/源码切换，包内 SVG 通过；错误语法组件保留源码。见 F03/E1。 |
| HTML | 页面 / 源码切换（`FilePreviewPanel.tsx:1025`、`:1099`、`:1379`） | 文件窗格为源码；另有浏览器页面预览入口，不能推断它自动渲染工作区 HTML 文件（`WorkspaceFilePane.tsx:500`） | 后续：增加显式页面预览，复用受限浏览器宿主；不默认执行任意文件内容。 | 未开始：未新增工作区 HTML 页面预览。 |
| Audio / video | 内嵌播放器（`FilePreviewPanel.tsx:1347`、`:1358`） | 消息引用列出的 mp3/wav/mp4/mov/webm 以卡片外部打开（`WorkspaceMedia.tsx:46`、`:68`）；文件窗格无播放器 | 后续：先支持常用格式的只读播放，保留外部打开，不扩展到媒体编辑。 | 未开始：未新增内嵌播放器，沿用外部打开。 |

AReaL 项目菜单有外部打开和 reveal（`clients/gui/renderer/src/views/ConversationNavigation.tsx:289`、`:307`）；文件树“添加到对话”（`workspace-file-tree/WorkspaceFileTreeRowView.tsx:141`）。消息里的 PNG/JPEG/GIF/WebP 另有内嵌图片预览（`WorkspaceMedia.tsx:24`、`:79`）。

## Diff、评论与恢复

| 功能 | T3 Code | AReaL | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- |
| 比较范围 | 分支、未提交、轮次及工具调用变更 | 另细分暂存、未暂存、commit 与 task | 保留现有细分范围；默认明确显示当前比较对象。 | 沿用现有细分范围；真实 staged/unstaged、branch/ref 和轮次切换恢复通过。见 D01/E1、E7。 |
| 文件导航与布局 | 文件选择、搜索、折叠及 split/stacked | 已有文件树、位置恢复、布局与空白设置 | 优先：统一文件树、正文定位和范围切换后的阅读位置。 | 已验证：两轮各自恢复筛选、选中文件与正文位置 700px/1200px；分支和暂存范围也有检查。见 D01/E7。 |
| 本地行评论 | 写入对话草稿 | 带版本身份的评论写入草稿 | 保留现有过期检查；优先打磨选区、删除及带回输入的完整路径。 | 已验证：新增/删除侧多行选区、保存、删除、带回 Composer；过期评论脱离新 Diff 行，发送保留原代码与版本说明。见 D02/E1。 |
| 大 Diff 加载 | 满足条件时按文件加载 patch | 沿当前审查读取路径显示内容 | 先测：记录首次可读时间、处理字节和内存；有热点再分批读取。 | 部分完成：实际 5000 删除＋5000 新增有字节、内存与诊断；worker 候选真实高亮和评论通过，仍隔离，正式五轮 A/B 未完成。见 P09/E4、E5。 |
| 对话回退与文件恢复 | 提供恢复文件或保留修改的选择 | 编辑消息不撤销已经完成的文件动作 | 后续：另立可恢复性专项；先保留明确文案，不用历史编辑冒充文件回退。 | 未开始：未新增回退并还原文件的 UI，属于后续专项。 |

**证据说明**

T3 选择 branch、uncommitted、轮次及工具调用变更，branch 可搜索本地/远程 base；面板记忆每范围折叠状态，有展开/收起、split/stacked、文件定位和搜索；轮次是 checkpoint 范围（`apps/web/src/components/DiffPanel.tsx:267`、`:334`、`:459`、`:556`、`:619`、`:687`、`:821`、`:934`、`:955`、`:1231`）。按需加载文件 patch 和视区触发后续批次（`:502`、`:574`，`components/diffs/DiffFileLoadingBoundary.tsx:18`）；这是机制证据，未测性能收益。

AReaL 的范围更细：last-turn、选定 turn、uncommitted、unstaged、staged、commit、branch、task（`clients/gui/renderer/src/GitPane.tsx:146`、`:253`；`clients/gui/packages/workspace-git/index.js:394`）。commit 只是选择比较，不 checkout；branch 计算 merge-base；未跟踪文件纳入指定范围（`index.js:340`、`:419`、`:484`）。它有树和滚动位置恢复、布局/空白等设置（`GitPane.tsx:165`、`:198`、`:512`），不能把范围或导航笼统描述为缺失。

两者的本地行范围评论都能形成给会话的草稿：T3 的 `apps/web/src/components/diffs/AnnotatableCodeView.browser.test.tsx:132` 展示 draft 与写入 composer；AReaL 在 `GitPane.tsx:532` 捕获，`:571` 以 token 标记过期，`:616` 附加到草稿，`reviewComments.ts` 负责持久化。它们都不等于提交远端 PR review。T3 支持对话回退时选择同时还原文件或保留修改（`apps/web/src/components/chat/ChatOverlayHosts.tsx:193`）；AReaL 的 `restoreTrees` 先按版本验证再 reverse apply（`clients/gui/packages/workspace-git/index.js:254`、`:321`），全 GUI 源码检索仅见定义和导出（`:824`），没有实际调用和轮次撤销 UI；编辑消息文案明确已完成动作不撤销（`clients/gui/renderer/src/i18n/messages/common.ts:64`）。所以不存在已确认的对话回退及“恢复文件/保留文件”选择；编辑消息后继续执行时已完成的文件修改保留。

## PR / Linked PR

| 功能 | T3 Code | AReaL | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- |
| 对话关联 PR | link/unlink 与关联上下文 | 没有同类 Linked PR 工作台 | 后续：PR 第一步只做 URL 关联和只读状态，复用当前对话身份。 | 未开始：未新增 URL 关联或 Linked PR 工作台。 |
| PR 列表与筛选 | 按仓库、状态及参与角色查询 | 没有内建 PR 列表 | 后续：先支持当前项目与一种托管平台，不先做跨平台聚合。 | 未开始：未新增项目 PR 列表和筛选。 |
| 详情、checks 与提交 | 在 PR 工作台中读取 | 没有对应工作台 | 后续：与关联 PR 一起做只读详情，显示来源与刷新状态。 | 未开始：未新增只读 PR 详情、checks 或提交页。 |
| PR Diff 与已阅状态 | 远端变更、文件已阅和 PR 相关导航 | 本地 Diff 不包含远端 PR 已阅状态 | 后续：复用 Diff 阅读器；把远端版本与本地工作区版本分开。 | 未开始：未新增远端 PR Diff 或已阅记录。 |
| 评论、回复与 review | 按主机能力执行远端审查 | 现有行评论只进入本地草稿 | 后续：只读链路稳定后增加显式提交，清楚显示目标 PR 与版本。 | 未开始：现有评论仍进入本地草稿，未新增远端提交。 |
| 创建 PR | 独立动作或提交/推送/创建的组合动作 | 没有内建创建 PR 动作 | 后续：先做独立创建流程；复用现有提交和推送回执。 | 未开始：未新增内建创建 PR 流程。 |
| 合并、关闭与自动合并 | 按主机能力和权限提供 | 没有对应内建动作 | 暂缓：先完成阅读与审查，不将全部远端管理动作纳入首批。 | 未开始：远端 PR 管理暂缓。 |
| 多平台、stack 与 watch | 能力随 provider 改变 | 没有同类工作台 | 暂缓：先验证一种平台；有明确消费者后再扩展。 | 未开始：多平台与 watch 暂缓。 |

**证据说明**

T3 有跨仓库 PR 列表、状态/参与角色及草稿、审查和 checks 筛选，详情包括状态、checks、diff、commits、评论/审查、reviewers、labels、viewed 文件、stack；契约在 `packages/contracts/src/pullRequest.ts:17`、`:38`、`:231`、`:260`、`:555`、`:627`。操作包括 merge/squash/rebase、ready/draft、close/reopen、删除或更新分支、auto-merge、revert、批准 workflow；评论、回复、resolve、审查结论、编辑及 reactions 由 provider 能力和权限决定（`:57`、`:60`、`:231`、`:260`）。GitHub、GitLab、Bitbucket、Forgejo、GitCafe 各有独立 source-control 包，支持集不同；例如 Bitbucket 定义注明不支持 reopen（`packages/source-control-bitbucket/src/shared/definition.ts:91`）。所以不能声称所有主机均具备全套操作。

T3 的会话可 link/unlink PR，兼容模式和 URL 决定能否绑定（`apps/web/src/hooks/usePullRequestLinking.ts:22`、`:33`、`:52`）；thread 与 PR 可相互关联、提供上下文卡（`packages/contracts/src/pullRequest.ts:429`；`apps/web/src/components/PullRequestContextDetails.tsx:12`）。相关客户端还区分多链接、watch 和停止 watch（`packages/client-runtime/src/t3ToolSummary.ts:392`）。PR 主机审查与本地 Diff 评论是不同写入对象。对 AReaL 的 renderer、Electron core、workbench、workspace-git 搜索 pull request / merge request / GitHub / GitLab：未发现独立 PR 列表、详情、主机审查和 linked PR 工作台；workspace 请求含文件、review、Git 基本操作（`clients/gui/packages/workbench/client/desktop-contract/workspace.cjs:11`）。GitHub Connector 是插件配置（`clients/gui/renderer/src/settings/PluginCenter.tsx:2073`），并非 PR 工作台；Agent 在获得工具和授权后可能通过 CLI、浏览器或插件操作 PR，不能据此视作内建工作台。

## Git、分支与上下文

| 功能 | T3 Code | AReaL | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- |
| 提交/推送组合 | 按仓库状态提供组合主动作 | 暂存、提交与推送分别执行 | 后续：先增加稳定命名的快捷入口，沿原动作顺序执行并逐步读回结果。 | 未开始：未新增组合入口，沿用独立暂存、提交和推送。 |
| Pull | 按分支状态提供拉取动作 | 没有对应 GUI 动作 | 后续：先提供显式拉取；分叉或冲突时显示结果，不自动猜测合并策略。 | 未开始：未新增 GUI Pull 入口。 |
| 首次推送分支 | 专用发布流程 | 指定 remote 与目标分支的推送可以创建远程分支 | 保留现有能力，补“创建远程分支”的说明，不重复建设发布机制。 | 沿用指定 remote/目标分支推送；未另建发布机制或新增说明交互。 |
| 新建远端仓库 | 有发布仓库路径 | 没有对应内建入口 | 暂缓：先满足现有仓库协作，远端仓库创建单列需求。 | 未开始：远端仓库创建暂缓。 |

**证据说明**

T3 依据状态选 Commit、Push、Pull、组合 commit/push/create PR 和发布仓库；无 upstream 时可推到 primary remote，分叉状态提示先同步；默认分支动作有确认和创建 feature ref 路径（`apps/web/src/components/GitActionsControl.logic.ts:116`、`:164`、`:184`、`:216`、`:232`、`:271`、`:329`）。分支 picker 搜索分页，说明远程跟踪 base 的选择（`apps/web/src/components/BranchPicker.tsx:71`、`:229`）；执行上下文可选环境、workspace/worktree，路径可复制（`apps/web/src/components/BranchToolbar.tsx:106`、`:319`、`:399`）。PR context 卡展示关联状态（`PullRequestContextDetails.tsx:12`）。这些 selector、卡片与 PR 标签应分别比较，不能合并为纯视觉标签。

AReaL 具有暂存/取消暂存、提交和明确选择 remote / target branch 的 push（`clients/gui/renderer/src/GitActions.tsx:40`、`:352`；`clients/gui/packages/workspace-git/index.js:589`）。纠正：`:619` 校验目标 ref，`:624` 将预览 SHA 固定，`:638` 推送 `<SHA>:refs/heads/<destination>`，可以创建远程分支；尚未发现对应的一键创建远端仓库、组合创建 PR 或同等基于状态的 Git launcher，不能说没有 publish branch 能力。

## 可复用验证入口与边界

T3 现有 `apps/web/src/components/files/FileBrowserPanel.browser.test.tsx`、`FilePreviewPanel.test.ts`、`files/fileSaveSessions.test.ts`、`diffs/AnnotatableCodeView.browser.test.tsx`、`GitActionsControl.logic.test.ts`、`packages/source-control-*/src/server/*PullRequestProvider.test.ts`；`apps/web/package.json:12` 是 unit/browser 测试入口。AReaL 对应 `clients/gui/package.json` 的单测、场景测试及 `packages/workspace-git` 测试可按具体变化选取。本次没有运行测试、真实供应商、浏览器交互或性能测试；PR 主机权限、文件损坏或超限以及各种平台交互需针对环境单独验收。

## 性能和稳定性的结论边界

本轮只对比源码机制，没有采集双方 CPU、帧率、内存、延迟或成功率。不能据此判断谁更快或谁更稳定。截图中的异常也不能独立证明哪一层造成错误。

| 待测场景 | 记录的结果 | 必须保持的行为 | 推荐方案 | 执行情况 |
| --- | --- | --- | --- | --- |
| 发送后开始输出 | 用户消息定位、首个正文位置、布局校正次数 | 用户主动滚动后不继续抢位置 | 优先：采集发送前后锚点位置，比较无动画与动画两种路径。 | 已验证：完整应用首发/续发近顶部、用户让出及两轮全文一致；normal/reduced motion 组件路径通过。见 P01/E2。 |
| 持续流式输出并输入 | 输入延迟、长任务、React 提交与主线程时间 | IME、选择、编辑和引用插入正常 | 优先：在持续输出时测输入延迟和长任务，再修复已证明热点。 | 部分完成：五轮当前侧输入样本与独立诊断保留；正式前后对比未完成，不能宣称加速。见 P02、P07/E5。 |
| 回看与折叠/展开 | 阅读锚点漂移、展开状态、滚动原因 | 用户展开与跟随意图不丢失 | 优先：用展开、图片变高和历史加载组合场景验证锚点。 | 部分完成：历史夹具通过折叠、延迟解码图片增高及分页锚点；长历史最终预算审计未完成。见 P03、P06/E3。 |
| 断线、重连与错误 | 已受理身份、可见状态变化、重复提交和缺帧 | 未知提交不因 UI 重试而重复执行 | 优先：保留全部失败与未知结果；验证恢复不产生重复提交。 | 已验证：真实 Core 重连 7 项、真实 socket 缺帧/终端 service 8 项、passive 恢复 3 项通过；分层覆盖，不代表供应商可用率。见 P04/E6。 |
| 开关资源面板与拖动尺寸 | 帧时间、加载耗时、返回焦点、稳态内存 | 原对话与未保存内容保持正确归属 | 随后：测拖动帧时间及往返内存，再选择局部更新或缓存。 | 未开始：专项帧时间与往返内存对照未纳入本轮。已有功能检查不替代性能测量。 |
| 终端输出/设备流 | 输入与显示延迟、队列、带宽和 CPU | 暂停观看、关闭查看和终止执行区分 | 后续：终端独立测量；设备流在设备专项确定平台后测量。 | 部分完成：终端 service 契约检查通过，500 行与淘汰验收待完成；设备流未开始。见 P08/E6。 |

这些场景是后续测量入口，不是新增功能承诺。历史测试文件只说明有验证入口，本轮没有执行它们。

## 核查结论与修正

- AReaL 有长文本折叠；区别在阈值和实际发送形式。
- AReaL 有执行耗时；主消息行缺少 T3 式消息时间。
- AReaL 有目录外部打开和文件树添加到对话。
- AReaL 推送支持创建远程分支；缺项不能写成“不能发布分支”。
- 两边都有浏览器元素/区域批注，不能把批注笼统列为单方独有。
- AReaL 手机 Remote 不等于 T3 Device。
- T3 截图的 5/5 是该次 provider 事件，不能写成通用重试上限。
- 本地 Diff 评论与远端 PR review 是不同动作。

## 本轮验证

源码和文档用于核对功能入口、参数、状态、调用链及平台条件。新报告经过本地链接检查及显式源码位置检查。UI、真实供应商、设备、性能和安装包路径未运行；本轮仅交付调研文档。原研究材料保留为固定快照，当前功能评审以本报告的修正为准。
