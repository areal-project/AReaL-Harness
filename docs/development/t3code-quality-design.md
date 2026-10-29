**中文** | [English](t3code-quality-design.en.md)

# 借鉴 T3 Code：可测试性、可靠性与研发效率补充设计

## 会话总目标与实施边界

本会话的总目标是：**让关键用户任务在正常、故障和升级路径中有可信结果；让每次代码变化更快获得能发现错误的证据；在此基础上改善响应速度与一致的交互体验。** T3 是设计对照，具体工作由 AReaL 的失败、调用路径和用户任务决定。

外部研究固定在 T3 `f41518f3`，本地源码对照为 `93a9e079b107a13b0c312920b917b5f61a8f720c`。报告中的提交数、CI 成功率、时长与发布案例不能直接作为本仓质量指标；未独立复核的数字不进入本仓验收结论。

沿用 Clients → Core → Runtime 的责任边界：Core 拥有受理、会话与执行结算；Runtime 拥有副作用与清理；Desktop/workbench 拥有传输、观察和可重建投影；Renderer 拥有用户意图及派生展示；Design System 约束状态表达、组件组合和交互连续性。需要新的领域对象、恢复协议或持久化机制时，先证明现有所有者无法满足具体合同。

### 六个结果目标

| 目标 | 用户或开发者应得到的结果 | 验收方式与已有入口 |
| --- | --- | --- |
| Q1. 状态与恢复可信 | 已受理、正在执行、已结算、无法确定可区分；停止、重连及迟到事件不串任务、不重复副作用 | 受理/恢复合同及 Provider 回放核对权威身份、持久结果和真实副作用；再检查 GUI 显示和合法动作。见 `core/engine/src/desktop/submissions.rs`、`provider_replay.rs`、Desktop 投影测试 |
| Q2. 验证本身可信且可重复 | 正确实现通过，相关错误被明确拒绝；失败仍能保留证据并清理本次资源 | 结果绑定源码/输入/产物身份；覆盖空计划、缓存命中、缺依赖和清理失败；等待持久化、drain、退出等实际里程碑。复用 `check-changed.py`、现有 smoke 与固定产物助手 |
| Q3. 产品交互与 Design System 一致 | 用户能理解当前状态、完成下一步，并在流式输出、折叠、导航和恢复中保持阅读与操作意图 | 按 `CONV-OWNER-01`、`CONV-READ-01`、`CONV-DISCLOSURE-01`、`NAV-CONTEXT-01`、`RECOVER-TRUTH-01` 验证状态、动作、焦点、语义锚点和人工展开；复用生产组件与就近合同 |
| Q4. 性能收益可归因 | 在代表性负载下减少实际等待或主线程成本，且数据及时、缓存有界 | 同输入、同环境做前后比较，区分派生调用/处理字节、CPU、交互耗时、传输量和 heap/RSS；优化失效后检测能失败；保留历史/owner/status 变化的失效验收 |
| Q5. 开发反馈更快且覆盖透明 | 常见改动尽早得到相关失败，未知范围扩大检查；开发者知道哪些证据还缺失 | 复用 CI 范围与 manifest，记录类型/静态/行为/构建步骤耗时和首跑失败；选检、跳过、缓存失效都可解释；同一反例在优化前后都能被拦截 |
| Q6. 构建、升级与交付可用 | 同一候选应用可以启动、读取受支持旧数据、显示原会话并正常退出；失败有可用恢复入口 | 复用 `verification.py`、`history-copy-smoke.mjs`、`update-smoke.mjs` 和包验证；把源码、源码 Electron、最终包、签名与公证分别绑定证据，不用一种通过代替另一种 |

可测试性属于所有者接口的质量：重要异步工作应有可观察的完成或失败信号。可验证性属于证据质量：结论必须说明被测输入、实际运行边界及未覆盖部分。测试数、规则数、缓存数量和文档页数不作为以上目标的完成指标。

### 以用户旅程选择覆盖

先维护五条可重复的旅程：发送并观察结果；停止或断线后核对；流式输出期间回看与人工展开；切换聊天及返回草稿/阅读位置；旧数据打开与升级失败恢复。每轮只选受改动影响的旅程及其关键失败状态，不枚举全部状态组合。

Design System 是这些旅程的交互合同：共享 primitive 负责外观与可访问语义，业务所有者提供真实状态与合法动作，页面负责组合。检查按 must/default 规则执行，复用已有 Token、组件和状态；新增例外必须有具体消费者、原因及退出条件。静态规则、纯派生/SSR、真实浏览器交互、源码 Electron 与最终包分别给结论。截图仅证明所采状态，不能证明恢复、取消或焦点连续性。

### 下一执行顺序

| 优先级 | 有界工作 | 关闭条件 |
| --- | --- | --- |
| P0：集成基线 | 核对主 worktree、Claude 与专项分支的可达性，运行受影响的合同、类型和设计检查 | 当前基线与未集成工作明确；相关检查的失败及边界可审阅。受理记录与 C 的 lint 已集成；定时停放及其他专项修复仍需各自核对 |
| P0：可信反馈 | 快检空计划源码/index 漂移和历史失败清理已修复；清理异常独立留证，缺失 Desktop 元数据禁止成功 | 两类结果均有独立失败证据；空计划也绑定当前输入；失败清理以本次实例退出为完成条件，不能把超时或强杀算正常清理通过 |
| P1：产品连续性 | 在合并后的 Messages 上建立真实输入的流式阅读/人工展开/导航基线，核查未知与未结算状态 | 语义锚点、聊天身份、展开选择、焦点和合法动作与合同一致；基线失败先分类，不靠降低断言使优化通过 |
| P2：已证明热点 | 测量消息分组、阅读检查点序列化、CoreBackend→SharedCoreBackend→Renderer 的引用与通知扩散；只实施确有收益的最小切片 | 同工作负载有可归因收益，缓存失效、容量与交互合同通过；无法证明收益的候选保留为待测，不增加机制 |
| 按影响触发：交付与模型接口 | 包/依赖/迁移变化执行最终产物路径；提示、工具或预算变化执行字节基线及相称行为评估 | 目标产物或模型配置的结果有证据；发布、签名凭据、付费模型及外部操作继续按授权边界执行 |

性能基线按真实维度固定：项目/聊天数量、可见 Turn/条目数、流事件数量与频率、历史页/正文体积、阅读 owner 数、主题/字号/窗口及设备。冷/热路径分开，耗时分位值附样本数与失败尝试。先报告测量分布，再确定稳定预算；不直接采用 T3 的具体字节上限，也不把 JSON 编码量当成内存上限。

合并基线上的消息分组测量约占 Messages 子树渲染成本的 2–4%，本轮保留测量入口，暂不加入该缓存。阅读检查点采用逐项编码和精确长度累计，消除重复前缀编码。`CoreBackend.snapshot()` 重建项目、state/threads 与派生字段，`SharedCoreBackend.snapshot()` 再包装项目；只稳定后者引用的模拟收益不足以证明生产传输改善，跨层缓存仍需真实链路测量。

### 每轮闭环与停止条件

从真实缺陷、用户路径或测量开始，写清“被破坏的不变量 → 唯一所有者 → 最便宜且正确的拦截边界 → 可击穿的反例”。已有测试足够时直接复用；类型能表达的静态约束不重复写镜像测试。

每轮按“目标和基线 → 并行调查 → 主架构取舍 → 小切片实现 → 独立验证 → 更新合同/文档 → 本地提交”推进。调查不自动扩大范围；并行代理按所有者分工，集成前冻结写入并绑定同一源码基线。评审优先确认状态语义、缓存/选择逻辑和失败清理，基础错误消除后再做视觉或更昂贵的原生验证。

每个切片交付：改变了什么、为何选择这一层、正常与故障的观察结果、前后测量、定向反例、实际产物身份、未执行项。证据达到该切片合同、相关检查完成且 owned diff 已审查后停止。真实供应商、其他平台、实际安装包或用户验收缺失时，明确保留资格缺口，不把整个系统标为已验收。

## 架构建议复核与本轮 P0

外部拓扑建议以 `39982f3d` 的源码复核。采纳“服务能力先于客户端入口、生命周期明确、写请求有受理证据、读模型有预算、约束可执行”的方向；下面的事实修正决定实施顺序，不把外部建议直接视为已批准的迁移方案。

| 建议中的判断 | 当前源码与裁决 |
| --- | --- |
| 跨项目协调都在 Electron 窗口 Main | `service-client.cjs` 启动独立 Desktop 服务；`service-main.cjs` 持有 CoreBackend、调度激活与 RemoteControl。目录位置不能等同进程所有权。优先在已有服务边界收口职责 |
| service-host 只是短命 launcher，当前没有关窗口留后台 | Rust service-host 已按 dataDir 长期监督；Main 关闭窗口时隐藏，显式退出才结算并停止后台。脱离 GUI 常驻属于新的生命周期产品决策，不能由 detached/unref 推导 |
| 新 Host 的索引和日志都能从 Core 重建 | 仅派生投影可如此承诺。项目注册、配对授权、客户端提交意图、崩溃/替代回执分别是用户、安全或控制事实；请求未到 Core 时的意图尤其不能从 Core 恢复 |
| 所有任务目录仍每三秒轮询、客户端连接包缺失 | OwnerTasks 已有 watch→分页基线→dirty drain；任务中心按目录 revision 刷新，remote-client 已存在。三秒轮询仍在历史定时任务回执详情卡，不能据此重写整个目录或所有连接 |
| 重启后一律 UNKNOWN，可按动作名称决定重放 | Store 已区分 Goal 暂停、Turn 中断和未确认工具 UNKNOWN，TaskRun 也有重启暂停。清理、标题生成等名称不证明可重放；必须先确认幂等键、提交点、归属代际及结算证据 |
| 影响分析、历史夹具、输入预算及 lint 尚未建立 | G/H/I/C 已有局部实现和反例。最终安装包、真实用户升级、全宿主模型输入仍需独立验证；规则数量和提交统计不能证明质量。可静态判断的规则落到代码，语义、原因和人工交互合同继续保留唯一正文所有者 |

本轮只落地 **P0：历史验收失败后的清理与结果真实性**。已有真实损坏历史失败记录和自有子进程复现：关闭超时可能留下测试进程，原业务错误掩盖清理错误，报告仍声称停止成功。关闭只处理本次持有的 Electron 子进程；Desktop/Core 必须独立核验，缺失元数据或清理异常不能报告成功。原业务失败与清理失败分别留证，强制结束子进程不计为正常退出通过。

机器级 Host、SQLite、完整退出后后台继续、统一动作重放策略及合并不同协议的连接运行时保留为设计候选。先明确每用户/每配置的隔离和生命周期需求，再讨论部署拓扑。重试所有者按具体连接/环境划分，不能按物理机器粗粒度合并。

下一性能候选是历史定时任务回执卡：同 taskId 多卡可能独立调用 `manage/task`，相同任务内容仍触发模型发布。应先测真实 0/1/10 卡的读取次数、两段投影与状态更新延迟，再决定合并重复读取或避免无变化发布；相同 revision 不自动证明完整内容相同。本轮不将源码推断当作性能收益。

## 状态与实现边界

本设计承接“受理记录、定时任务与仓库 lint 插件”规格的 A/B/C 工作包。D–I 的最小实现已落到现有测试、夹具和快检入口；J 落到 Renderer 导航派生缓存与阅读状态所有者。已运行证据与仍需原生验收的部分分别列出。

T3 参考源码固定为 `93a9e079b107a13b0c312920b917b5f61a8f720c`。AReaL 沿用 Rust Core/Runtime、真实 HTTP 适配器、Desktop 投影、测试清单和固定产物验证流程。协议回放只替代外部模型；Renderer 派生缓存不参与权威会话状态和写请求结算。

| 工作包 | 当前实现 | 已运行证据与边界 |
| --- | --- | --- |
| C. 仓库 lint 插件 | 增量规则、共享 observeResize、规则与浏览器反例 | Node 24.11.0 下 80 项 GUI 单测（含 18 项规则测试）、真实增量规则反例与 Chrome 尺寸探针通过；无障碍诊断单独归类 |
| D. Provider 协议回放 | 版本化 JSON、真实 HTTP 字节、出站字段检查、暂停与断连 | D/E 的 HTTP、回放和超时合计 23 项通过；真实 Runtime 写入恢复固定槽 1 项通过 |
| E. 可控时序 | 请求到达/放行里程碑、ResponseDeadline 虚拟时间测试 | 上述 23 项及 1 项虚拟时间测试通过；保留真实 HTTP 时间边界 |
| F. 投影一致性 | 缺帧关闭、重连全量基线、旧连接隔离、历史释放 | 7 项 Desktop 本地传输测试通过；不覆盖手机或 Relay |
| G. 本地影响范围快检 | CI 范围与 manifest 复用、计划说明、输入变化失效 | 13 项临时 Git 合同及 5 项 manifest 测试通过；完整快检结果依赖所选环境条件 |
| H. 代表性历史夹具 | 旧格式长历史、已结算子会话、三种终态及 profile 断言 | 真实 Electron/Core 验收通过；40 Turn 读取 1 个旧页，来源与读取中副本不变，模型请求为零 |
| I. 模型输入体积基线 | 默认 Desktop 无 Runtime/插件 profile 的分项字节基线 | 1 项真实 Engine/HTTP 测试通过，包含独立实例对照及输入增减反例 |
| J. GUI 派生与阅读缓存 | 不可变输入缓存、侧栏非原地排序、32 项内存上限及单次条目编码 | Chrome 计算次数/新快照、消息连续性及 7 项阅读缓存测试通过；完整旧对话流场景仍有定位器失败 |

D/F/H 补充协议故障、观察链和历史数据形态；E/G/I 深化时间控制、快检与上下文预算。J 以实际重算与容量证据选择最小修复。各项入口和证据不能互相替代，也不直接证明整体 Agent 能力、实际费用或用户感知延迟改善。

## D. 在真实 Provider 适配器边界回放协议

**T3 依据。** `packages/provider-testing/src/replayTranscript.ts` 解析带元数据的 NDJSON，并将工作区占位符实例化；`replayGate.ts` 提供 `waitForReached/release`；`ProviderReplayHarness.ts` 将回放适配器接入真实编排和持久化服务。恢复测试还把持久状态带入后续运行。见[协议回放](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/packages/provider-testing/src/replayTranscript.ts)、[检查点](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/packages/provider-testing/src/replayGate.ts)、[恢复测试](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts)。

**实现。** [http_replay.rs](../../core/engine/tests/support/http_replay.rs) 读取版本化 JSON，声明 ChatCompletions 协议和合成来源，按 JSON pointer 检查必要出站字段，再发送指定 HTTP 字节。响应可在请求已到达时停放，或声明比实际发送更多的 Content-Length 复现传输截断。`request(index)` 与 `release(index)` 控制先后顺序；场景结束核对脚本消费，失败或 Drop 清理自有服务任务。

[provider_replay.rs](../../core/engine/tests/provider_replay.rs) 经生产 HttpModel/decoder、Engine 和临时存储验证：同一 chunk 中错误前的文本保留；finish_reason 后断流不放行工具；取消后迟到回答不会改变已持久化的 Interrupted 状态。原 `http_model.rs` 的两项测试迁入该入口，场景数据位于 `tests/fixtures/provider-replay`。

真实 Runtime 场景以 `test-support` feature 显式选择：完成文件工具写入并独立核对持久记录，下一次模型请求断连，再重新打开 Engine；哨兵内容与工具结果数量检查已完成写入没有重放。它要求 `AREAL_TEST_BIN_DIR` 指向同批已验证固定 bundle，固定槽原生用例 1 项已通过，覆盖正常关闭旧 Engine 后重开；运行中进程崩溃不在此证据内。完整与截断脚本各有预期，回放通过不代表真实供应商兼容性或安装包通过。

## E. 用里程碑控制顺序，用虚拟时间验证策略

**T3 依据。** [DeterministicRuntime.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/orchestration-v2/testkit/DeterministicRuntime.ts) 提供 TestClock 和固定随机种子；回放 gate 区分“到达”和“释放”。[ThreadSettlementService.test.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/orchestration-v2/ThreadSettlementService.test.ts) 通过 Deferred 和 TestClock 控制竞争。该仓库也存在轮询辅助代码，不能据此宣称其所有测试都已确定化。

**实现。** 取消场景使用回放请求到达通知，先等待 Turn 结算为 Interrupted，再释放迟到响应，并在新 Engine 实例中检查保存结果。该场景替代原依靠延迟响应头制造时间窗口的取消测试；网络 EOF 与持久化结果分别断言。

[watchdog.rs](../../core/engine/src/watchdog.rs) 的 `first_event_deadline_is_fixed_and_activity_starts_a_new_idle_window` 使用 Tokio 暂停时间，检查首事件绝对期限及 Activity 后新的 idle window。`model_timeouts.rs` 保留四项真实 HTTP 超时边界；虚拟时间仅控制策略计时，不假设 socket、Main、页面和系统 I/O 共用时钟。

运行 `cargo test --locked -p areal-engine --test http_model --test provider_replay --test model_timeouts`，以及 `cargo test --locked -p areal-engine --lib first_event_deadline_is_fixed_and_activity_starts_a_new_idle_window`。已通过结果为前者 23 项、后者 1 项；其中不含 feature 门控的 Runtime 场景。精确里程碑和定向错误断言用于解释失败，保留总期限，不能以重试后成功掩盖首跑失败。

## F. 补齐快照、增量和重连的一致性验收

**T3 依据。** [subscribeBeforeSnapshot.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/utils/subscribeBeforeSnapshot.ts) 有两种实现：共享 mutex 内先读快照再订阅，或无共享锁时先订阅再读快照；其[测试](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/utils/subscribeBeforeSnapshot.test.ts) 在读取窗口中插入变化。[shell-sync.test.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/packages/client-runtime/src/state/shell-sync.test.ts) 还检查旧异步保存、权威快照重置及缓存补全冲突。借鉴的是可执行的边界不变量，不能只照函数名复制顺序。

**实现。** 继续使用 [state-projection.cjs](../../clients/gui/packages/workbench/client/state-projection.cjs) 的 stream、sequence、delta base 约束及 ServiceConnection 的连接归属守卫，在 [desktop-projection-transport.test.mjs](../../clients/gui/scripts/desktop-projection-transport.test.mjs) 增加真实本地 WebSocket 观察场景。覆盖重复/旧帧不回退、缺失 base 导致连接关闭、新连接读取完整权威基线，以及旧连接迟到帧不能覆盖新连接。

现有背压合并、回执顺序和历史 acquire/release 的其他客户端隔离继续由同一入口保护。`node --test clients/gui/scripts/desktop-projection-transport.test.mjs` 共 7 项通过；恢复后的公开语义状态与服务快照核对，并检查没有自动重发用户写请求。

sequence 的重置仍绑定新 stream/reader，未照搬 T3 的低序号重置语义。这里的证据覆盖 Desktop 传输及投影，完整 Core 历史、手机与 Relay 各自执行专项验收；测试出现真实契约缺陷时才扩展生产修复范围。

## G. 与 CI 共用范围判断的本地快检

**T3 依据。** [check-changed.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/scripts/check-changed.ts) 复用 CI 的 `decide/readWorkspace`，包含未提交和未跟踪文件，对受影响包及依赖方检查类型，并运行邻近测试；摘要明确列出留给 CI 的检查。通过缓存还会复核输入是否在运行期间变化。

**实现。** [check-changed.py](../../scripts/check-changed.py) 提供 `make check-changed CI_BASE=<ref>`；`ARGS=--plan` 仅输出 JSON 计划。入口解析一次 merge-base，纳入已提交、暂存、未暂存、未跟踪、删除及重命名两侧路径，输出输入摘要、命令、理由、命中路径与未覆盖项。暂存与工作区差量取并集，即使内容相互抵消也选检；输入摘要包含 cached diff，纯暂存区变化也会使证据失效。命令验收对象明确为 `working-tree`，部分暂存文件的 index 内容只参与选检与漂移检测。

`ciScopes` 原样复用 [ci-scope.py](../../scripts/ci-scope.py)；未知代码的本地扩大单列为 `conservativeFallback`，不冒充原 CI 已识别。GUI 通过 [test-manifest.mjs](../../clients/gui/scripts/test-manifest.mjs) 的 stdin JSON `--select-changed` 接口复用领域、平台和依赖条件，保留共享 unit 测试。共享 Rust/schema 保守执行 workspace 检查与 SDK 消费者检查，暂不推断精细 Rust 依赖图。

执行为顺序运行，无整轮通过缓存。所选命令成功也只报告 `passed-selected-checks`；缺条件为 `partial`，输入变化为 `invalidated`，失败为 `failed`，没有改动为 `no-changes`；空计划返回前同样复核源码和 index 身份。`partial`、`invalidated`、`failed` 返回非零；E2E、原生桌面、真实供应商与安装包仍列为 deferred。13 项临时 Git 合同与 5 项既有 manifest 测试通过；隔离反例去掉未知代码的 GUI 扩大后，选择合同按预期失败。

## H. 将复杂历史做成可复用的开发与验收夹具

**T3 依据。** [migrate-dev-db.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/scripts/migrate-dev-db.ts) 以只读源建立隔离副本，选择停止的 Thread 家族，清除待执行工作及认证会话，再迁移和裁剪；[测试](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/scripts/migrate-dev-db.test.ts) 验证来源/目标隔离和旧数据升级。价值在真实数据形态进入开发循环。

**实现。** [profiles.json](../../clients/gui/scripts/fixtures/history-compat/profiles.json) 声明合成来源、旧存储版本和语义预期：已结算子会话关系、40 Turn 的分页历史，以及 completed/failed/interrupted 三种终态。样本保留版本 14 的原始格式；[history-copy-smoke.mjs](../../clients/gui/scripts/history-copy-smoke.mjs) 复用原有私有副本与来源哈希核对，增加公开 history acquire/page 结果、顺序、关系、终态与 Renderer 可见文本断言。

入口仍为 `pnpm --dir clients/gui test:history-compat`，需要匹配的固定 Core 与已构建 GUI；`AREAL_CORE_BIN` 指定源码测试产物，包验收可显式选择 executable。只读 profile 保留 idle、无队列、无托管执行与零模型请求约束；活动恢复数据仍由 D/F 专项拥有。没有新增默认复制用户数据的开发启动行为。

真实 Electron/Core 验收已通过：40 Turn 样本实际加载 1 个旧页，子会话关系、三种终态与可见文本一致；来源及读取中的副本摘要不变，模型请求为零，隔离服务正常退出。合成样本不能覆盖全部真实用户数据，显式本地副本和安装包验收继续分别执行。

失败清理使用同一 120 秒期限覆盖退出准备与关闭，超时后仅结束本次持有的 Electron 子进程，并独立检查 Desktop PID 和 Core 服务库存。元数据、关闭与库存异常分别记录；原业务错误同时保留。`pnpm --dir clients/gui test:history-cleanup` 的 13 项合同覆盖阻塞关闭、库存失败、元数据缺失/无效/读取错误及多重失败。真实缺失父会话反例仍按预期拒绝，来源不变、模型请求为零；关闭超时触发自有子进程清理，独立确认后台退出，报告仍为失败并保留超时。这证明失败收尾有界且结果真实，不证明异常场景能正常退出。

## I. 为静态模型输入建立分项体积基线

**T3 依据。** [AgentContextBudget.test.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/provider/AgentContextBudget.test.ts) 从生产构造函数及工具注册结果测量附加提示和模型可见工具字段的 UTF-8 字节，与版本化基线比较。

**实现。** [model_input_budget.rs](../../core/engine/tests/model_input_budget.rs) 经生产 `Engine::create_configured`、默认配置和真实 HTTP 适配器捕获求解请求；辅助命名由已有 SolveOnlyHttpModel 边界隔离。首个 profile 是 `desktop-default-no-runtime-or-plugins`，不把本机 Runtime 或第三方插件能力计入默认无宿主测试。

固定基线 [model-input-budget.json](../../core/engine/tests/fixtures/model-input-budget.json) 分别记录 system 指令 13,259 UTF-8 字节、Execution settings 段 563 字节，以及 18 个工具的 name/description/parameters 计量，模型可见工具函数 JSON 合计 12,686 字节。system 指令包含 1,501 字节的 Git 分支与认证边界说明；这两段说明不改变工具或固定环境体积。不同临时目录、ID 与用户正文的两次独立 Engine 请求计量一致。动态用户历史、Skills 正文、检索和媒体不纳入该固定 profile。

`cargo test --locked -p areal-engine --test model_input_budget` 的 1 项测试通过，包括增加/减少工具描述和增加 system 指令的反例；变化输出分项与工具名称，基线必须人工审阅更新。该检查不自动删提示、截断工具或改变生产预算。字节是确定性增长信号，不转换成未验证的 token、费用或成功率结论；Agent 行为修改仍遵循[改进方法](agent-improvement.md)。

## J. GUI 派生缓存与 Design System 连续性

用户操作跨越 Renderer 意图、Desktop 传输与投影、Core 权威会话、Runtime 副作用。改进循环是：定义可观察目标，追踪调用与状态所有权，以同一场景验证机制，实施最小修复，再检查结果。源码重复调用是候选证据；计算次数、缓存容量、数据新鲜度和用户交互分别验证，减少计算不自动等于感知延迟降低。

| 所有者 | 缓存或保留内容 | 更新与释放边界 |
| --- | --- | --- |
| Core / Runtime | 历史、受理记录、执行事实 | 沿既有持久化与生命周期合同；Renderer 缓存不参与写请求结算 |
| Desktop / workbench | 带 stream、sequence、base 的投影及有界历史页 | 按现有重连、基线校验和 view release 处理 |
| Renderer 导航 | 排序项目、会话目录和侧栏派生结果 | 完整不可变输入引用变化即重算，组件卸载释放 |
| Messages / readingViews | 按阅读 owner 隔离的布局与语义锚点 | 保存刷新最近访问顺序，超过既有 32 项边界淘汰最旧项 |
| Design System | 导航、阅读、返回与状态反馈约束 | 组件就近合同拥有规则，验收复用生产组件 |

`useSessionNavigation` 原先每次渲染都创建排序项目数组，`App` 随后重建全量目录；侧栏还原地排序输入摘要。选择先稳定上游项目引用，再缓存目录与侧栏派生，排序不修改输入。重命名、未读、运行状态、项目顺序及新权威快照必须及时刷新。缓存不按 Thread ID 长期保留业务对象，不掩盖 pending/UNKNOWN。

`readingViews` 原有 sessionStorage 上限为 32 项、65,536 字符，内存 Map 却不淘汰。隔离复现访问 1024 个 owner 后内存为 1024 项、持久化为 32 项，每次保存仍复制全部 Map。选择在原保存所有者按相同 32 项边界裁剪，即使存储不可用也限制容量。保留语义锚点，不保存 DOM、正文或 Core 历史。

保存时逐项 JSON 编码并累计外壳、逗号与条目的 UTF-16 长度，再拼接最终值；不再对每个候选反复编码整个前缀。格式、65,536 字符预算、最近访问顺序、过大项跳过后继续选取和同步 sessionStorage 保存语义一致。写入成功后才更新已保存值；存储失败时同内容仍可重试。

后端历史已有视图、页数和字节限额。跨会话保留完整历史页会改变 release 与资源归属，当前证据不支持本轮引入。Messages 条目投影缓存经下述测量暂缓，后续候选必须有新的实际成本证据。

交互分类为 I-NAV、I-READ、I-RECOVER，子对话返回涉及 I-RETURN。复用 App、Sidebar、Messages 和现有 Token。约束引用[交互模式](../../clients/gui/design-system/interactions.md)的 NAV-CONTEXT-01、READ-CONTINUITY-01、RECOVER-TRUTH-01、RETURN-CONTEXT-01，以及 [Messages 合同](../../clients/gui/renderer/src/Messages.md)的 R-MESSAGES-004/005；本轮不新增设计规则或视觉角色。

同源 Renderer 夹具比较优化前后无关 UI 操作的目录重算次数，并检查新快照中的名称、未读、运行和排序即时更新。阅读缓存检查最近访问淘汰、存储不可用和语义锚点重载；主题、字号与布局变化沿既有阅读逻辑。截图、原始计数和未通过项分别记录；静态设计检查、Renderer 交互、Electron/Core 历史与安装包各自保留证据边界。


**已运行证据。** `pnpm --dir clients/gui test:navigation-cache` 在真实 React App/Chrome、fixture PlatformServices 边界测量相同无关 UI 操作：优化前 catalog 重算增量 13、projectVisits 156、comparisons 38,805，优化后均为 0；重命名、未读、运行状态、排序和新权威快照五类刷新通过。计数说明该场景减少了派生计算，不是端到端耗时或用户感知延迟结论。

`readingViews.test.ts` 的 7 项测试通过，包含精确字符边界、Unicode 转义和存储失败重试。Chrome 主题切换和重载检查的语义阅读锚点偏差为 1px；旧 `conversation-flow` 场景在 `.tool-summary-row .tool-failed` 定位器超时；生产折叠失败状态由 `ActivityRowStatus` 的 `data-tone="failed"` 表达。该 markup 与 `readingViews` 容量裁剪属于不同边界，本专项未修改旧 runner，完整对话流未计为通过。原生 Electron/Core 历史、平台输入和安装包仍保留各自验收边界。

### 合并后的消息阅读基线

`pnpm --dir clients/gui test:message-derivation` 通过生产 Messages、CoreTaskModel 和真实 Chrome 输入检查人工展开、20 次流增量中的语义正文锚点、终态、历史 gap 插入/移除与同 Thread/Turn ID 的 owner 替换。字体就绪和连续六帧几何稳定后取证，锚点偏差容差仍为 1px；修正测量夹具后的通过不代表旧基线的产品缺陷已修复。失败也尝试关闭浏览器、Vite 并写报告。

测量负载为 100 个终态 Turn 加 1 个活动 Turn，每 Turn 6 个条目，含两次文件读取与命令的生产活动组。三次开发 React/Chrome 基线中，12 次无关更新产生 1,313 次分组、7,878 个处理条目，分组 CPU 合计 13.7–15.5ms，Messages 子树 Profiler 合计 434.5–707ms；20 次输出产生 2,222 次分组、13,332 个条目，对应 25.8–30.7ms 和 745.3–868.3ms。分组占比约 2–4%，Long Tasks 有明显波动，因此本轮不增加消息派生缓存，也不将这些带测量开销的开发样本作为生产延迟预算。`--baseline` 额外检查当前重算次数；默认模式仅约束功能，允许未来减少重算。

### 阅读检查点的序列化收益

`pnpm --dir clients/gui test:reading-checkpoint` 在 Chrome 156、1100×800、浅色/14px 下使用生产 Messages/saveReadingViews，分别保存 1 和 32 个合法 owner 的检查点，执行 96 次 wheel 输入及 24 次输出追加。32 owner 前后均触发 193 次滚动阶段保存：JSON 编码字符总量从 24,459,855 降至 1,390,469（约减少 94.3%），同步 stringify 累计样本从 23.0ms 降至 4.2ms；流更新阶段从 3,041,640 降至 172,920 字符，对应 4.4ms 至 0.3ms。实际 scroll/resize 事件数和 CPU profile 分别保留；CPU 是单轮带探针样本，不能外推为端到端耗时、内存或用户感知提升。

两种 owner 数量的同步存储和冷重载语义锚点均通过；阅读区下方输出追加时检查点内容不变，存储写入为零。默认 runner 拦截恢复前缀重复编码的回退，`--baseline` 允许测量旧实现。报告绑定源码哈希和浏览器版本，清理或源码漂移会将结果置为失败。消息测量中一次并发构建触发 HMR 的失败报告另行保留，稳定源码后复验通过；真实 Electron、供应商和安装包不在这两个 Chrome 夹具的证据范围内。

## 验证入口与完成边界

具体操作见[测试指南](testing.md)。D/E/F/G/I 与 J 的局部机制证据已建立；Core HTTP/回放/超时与固定槽 Runtime 合计 24 项、虚拟时间 1 项通过，文本丢失和错误首事件期限的两个隔离反例均触发断言失败并恢复复验。匹配的 Core/GUI 构建、固定槽 doctor、GUI 类型、设计与格式检查通过。H 的真实 Electron/Core 合成历史专项通过；真实用户升级数据和安装包继续独立验收。未执行、失败和仅局部通过分别报告，不用测试总数代替覆盖范围。每个定向反例只在隔离环境或已捕获的测试请求边界注入，完成后恢复正式输入。
