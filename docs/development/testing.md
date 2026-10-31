**中文** | [English](testing.en.md)

# 测试

Side Chat 的 Esc 回退测试等待任务资源外层弹层完全退出布局后，再验证主任务停止。内部 `Activity` 隐藏会早于 `keepMounted` 弹层关闭动画完成；动画期间仍应保护主任务。测试显式拉长该动画并记录弹层状态，覆盖两种主/侧任务启动顺序，不用固定 sleep 或重复发送 Esc 掩盖竞态。

模型计量观察器的非干扰测试在磁盘写入仍被阻塞时等待 `drained` 结算信号，再在观察器锁内检查内存账本。客户端收到 HTTP EOF 不代表服务端 `finally` 已完成；不能用延长 sleep 或提前释放磁盘阻塞替代这个先后关系。


发行验收的本地模型将辅助会话标题与求解请求分开处理。主任务退出可取消尚未完成的命名请求，此时命名回包的 BrokenPipe/ConnectionReset 不应把成功的读写验收改判失败；求解回包中断、命名携带工具或其他协议错误仍失败。`scripts/fixture_session_title.py` 仅用于本地 fixture，不改变生产重试、超时或模型消费。

依赖安装见[开发指南](README.md)。常规测试使用临时目录、动态 loopback 端口和确定性模型，无需真实模型凭据。

| 入口 | 范围 |
|---|---|
| `make verify` | Cordis pin、格式、静态检查、Rust workspace、两套 SDK、Python、文档、TUI 与统一委派 smoke |
| `make script-test` | 启动器、Web 思考/等待/取消投影、perf 统计/证据、适配器依赖边界与文档链接/语言配对 |
| `make upgrade-smoke` | 隔离运行真实 CLI 与离线安装器，验证独立安装升级、旧版本保留、Homebrew 保护及校验失败；合成服务记录不代表真实任务连续性 |
| `make tui-upgrade-smoke ARGS='--old-bin-dir /absolute/old/bin --new-bin-dir /absolute/new/bin'` | 两套固定真实产物、真实新旧 TUI PTY、本地模型与 Core/Runtime，验证显式换代后旧客户端重连不会停止或降级新后台 |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | 并发原语 |
| `make verify-runtime` | Runtime 单元测试与真实文件、进程、权限和关闭 smoke |
| `make verify-harness` | verify 后顺序运行 Runtime、完整 Harness、桌面 API 和 Workgroup smoke |
| `make verify-native` | macOS 原生后端测试与 Harness 集成 smoke；通用回归由 `make verify` 覆盖 |
| `make examples-desktop-api` | [直接 API、CLI、Skill 与搬迁打包产物](../examples/desktop-api.md) |
| `make workgroup-smoke` | 独立 Runtime 写入、组合验收、命令期限与失败后结算 |
| `make git-auth-smoke` | 公开共享服务到真实 Runtime 的 Git 身份、SSH agent 签名、HTTPS push 与认证失败保护 |
| `make unified-execution-smoke` | 统一模型工具、并行隔离候选、组合交付、所有权检查、取消与重启恢复 |

快照格式变更须运行 `make verify-harness`：Harness 与插件 smoke 核对写入版本，桌面搬迁测试同时核对发行 manifest、`areal/server/status.stateVersion` 与实际快照版本一致。

真实 PTY smoke 使用终端单元格模拟器重建增量画面；宽字符同时覆盖相邻单元格，避免旧字符残留造成 Unicode 编辑结果误报。脚本单元测试覆盖该重绘边界。会话 ID 从欢迎页独立行读取，避免误取工作区路径中的 UUID；子会话导航先等待具体树行及选中标记，再按 Enter，不以创建状态栏代替异步树刷新。

`tui-upgrade-smoke` 不构建或部署产物；先分别准备完整的不可变旧版与新版目录，并选择旧版不支持新版状态格式的组合。脚本隔离 home、工作区、状态和模型端点，通过真实 TUI 提交旧版与新版消息，显式重启激活新版，然后恢复仍打开的旧 TUI 并触发重连。它跨多个重试周期核对新版 Host/Core PID、generation、状态格式和后续回复。用 `--evidence /absolute/output` 保留终端画面、命令日志、源码与产物身份及清理结果；默认保存于临时目录。该检查不执行安装器，不替代 `upgrade-smoke`、安装包或真实供应商验收。

macOS 原生 smoke 需要 Seatbelt，Linux 原生 smoke 需要 `/usr/bin/bwrap` 和 user namespace；两者都不能在能力缺失时回退到无沙箱执行。`outer-container-perf` 仍在受控容器中验证。默认 `cargo test` 不运行显式忽略的原生 Workgroup 和容量用例。

Linux 宿主常规检查使用 `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`。原生后端测试要求 `/usr/bin/bwrap` 和 user namespace；CI 的独立任务构建 Dockerfile 的 `runtime-tests` 目标，在带 Bubblewrap 的受控容器中实际运行包含 `outer-container-perf` 的全部后端测试，并启用 `areal-runtime/native-tests` 运行 daemon 的 `native_transport` 目标。该目标经私有 stdio 启动真实 daemon 和完整 Runtime bundle，使 Linux 在 daemon 旁找到 reaper；原生沙箱用例保留普通命令/Hook 并发进展和外部 writer 排他断言，四个 portable transport 用例仍属于默认测试。`make verify-native` 先构建 bundle，再在 macOS 显式运行同一原生目标。该 feature 仅选择测试目标，不改变生产行为；不能只排除 portable 宿主的原生测试就视为完成验收。

在 Cargo 测试进程内嵌入 Runtime 的集成用例，需要同版本 reaper 位于测试宿主旁的 `target/<profile>/deps/`。`runtime-tests` 镜像单独安装并检查该产物，保留前层测试编译缓存。离线 CI 合同执行真实安装命令，验证位置、字节和可执行权限；编译器与包管理器使用边界 fixture，此检查不替代 Linux 原生容器验收。

原生 Side 验收还在运行时通过 `CARGO_MANIFEST_DIR` 启动 MCP fixture。镜像必须复制该文件到对应源码路径；离线合同从测试源码提取路径并核对镜像的 COPY 映射，Docker 构建再检查文件可读性。编译通过不能证明运行时 fixture 已随镜像交付。

## 可重复故障、本地快检与缓存验收

从仓库根选择与改动相关的入口：

```sh
make check-changed CI_BASE=<actual-comparison-ref> ARGS=--plan
make check-changed CI_BASE=<actual-comparison-ref>
python3 -m unittest scripts.tests.test_check_changed
cargo test --locked -p areal-engine --test http_model --test provider_replay --test model_timeouts
cargo test --locked -p areal-engine --lib first_event_deadline_is_fixed_and_activity_starts_a_new_idle_window
cargo test --locked -p areal-engine --test model_input_budget
node --test clients/gui/scripts/desktop-projection-transport.test.mjs
pnpm --dir clients/gui test:navigation-cache
pnpm --dir clients/gui test:unit renderer/src/readingViews.test.ts
```

`scripts/ci-scope.py` 是本地与 CI 共用的检查计划所有者；`check-changed` 解析一次 merge-base，合并暂存、未暂存与未跟踪路径，重命名两侧均纳入，部分暂存相互抵消也保留选检。计划登记命令、依赖、环境能力、平台和 manifest 子测试全集，并绑定 base/source/head 与输入摘要。共享 Rust、schema、锁文件、构建与 CI 变化扩大范围，未知代码保守扩大；比较基准不可用时不得放行。

快检默认运行计划的 `commit` 阶段，加上历史报告中尚未通过的项目及其依赖，`ARGS=--phase=full` 执行完整计划。命令读取 `working-tree`，暂存内容影响选检和漂移检测；快检不证明部分暂存内容已执行验收。报告将未选的完整验收列为 `pendingRequired`，其他平台列为 `remoteRequired`。`passed` 只表示本轮所选项通过，`blocked`、`invalidated`、`failed` 均不得作为通过。

失败专项自动读取 `target/ci/{preflight,changed,failures}/*/report.json`。只考虑当前 HEAD 祖先链中、比较基线之后（含当前 HEAD）的报告，按检查 ID 和平台取最近提交的结果，同一提交内按完成时间排序；尚未通过且仍在当前计划中的项目与其依赖进入本轮重验。其他分支和已合入基线的记录不参与，祖先提交晚结束的通过结果不能清除后续提交的失败。报告只提供选检线索，命令始终取自当前计划，旧通过结果不作本轮证据。远端报告需先下载到 `target/ci/failures/<attempt>/report.json`；也可使用 `ARGS='--failure-report /path/to/report.json'` 显式导入，跨分支报告会报错。其他平台的专项保留为远端待验收，本机缺能力的专项明确阻塞。

进度直接读取结构化报告：`python3 scripts/ci-preflight.py --report target/ci/changed/<run-id>/report.json`。相邻 `plan.json` 必须与报告身份匹配。执行器在开始、执行中和每项完成时更新 `progress`：分别列出 `passed`、`failed`、`blocked`、`pending`、`running`、`invalidated`、`cancelled` 的数量和检查 ID。未选完整项和远端项都属于待执行，另列 `pendingFull`、`remoteRequired`；失败后独立检查继续通过也不清除失败。顶层 `status=passed` 仅表示所选本机项通过，`progress.status=pending` 表示完整计划仍有待验收项。读取进度命令的退出码只表示报告可读，不能作为验收通过的证据。

设计文档也是健康预算的输入：仅修改 `design/` 或 `clients/gui/design-system/` 下的 Markdown 会选择廉价的 `gui-health`，不因此启动 GUI 构建或 smoke。普通 `docs/` 文档仍只选择文档相关检查。

报告用 `selectedRequired` 记录本次实际选择。中断的本机尝试会把已选择但尚未产生结果的本机检查带入下一次快检；从未选择的 `pendingRequired` 与其他平台的 `remoteRequired` 不会因此变成本机全量任务。旧报告仅在相邻 `plan.json` 身份一致时恢复该集合。历史记录只提示重验，不能证明新 source/base/plan 已通过；`passed` 仍只表示本次所选检查，完整性以进度和远端待验条件为准。子 runner 缺项或重复项报告覆盖错误，完整集合内的失败报告具体 `failedScripts`；身份不一致仍直接失败。

定时任务编辑器只在显式编辑时加载；列表读取不导入编辑器，也不提交任务操作。动态 chunk 仍属于 Remote 离线资源闭包，新增 chunk 必须登记有界预算，不因此提高入口或总量预算。纯状态测试验证加载、重试和旧代次失效；SSR 检查只证明未提前导入；首次编辑、加载失败、切换任务和卸载后的过期回包仍需交互验收。

健康基线的人工审阅仍由代码评审承担，脚本不能验证人的授权。当前显式迁移记录仅认可 `activeDesignDocBytes` 从 262924 到 269714、owner 与方向不变的转换，理由是双语插件资源规范和折叠/文案规则，未留额外余量。它只解除与旧 base 比较的基线转换错误，实测超限、其他指标和源码上限照常失败。base 采用新值后记录不再匹配，可移除；下一次增长仍需新的审阅，不使用常驻 `--allow-regression`。

`make ci-preflight` 将工具版本、锁文件和输入摘要写入 `target/ci/preflight/<run-id>/metadata.json`，同目录 `plan.json` 冻结计划，`report.json` 保存每项命令、开始/结束时间、耗时、退出码与状态。格式、manifest/门禁契约、环境探针和生产包预算尽早执行；独立检查继续收集失败，只有真实依赖失败的消费者记录 `blocked`。每轮使用新目录保留失败，不缓存通过结果。

故障注入验收：`python3 scripts/desktop-schemas.py --counterexample` 使用真实 Rust schema 生成器验证漂移必被拒绝；`pnpm --dir clients/gui test:ci-budget-counterexample` 在隔离输出目录构建故意超限的生产入口，要求实际预算检查拒绝。`python3 -m unittest scripts.tests.test_ci_contracts scripts.tests.test_check_changed scripts.tests.test_git_hooks` 验证缺少 native 能力时阻塞、漏掉必跑项/子测试时 gate 拒绝，以及暂存规则与工作区隔离。首跑失败保留，不以自动重试达成全绿。

Core 连接仅合并无参 `areal/plugin/list` 和 `areal/plugin/mcp/list` 的同时在途原始读取，要求超时和响应预算相同，带 decoder 或 onResult 的调用独立执行。完成、失败和断开连接立即清理；写请求开始和结束都隔开读取，写后校验不能加入写前快照。`core-read-recovery.test.mjs` 用真实 WebSocket 与响应屏障验证 32 个并发读取只发一帧、控制请求可达、失败不缓存以及写入/连接/预算隔离，并纳入 `test:regressions`。该机制不缓存目录结果，也不自动重放写入或放宽 Core 的控制预留容量。

专用 Relay 传输合同使用独立 CI job，在 GUI 支持的 Node 版本下构建输入，再切换到 Relay 锁定版本执行。该 job 与 macOS GUI 路径并行，最终 GUI gate 仍要求其成功；取消、失败和意外跳过不能通过 gate。

Provider 回放夹具位于 `core/engine/tests/fixtures/provider-replay`，经真实 HTTP 字节、生产 decoder/Engine 和临时存储验证错误前文本、终止事件后断流、取消后迟到回答。请求到达与放行使用通知，不以固定 sleep 猜测。纯计时策略复用 Tokio 暂停时间；真实 HTTP 超时测试保留其 I/O 边界。字节块是服务器写入边界，不能假设操作系统一定保持网络分包。

`make test` 先通过 `make build` 准备同批 Core/Runtime，并将 `target/debug` 作为默认 `AREAL_TEST_BIN_DIR` 传给 workspace 测试。真实 Runtime 写入恢复由 `areal-engine/native-tests` 显式选择，在 `make verify-native` 和 Linux `runtime-tests` 容器运行；portable lane 保留三个 HTTP 回放用例。直接运行时，使用已部署并验证的同批固定 bundle 和显式 feature：

```sh
AREAL_TEST_BIN_DIR=/absolute/verified/bin cargo test --locked -p areal-engine --features native-tests --test provider_replay persisted_runtime_write_survives_disconnect_and_reopen_without_replay
AREAL_CORE_BIN=/absolute/verified/bin/areal pnpm --dir clients/gui test:history-compat
```

该原生测试在 `native-tests`（包含 `test-support`）下编译并使用既有测试构造入口，本改动不改变生产行为；未设置固定路径时应失败，不能当作跳过后通过。Runtime 场景核对写入后的真实持久记录、重开后工具结果及哨兵文件，防止把网络里程碑当作落盘或把恢复当作重放授权。`history-compat` 需要已构建 GUI；`profiles.json` 声明旧格式分页、已结算子会话和三种终态，runner 核对公开历史页、顺序、关系及 Renderer 文本，同时保持来源哈希不变和零模型请求。当前这两条原生路径的最终验收状态见[质量设计](t3code-quality-design.md)。

`model_input_budget` 从默认 Desktop 的真实出站求解请求计量固定指令、环境说明及每工具的 name/description/parameters。首个 profile 明确不含 Runtime 与插件；动态用户正文和随机路径不计入固定基线。基线变化报告分项与工具名，必须人工审阅更新，不自动调整生产输入或额度。

`test:navigation-cache` 使用生产 React App、真实 Chrome 和 fixture PlatformServices，记录无关 UI 操作的派生计算次数，检查名称、未读、运行、排序和新快照刷新，并保存源码身份及截图。它不启动 Core/Electron，也不验证安装包或感知延迟。`readingViews` 单测覆盖 32 项内存边界、最近访问淘汰、存储不可用和语义锚点重载；真实主题与布局连续性仍需 Renderer 场景。旧 `conversation-flow` 场景在 `.tool-summary-row .tool-failed` 定位器超时；生产折叠失败状态由 `ActivityRowStatus` 的 `data-tone="failed"` 表达。该 markup 与 `readingViews` 容量裁剪属于不同边界，本专项未修改旧 runner，完整对话流未计为通过。

## 本地验证产物与启动诊断

`make build` / `make release` 在 Cargo 成功后写入 `target/<profile>/verification-build.json`，绑定现有 Core `inputHash`、构建提交和整套 Core/Runtime 的 SHA-256。GUI 构建沿用 bundle 分析插件，在 `renderer/dist/verification-build.json` 中记录 GUI 输入摘要与输出文件哈希；构建期间源码改变则失败。

从仓库根将同批产物部署到独立固定槽，随后诊断：

```sh
python3 scripts/verification.py deploy --source-dir "$PWD/target/debug" --bin-dir "$PWD/.local/dev-bin/verification" --evidence "$PWD/.scratch/verification/deployment.json"
make gui-build
python3 scripts/verification.py doctor --core "$PWD/.local/dev-bin/verification/areal" --report "$PWD/.scratch/verification/startup-1.json"
```

部署复用现有进程/打开文件检查，拒绝占用中、缺组件或构建后被改写的产物。验证助手在整轮测试期间持有同槽 `.verification-lock`，部署也使用此锁；锁不自动过期。异常退出后先读取 `owner.json`、确认进程和本轮服务已停止，再处理残留锁。原本机固定路径部署与 doctor 入口调用这些受控实现，不能以测试目录隔离代替构建身份核验。直接 `cargo build` 不产生同批回执，应使用 `make build`。

doctor 在启动 Electron 前检查 Core 内嵌输入身份、整套组件哈希、Renderer 源码和输出哈希。报告包含三个程序的路径、SHA、探测命令、退出码或信号，以及 macOS 签名检查；任一失败仍保留其余探测，返回非零。每次使用新的报告文件，已有报告拒绝覆盖。文件助手无请求探测只验证启动，不执行文件操作。退出 0 和签名有效均不证明人工授权；`authorization` 默认 `unknown`，人工实际观察后可用 `--authorization-observation areal=allowed` 等逐组件记录。SIGKILL 只记为信号，不能自动归因为防护拦截。报告不替代真实 Runtime、供应商或安装包验收。

浏览器静态验收通过现有 `verification.py` 从匹配当前 GUI 输入的构建创建独立副本：

```sh
python3 scripts/verification.py snapshot-renderer --source-dir "$PWD/clients/gui/renderer/dist" --output-dir "$PWD/.scratch/verification/renderer-1"
pnpm --dir clients/gui test:history-navigation-ui
```

输出目录必须尚不存在；复制前后核对构建回执、源码摘要和每个输出文件，全部成功后才发布副本回执。后续共享 `renderer/dist` 重建不会改变已复制产物。回执保留源码提交、输入摘要、原构建路径和副本文件哈希，证明的是本轮产物，不代表后来源码通过。工作区选择和终验期间的构建顺序遵循[并行修改与终验](README.md#并行修改与终验)。

历史导航 runner 自动调用该入口，只服务本轮静态副本；设置 `AREAL_RENDERER_DIST` 仍要求其回执匹配当前源码。`renderer/test-fixtures/history-navigation.ts` 直接实现生产 `DesktopBridge`，随 Renderer 类型检查；删掉 `onPreviewEvent` 或 `onUpdate` 会在启动浏览器前失败。runner 以现有 Vite 构建该夹具并核对与 Renderer 相同的输入摘要，保留真实桌面适配器和投影读取路径。检查覆盖鼠标与键盘历史导航、冷项目切换、UNKNOWN 原请求保留和零提交；边界是 Chrome + Renderer + bridge 夹具，不覆盖 Electron/Core。

任务目录 smoke 的页面夹具位于 `clients/gui/renderer/test-fixtures/scheduled-workspace.tsx`，与 Renderer 一起类型检查，并由原浏览器 runner 直接加载。它验证新意图经 `onStartDraft` 打开草稿、项目默认值及旧请求的显式核对与被动回执；夹具仅替换 IPC 边界。

## GUI 测试清单与平台资格

`clients/gui/scripts/test-manifest.json` 是根 `package.json` 中全部 `test:*` 命令的登记表。`layer` 区分纯逻辑单元、无 GUI 的契约和浏览器/Electron 端到端边界；`platforms` 声明脚本可运行的平台，`areas` 声明领域，`requires` 声明环境条件。仅支持一个平台的条目必须填写 `platformReason`。平台声明不等于该平台已经验收通过。需要 Core 的无界面测试仍属契约层。

从 `clients/gui` 执行以下命令。真实 Core 用固定产物，测试期间不重新构建。

```bash
pnpm verify:tests
pnpm test:unit
node scripts/test-manifest.mjs --list --platform=linux --layer=contract --available=git,python3,gui-build
node scripts/run-portable-tests.mjs
AREAL_CORE_BIN=/absolute/fixed/areal node scripts/run-portable-tests.mjs --core-contracts
node scripts/test-manifest.mjs --ci-matrix --base=<commit>
node scripts/repeat-tests.mjs --profile=linux-feasibility --plan
AREAL_CORE_BIN=/absolute/fixed/areal xvfb-run -a node scripts/repeat-tests.mjs --profile=linux-feasibility
AREAL_CORE_BIN=/absolute/fixed/areal node scripts/repeat-tests.mjs --profile=macos-baseline
```

先运行 `make gui-build` 准备 portable runner 所需的 Desktop/UI/Renderer 产物。该 runner 按计划运行当前平台和所属通道的全部单元与契约测试；能力缺失记录 blocked 并失败，不据此删去应跑项。记录每个结果、耗时及其他通道拥有的命令。报告默认按模式和每次运行分别写入 `target/ci/gui/portable/<run-id>/report.json` 或 `target/ci/gui/core-contracts/<run-id>/report.json`，保留失败尝试，记录源码与 diff 摘要、Core 产物哈希及 CI run/attempt；`AREAL_PORTABLE_TEST_REPORT` 可显式指定输出文件。Relay 完整传输契约另外需要其锁定的 Node 24.2.0 和 `services/remote-relay` 依赖，CI 使用独立步骤执行。真实 CA/HTTPS/WSS 测试位于 `remote-relay-system-ca.test.mjs`，仅由 `test:remote-relay` 执行；`test:remote-relay-contracts` 保留无需启动 Relay CLI 的通用合同。

`--core-contracts` 要求可执行的 `AREAL_CORE_BIN`，运行登记的 Core 依赖契约。macOS 构建任务在匹配的 Core/Runtime bundle 构建完成后运行该集合，归档对应 Core 合同报告；Linux portable lane 保持不依赖 Core。必跑 smoke 矩阵还对匹配的设计构建执行 `test:design`，包含真实浏览器无障碍和键盘检查。活跃 `design/**` 改动会触发 GUI 检查。

`ciSmoke` 绑定现有 macOS smoke 矩阵。领域映射只裁剪已知的局部 Renderer 改动；共享所有者、测试脚本、未知路径及没有对应 smoke 的领域保留完整矩阵。没有比较基准的运行也使用完整矩阵。Linux 单元与契约不按领域裁剪。

临时目录统一使用 `scripts/support/temp.mjs` 的 `makeTempDir(prefix)`。它对 `os.tmpdir()` 做 `realpath`，保留 macOS 路径比较语义。`verify:tests` 通过 AST 检查所有登记脚本及本地导入，拒绝实际路径字面量 `/private/tmp` 和 `/var/folders`。审计规则及负例中的字符串不构成临时目录创建。

重复驱动保留每次首跑的日志、独立临时目录、退出状态、耗时和运行前后源码/Core 摘要，不自动重试或删除失败。Linux 计划复用启动/恢复、发送/流式、停止 Turn、桌面设置、退出草稿五个现有 runner，各跑 10 次；macOS 计划对可无人值守的登记 E2E 各跑 5 次。`--scripts=test:composer,test:queue` 可缩小范围，报告明确标为 scoped。`--repetitions=N` 可用于诊断，但少于 10 次的 Linux 样本不能获得必跑资格。退出草稿仍要求仓库 `.local/dev-bin/` 下的完整固定 Core bundle。

Linux 必跑候选必须完成每条旅程至少 10 次首跑、无环境阻塞、通过率不低于 95%，并保持源码身份不变。10 次样本实际要求 10/10。完整 macOS 五次基线低于 95% 且存在真实失败时列入 `flakyCandidates`；环境阻塞单独报告。维护者核查失败原因和证据后更新 `flaky: true` 或批准 Linux 必跑集。候选资格报告不会自动更改清单或降低现有门禁。

在 [GUI workflow](../../.github/workflows/gui.yml) 手动选择 `qualification=linux-feasibility`，可在原生 Ubuntu + xvfb 执行上述 Linux 计划；选择 `macos-baseline` 则按脚本展开五次基线。Linux 检查非 root 身份、DISPLAY、user namespace 和 Bubblewrap，能力不足返回 blocked，保持 Electron/Runtime 沙箱，不使用 `--no-sandbox` 或修改宿主安全策略。尚未取得并审阅的资格不能当作 Linux 通过。手动资格任务独立呈现失败，不替代必跑的 GUI gate。

Linux portable job 的 10 分钟 timeout 是上限，不是耗时达标证据。`portable-interval.json` 记录首个执行步骤到报告步骤的实际区间，不含 runner 准备和 artifact 上传。完整 job 耗时需结合 GitHub Actions 的 job 时间核对；未运行远端 CI 时不能声称低于 10 分钟。

公开源码扫描允许随产品分发的内置 Skill 和 UI 包两份使用/审查 Skill 的确切路径；这些文件继续接受私有路径与凭据内容扫描。`test:regressions` 验证公开文件通过、其他 Skill 被拒绝，以及公开 Skill 中的私有内容仍会失败。

## Git 身份与认证

`make git-auth-smoke`（也随 `make harness-smoke` 执行）使用独立 HOME、前台 SSH agent、确定性本地模型和 loopback HTTPS bare repo，经公开 `service ensure`、CoreClient、Core 工具调用和真实 Runtime 完成提交/签名/推送。加载测试密钥后删除磁盘私钥，缺少 agent 时必须签名失败且 HEAD 不变；错误密码必须被 HTTPS 拒绝且远端 ref 不变。证书使用临时 CA 显式信任，不关闭 TLS 校验。检查同时核对原配置字节不变、模型/结果/服务日志不含测试密码，以及服务进程退出。

先构建完整产物并安装现有 Node 开发依赖，单独执行 `node scripts/git-auth-smoke.mjs`；`AREAL_TEST_BIN_DIR` 可指定 bin 目录，`AREAL_GIT_AUTH_EVIDENCE_DIR` 保存证据。需要 Git SSH 签名、OpenSSH、OpenSSL 和 loopback 监听能力。macOS 的临时根默认 `/tmp`，避免登录会话默认长路径超过 Unix socket 上限；Linux 默认使用系统临时目录。可用 `AREAL_GIT_AUTH_TMPDIR` 显式指定已授权的短目录，需要该目录的写权限；目录不可用或过长直接失败，不自动换路径重试。该检查不读取用户凭据、不操作已有桌面服务，也不代替真实供应商、GUI 点击或模型分支选择行为测试。

验证本机 Keychain 的实存条目认证时，须先明确获得临时测试条目写入许可，再运行 `AREAL_GIT_AUTH_EVIDENCE_DIR=/已授权的证据目录 node scripts/git-auth-smoke.mjs --keychain`。该可选模式使用登录 HOME 和系统 `git-credential-osxkeychain`，但 Git 全局配置显式指向合成文件；只对随机账户、精确 loopback 端口和路径创建、读取、更新及删除合成凭据，不使用已有凭据、不自动解锁、不修改默认钥匙串或搜索列表。它检查成功 HTTPS push、错误及缺失凭据的失败保护，并核对清理及 Keychain 设置不变。`SIGINT`/`SIGTERM` 会进入有界清理；强制终止或清理失败时，证据目录的 `*-keychain-cleanup.json` 保留不含密码的精确 helper/query，须先核对原服务退出并按该条目恢复清理，不能把未确认清理记为成功。该模式不加入默认 CI，且本机通过不等于原反馈用户或真实远端已验证。

macOS 登录会话中的 Keychain 权限边界另用 `python3 scripts/git-keychain-smoke.py --bin-dir target/debug` 检查；可传 `--report` 保存 JSON。它仅查询随机不存在的域名/账户，不枚举、读取或写入用户凭据。完整授权应成功返回未匹配；显式 native、固定只读输入、禁网及写根收窄应保留拒绝。`-50` 只记录为观测，不作为通用的密码错误分类。缺少系统 helper 或可用登录会话会失败，不跳过或记为通过；该检查不进入无登录会话的通用 CI，也不证明真实钥匙串条目已解锁或远端授权有效。

## GUI 与桌面路由门禁

会话目录回归使用 `cargo test --locked -p areal-app-server --lib catalog_tests`、`cargo test --locked -p areal-engine --lib catalog::tests`、`cargo test --locked -p areal-engine --test catalog_observation` 和 `node --test clients/gui/scripts/catalog-refresh.test.cjs`（从仓库根运行）。覆盖旧元数据与持久字节兼容、过滤先于分页、完整参考对照、长过滤空洞、游标排序与授权、会话锁与注册互不阻塞、注册回滚，以及 GUI 合并刷新和连接换代。观察回归还核对模型输入、工具副作用、用量及重启历史不受目录读取影响。GUI 用例已纳入 `pnpm --dir clients/gui verify`。

显式局部性能对照使用 `cargo test --locked --release -p areal-app-server --lib catalog_performance_comparison -- --ignored --nocapture` 与 `node clients/gui/scripts/catalog-refresh-benchmark.cjs`。后者可传入旧版 `history-observation.cjs` 路径，在相同 fixture 下比较旧协调器。耗时不作为 CI 阈值；固定源码、原始样本、复现方法与测量限制见[会话目录性能报告](../benchmarks/reports/conversation-catalog.md)。

稀疏过滤性能入口为同一 Rust 测试模块的 `catalog_filter_performance_comparison`，同样显式 `--ignored --nocapture` 运行。GUI 脚本设置 `AREAL_CATALOG_BENCH_CACHE=production` 后使用真实 library 序列化、写文件与 rename，并保留活动标记写入；`AREAL_CATALOG_BENCH_THREADS` 可选择 1–20,000 行。交替运行与剩余成本见[目录迭代验证](../benchmarks/reports/conversation-catalog-validation.md)。

会话目录两种后端使用同一套 RPC 回归：分别设置 `AREAL_CATALOG_TEST_BACKEND=memory`、`sqlite` 运行 `cargo test --locked -p areal-app-server --lib catalog_tests --jobs 3 -- --test-threads=4`。该变量仅由测试读取；生产使用 `[storage].session_catalog`。`cargo test --locked -p areal-engine --lib catalog:: --jobs 3 -- --test-threads=4` 覆盖索引重用、离线更改核对、损坏保留重建、外部写锁、索引积压回退、队列溢出、读取期限、安全路径和注册结果未知后的回滚；`catalog_observation` 同时覆盖两个后端的模型输入、真实文件副作用、用量及重启不重放。配置入口使用 `cargo test --locked -p areal-config --test session_catalog`。

`catalog_backend_performance_comparison` 是显式忽略用例，比较文件缓存已暖时的完整恢复、索引构建/重用、完整分页、大元数据、真实事实创建与产生快照的 Turn 并发读取。用同一个 release `--lib` 可执行文件切换后端，交替独立进程各至少 5 次，保留 active backend、索引命中、回退、写入行数和峰值 RSS。不要同时构建其他目标或将 fixture 准备算入查询；索引重用不等同于磁盘冷启动。构建后的 `scripts/smoke.mjs` 与 `clients/gui/scripts/large-history-smoke.mjs` 也接受 `AREAL_CATALOG_TEST_BACKEND=sqlite`，向隔离配置写入该选择并检查数据库已生成。结果和边界见[SQLite 对照](../benchmarks/reports/conversation-catalog-sqlite.md)。

追加的 `catalog_cooperative_concurrency_performance_comparison` 让两种后端在每次读取后主动让出调度，诊断闭环 fixture 的写锁重叠差异。它也是显式 `--ignored --nocapture` 用例，需各后端独立交替 5 次；保留原始非协作结果，不能把单线程 fixture 的读延迟差距直接写成生产退化。



`memory-lazy`、`sqlite-lazy` 复用同一套目录回归，`catalog_observation` 同时覆盖四种模式及恢复后继续执行、原工具不重放。`cargo test --locked -p areal-engine --lib store::lazy --jobs 3 -- --test-threads=4` 覆盖首次加载并发/取消、目录与工作概览、事实字节、同长度离线编辑、成员增删、限制收紧、错误/未知版本缓存及执行前核对。完整 Engine/config/app-server 回归可分别设置测试专用 `AREAL_TEST_SESSION_CATALOG=memory-lazy`、`sqlite-lazy`；仅编译 `test-support` 时生效，生产默认不读取该变量。显式 `Limits.session_catalog` 优先，避免覆盖用于对照的 eager 实例。

GUI 刷新回归随 `test:regressions` 执行，保留共享列表/元数据解码与后端断连读取屏障；畸形响应不能覆盖最后一份完整缓存。生命周期回归区分普通 shutdown 与显式 drain，核对重启后的队列暂停和完整历史，并记录缓存重新校验的边界。 四模式另对照时钟回拨下的空闲回收判断，覆盖归档恢复及缓存复用，同时确认冷历史不被展开。

缓存故障回归还覆盖：缓存成员数大于收紧后的上限而事实数合法、SQLite 初始化五阶段中断残片、事实验证后等待发布锁时取消、重复缓存身份、外部缓存写者占用，以及符号/硬链接路径。所有缓存重建仍核对事实字节不变、下一次打开能命中缓存；外来数据库与未知版本的原字节必须保留。

`catalog_lazy_tests::lazy_catalog_process_comparison` 是独立的忽略用例。先构建 release app-server `--lib` 并冻结一个程序，然后为四种 `AREAL_CATALOG_TEST_BACKEND` 分别创建隔离文件副本。环境变量 `AREAL_LAZY_PERF_ROOT`（绝对目录）、`AREAL_LAZY_PERF_COUNT`、`AREAL_LAZY_PERF_CASE=ordinary|archiveGap|cli|mixed` 和 `AREAL_LAZY_PERF_OPERATION=prepare|startup|directory|execution|preloaded-execution|all` 控制场景；`prepare` 另需 `AREAL_LAZY_PERF_BODY`、`AREAL_LAZY_PERF_METADATA`。准备进程与观测进程必须分开。 `execution` 包含冷正文的首次恢复；`preloaded-execution` 在执行计时前读取目标历史，并将该成本单列为 `preloadMs`。两者均拆分准入 `startMs` 与准入后的完成等待 `waitMs`，预加载结果不能替代冷执行结果。 诊断时可选 `AREAL_LAZY_PERF_PERSISTENCE=1`，在隔离进程采集已有持久化序列化、排队、写入和同步计时点；带采集的样本须与普通计时分开保留。比较首次缓存构建、复用、单文件修改后的启动，记录准备好的文件总量、事实解析量、缓存命中、阶段 RSS、进程峰值、首次/重复历史读取、首次继续执行和全部打开后的代价。查询含 RPC 投影与 JSON 编码，预热 2 次后保留 10 次（完整目录 5 次）；每模式交替运行至少 5 个独立进程，不并行运行构建/功能测试，不称为磁盘冷启动。保留所有不利样本和退出状态，见[按需加载对照](../benchmarks/reports/conversation-catalog-lazy.md)。原生 smoke 的后端变量也接受两个按需值。

`cargo test --locked -p areal-app-server --lib desktop_registered_methods_have_dispatch_routes` 对每个已注册桌面 RPC 经真实连接分派发送非对象参数，要求返回参数错误而不是方法不存在；包含连接层单独接管的 `areal/thread/start`。该检查随 `make test-protocol`、`make test` 和 CI 执行，不启动模型请求或创建 Thread。

[GUI CI](../../.github/workflows/gui.yml) 按影响范围运行冻结依赖安装、GUI 类型检查、公开边界、Core/GUI 构建、桌面路由检查及已登记的 macOS smoke 矩阵。Linux 静态健康检查和 portable 单元/契约使用独立 job。测试使用隔离目录与确定性本地模型，保留日志、截图与源码 manifest；这些证据不替代真实供应商或安装包验收。

Composer 和队列 smoke 共用 `clients/gui/scripts/smoke-navigation.mjs` 的导航与窄窗步骤：悬停项目后新建对话，通过稳定 task ID 切回对话，窄窗先收起侧栏再等待编辑器可见。失败保留 `failure-window.png` 整窗截图和 `failure-state.json` 的原错误、视口、当前项目/Thread 与可见文本；截图或页面已不可用时记录采集失败，不替换原测试错误。

Composer 的 IME 前置清空通过真实键盘全选与退格完成，再同时核对 DOM、Lexical 和草稿存储为空。Playwright `fill("")` 的 DOM 全选可能与编辑器内部选区不同步，不能作为组词测试的清空前置；后续候选输入、提交和取消仍通过 Chromium 原生 IME 事件验收。

Composer smoke 通过 Side 标签的 Delete 键关闭已完成的阅读视图，并等待主编辑器可见，覆盖窄窗完整视图和宽窗分屏；窄窗的面板按钮仅切换视图。模型选择 smoke 在冷重启后的配置应用前，读取真实 `serviceStatus`，等待任务、操作、项目启动和配置更新全部结算后单次提交。

Slash 键盘验收等待本次打开触发的 Core 目录刷新完成，再核对方向键移动到的具体选项及编辑器 `aria-activedescendant` 一致后按 Enter；原选项的已选中状态不能证明方向键已经生效。

原生工具 smoke 在断言前等待 HTTP fixture 的请求线程全部结束。主求解请求与完成审计严格等量；单次辅助命名允许在 HTTP 抵达前取消，此时只接受无 HTTP 状态的中断审计。已观测请求缺审计、重复命名、未观测却完成以及命名携带工具均失败。

插件连接回归通过一次性屏障冻结旧目录扫描，验证其不能撤销扫描后发布的新代；另在握手暂停时禁用插件，要求禁用完成且连接不得发布。原生工作组用例失败时保留临时目录，并输出具体场景、模型用量和权威工具回执，区分预算错误与其前序失败。

模型选择 smoke 中，只有“应用模型配置”后的设置操作结算检查使用 180 秒期限，覆盖现有 150 秒应用 IPC、后续配置读取和界面结算。其它页面动作仍使用默认 15 秒。测试只提交一次应用，等待返回入口恢复后继续核对实际 Core 模型目录和请求，不用固定 sleep 或重放应用掩盖失败。

桌面连接 smoke 的独立 CLI 配置读取、服务停止和状态查询复用产品 `executeCore` 启动桥；macOS 保留系统 Python 作为原生 Core 的实际父进程，测试不以 Node 直接启动替代产品入口。断线后仍检查原 Turn、订阅和请求计数，不重放提交。

## 使用统计历史同步

`node --test scripts/analytics-history.test.cjs` 使用真实 `CoreClient` 和本地 WebSocket 协议 fixture，验证独立只读历史连接的 4 MiB 帧限制不会关闭项目主连接，以及启动时模型尚未连接、身份切换、历史去重、部分缓存、握手/RPC 超时和主连接关闭后的清理与部分历史告警。统计连接只进行初始化、能力握手和 `thread/read`，沿用客户端默认请求期限；同一项目只运行一次同步。大历史失败仍显示部分同步，不能据此认为完整历史已同步；该测试不替代真实 Core、原生 GUI、安装包或供应商验收。

## Python 与 scratch

失败状态与截图采集各最多等待 10 秒，derivation 的 Electron 退出最多等待 20 秒，超时记入证据而不覆盖原始失败。CI 的 derivation 步骤限制为 10 分钟，避免故障采集阻止后续 artifact 上传；`make script-test` 验证诊断超时与原错误传播。

derivation 的连续录屏需要 Playwright 固定版本的 FFmpeg，不能只安装 Electron/npm 包。GUI CI 使用 `pnpm --dir clients/gui --filter @areal/gui-desktop exec playwright-core install ffmpeg` 安装；本地首次运行此 smoke 前也执行该命令。

录屏场景在等待 Playwright `close()` 前请求正常 `app.quit()`，让产品退出与录像收尾同时进行；仍等待 `close()` 结算完成。Playwright 自身先收尾录像再请求退出，串行耗时会挤占同一个 20 秒期限。回归通过受控录像等待验证先后关系，退出不完成仍在原期限失败；不跳过草稿确认、不强制成功，也不丢弃录像。

满屏 Side 使用自己的 Composer，主聊天草稿保持挂载但隐藏，避免浮动操作遮挡 Side 的模型与发送入口；分栏模式仍显示两个 Composer。derivation smoke 经真实点击检查 Side 模型选择与首问提交，并核对主草稿保留。

Linux 回收测试使用随 `cargo test -p areal-runtime-exec-native` 构建的 `areal-runtime-reaper`。若单独运行 `--lib`，先执行 `cargo build --locked -p areal-runtime-exec-native --bin areal-runtime-reaper`，且构建和测试须使用相同 profile。macOS 后代测试让祖先存活至跟踪窗口内再退出，验证已观察后代清理；不把该测试解释为快速孤儿化的完整保证。

`areal-local-service` 的 macOS 输出超时回归先等待真实子进程就绪，再短暂推进 Tokio 时钟触发超时；定位握手后清理的用例还须确认 Rust 已消费握手，不能仅凭 PID 文件判断。随后恢复实时时钟，验证取消等待者仍会回收真实子进程和桥；被停止的桥按实现已有的两段 5s 清理预算观察。这些测试不放宽生产超时或权限，也不以固定 sleep 猜测清理阶段。

macOS Python/scratch 的独立回归（本地模型，不需要供应商密钥）：

```sh
python3 scripts/native-python-smoke.py --bin-dir target/debug
```

`make harness-smoke`（由 macOS CI 的 `make verify-native` 调用）包含此回归。它在默认 YOLO 和显式 native 沙箱下分别验证自动 scratch 与自定义 `--scratch`：两者均暴露 `verify_command`，并在 Thread 私有子目录保存退出码为 0 和 7 的验证回执。共享解析器测试覆盖已安装 CLT 但无 `developer_dir` 链接的发现路径，并验证 framework 外的解释器被拒绝。

`make workgroup-smoke` 同时验证 Worker 命令的 `TMPDIR` 位于私有工作区下的 `.scratch/agent-<threadId>`，该目录可写且 Python 字节码写入被禁用。

Rust 工具链回归通过真实 Runtime 在最小桌面 PATH 下离线构建并运行无依赖 Cargo 程序，再通过工作区内的本地 Git 仓库依赖验证 Cargo 获取与离线缓存复用。它覆盖普通作用域及仅 scratch 可写的只读仓库子作用域，同时验证仓库外文件读取被拒绝。此测试需要已安装且可确定默认版本的 Rust 和系统链接工具，不下载工具链或依赖。`--version` 检查不能替代编译和链接验收。

```sh
python3 scripts/native-rust-smoke.py --bin-dir target/debug
```

`make harness-smoke` 包含此回归。它使用隔离 Cargo home 和本地 Git fixture，不证明宿主 Cargo 缓存、私有依赖、真实模型或安装包中的工具调用可用。

## 恢复与研究 Agent

`python3 scripts/navigation-read-scope-smoke.py --bin-dir target/debug` 使用真实 Runtime 和确定性本地 HTTP 模型，在后台写进程仍运行时读取、搜索文件；检查导航不等待写队列、受限 Scope 复用、原进程终止、文件版本冲突和越界拒绝。可用 `--sandbox-profile full-access` 复核全访问父 Scope 的权限收窄，或用 `--evidence-dir` 保留完整证据。此项随 `make harness-smoke` 执行，不调用外部模型，不代表完整任务性能结论。

macOS 的 creation admission 强杀夹具与本机服务采用相同的受信 Python 父进程入口，检查工作进程实际收到 SIGKILL，并保留强杀点、持久化 binding、恢复与禁止重放断言；其他 Unix 平台保持直接启动。

```sh
cargo test --locked -p areal-engine --test truncated_usage --test tool_call_stream --test http_model --test context --test tools --test async_agents --test recovery
python3 -m unittest discover -s scripts/tests
python3 scripts/native-tools-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
python3 scripts/native-agents-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
```

原生工具/Agent smoke 使用本地固定响应 HTTP 模型、统一 launcher 与临时工作区，无需外部模型。覆盖文件 CAS、搜索、验证 receipt、图像，以及不委派、单 Worker、同步等待、预算失败、父取消和默认异步；异步用例要求三个 Worker 请求结束前父任务继续推进，并检查主/子采样参数。流测试覆盖 length 同帧/尾帧 usage、EOF/取消、不重放 UNKNOWN、压缩后句柄与跨 Turn 边界。

本地 HTTP fixture 必须将 `127.0.0.1,localhost,::1` 加入测试进程的 `NO_PROXY` 与 `no_proxy`，并保留原有条目，避免代理改写断流或引入等待。真实 HTTP 用例检查参数、历史及终态；只有参数增量时，握手门闩要求先收到 Activity 才释放终态。150 ms 空闲边界在冻结时钟下分别检查 40 ms 活动续期、宿主停顿与 220 ms 真正静默；静默只重试未完成响应，已确认工具执行一次。只服务解题的 fixture 按 `RequestPurpose` 拒绝辅助请求，自动命名的额度与生命周期由独立用例验证。不得通过放宽生产时限、SSE 上限或预算消除测试失败。


请求预算测试覆盖 Chat Completions 与 Responses 在最后一轮返回工具时的 `MAX_MODEL_ROUNDS` 分类，并检查零工具执行、无重试和原始预算审计；普通工具调用预算耗尽及非法 `index` 不应被误分类。桌面 CLI 验收同时检查对应的 `error_max_turns` 结果。Goal HTTP 回归同时验证输出 token 上限与工具数量/缓冲预算经过共享池后仍生效，失败请求的未知消费阻止后续重试和工具执行。

交互进程 smoke 在创建非 PTY 管道时显式传入 `stdinOpen:true`，先核对 `stdinMode=pipe` 与运行状态，再写入并验证输出；PTY 独立检查 `stdinMode=pty`。原生工具 smoke 另验证默认关闭 stdin、写入后 EOF 和单独 EOF，避免依赖旧的隐式开放管道。

Linux 需要 Bubblewrap user/PID namespace、seccomp，以及 Python 和 Bash；rg 随构建产物交付。`make harness-smoke` 包含受限原生工具 smoke，验证内置搜索及宿主假 rg 不影响命令解析。也可用公开 Dockerfile：

```sh
docker build -f tests/e2e/docker/Dockerfile \
  --build-arg INSTALL_CODEX=0 --build-arg INSTALL_CLAUDE_CODE=0 \
  -t areal-native-smoke .
for smoke in native-tools-smoke native-agents-smoke; do
  docker run --rm --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined --security-opt apparmor=unconfined \
    --mount "type=bind,source=$PWD,target=/repo,readonly" -w /repo \
    --entrypoint python3 areal-native-smoke \
    "scripts/$smoke.py" --bin-dir /usr/local/bin --sandbox-profile outer-container-perf
done
```

外层容器放宽项仅适用于显式选择的受控 profile，命令仍在 Bubblewrap 内执行。Docker 默认 AppArmor 会拒绝 Bubblewrap 的 namespace 挂载，因此此 profile 同时显式放宽 AppArmor；不使用 privileged 或增加 capability。Ubuntu 24.04+ 还需由管理员为 `/usr/bin/bwrap` 配置允许 `userns` 的 AppArmor 规则；仅取消 Docker 的 AppArmor profile 不会解除宿主的此项限制。CI 在临时 runner 上加载仅匹配 Bubblewrap 的规则，并在编译前预检 namespace 与挂载能力。macOS 的 `/usr/bin/python3` 可能经 Xcode 选择器读取未授权配置，不应为 smoke 自动扩大沙箱权限。TUI 重连 smoke 等待 `live` 订阅后再提交，连接和历史缓存可见不代表权威快照已恢复。

## 容量

| 命令 | 负载 |
|---|---|
| `make capacity-primitives` | 20,000 个异步任务的推进与取消 |
| `make capacity-core` | 10,000 个子 Agent、实际持久化与受控模型许可 |
| `make capacity-workgroup` | 32 个真实 Runtime、独立写入与组合检查，需 macOS |

`make capacity` 顺序执行，默认 verify 不包含容量测试。结果须注明硬件、构建模式、存储和模型替身，不能当作真实 LLM 吞吐。

## 平台接入边界

`make integration-boundaries` 需要 Git checkout，随 `make script-test` 执行，防止平台适配依赖进入产品源码、发行/安装入口、工作流和递归默认 Make 目标。通用 Rust `id-arena` 分配器不属于平台依赖。平台适配与生命周期验收由消费端维护；原生 CLI、Runtime、Engine 和工具测试覆盖公开契约。

## CI 与契约

macOS 与 Linux 宿主检查使用同一矩阵定义，`fail-fast: false` 保证任一平台失败不取消另一平台的覆盖。macOS 使用 `make setup-node`，仅安装原生 smoke 和 SDK 所需的 Node 依赖；Linux `make setup` 继续安装全部锁定格式工具。原生验收在同一次子 Make 调用中运行 Runtime、Harness、桌面 API 和 Workgroup smoke，共用一次 workspace build。Docker 只复制所需 CLI/TUI/Web 客户端，GUI 不进入构建上下文。原生 Runtime 和 Harness 覆盖保持不变。

`harness-smoke.mjs` 通过真实 Core/Runtime 和模型请求检查根/嵌套 `AGENTS.md` 与 `AGENTS.override.md` 的单层替换、空白回退、顺序、无关目录隔离、缺失文件、跨 Turn 刷新、32 KiB 边界、UTF-8 和符号链接拒绝。

[CI](../../.github/workflows/ci.yml) 在 macOS 执行原生 Harness，在 Linux 执行常规回归和 Docker sandbox/文件所有权检查，独立检查 Rust/npm 依赖公告。工作流固定 action commit、使用只读权限并保留失败日志；是否通过以对应提交的运行结果为准。

PR、`main` 推送和手动触发运行完整检查，避免同一功能分支的 push 与 PR 重复运行。Linux 常规回归与容器检查并行，常规回归内部的格式、SDK 与脚本检查并行，随后顺序执行静态检查、Rust 测试与 TUI smoke；原 `Linux checks and container Runtime` 检查名保留为汇总门禁，宿主矩阵与容器任务均成功才通过。macOS 运行 `make verify-native`，只补充 Linux 不覆盖的原生后端和 Harness 集成 smoke。

宿主缓存 Cargo 依赖产物、npm 下载和 uv 包；容器测试同时复用 Runtime 镜像构建层，Docker 使用 BuildKit 的 GitHub Actions 层缓存。缓存命中仍执行测试。Rust 缓存按平台、工具链与依赖清单区分，CI 关闭调试符号和增量编译以缩小构建产物。`cargo-audit` 只缓存固定版本工具，每次仍读取公告并审计锁文件。

容器行为检查传入 `--build-arg BUILD_PROFILE=ci`，使用继承 `dev` 的 Cargo `ci` profile，保留调试断言，关闭调试符号和增量编译。`runtime-tests` 同样使用该 profile，复用依赖产物。Dockerfile 默认仍为 `release`（含 thin LTO），性能测试应使用默认构建；镜像标签 `io.areal.perf.build-profile` 标明实际 profile。CI 镜像不能用作 release 性能数据。

`make schemas` 更新固定 Codex schema，`make desktop-schemas` 更新桌面 schema；同时维护类型、调用方与契约。真实模型、GUI、第三方 daemon、签名/公证和其他平台不由本地 fixture 代替验收。性能测试见[基准指南](../benchmarks/README.md)。

## 网络代理回归

```sh
cargo test --locked -p areal-engine --test model_proxy
cargo test --locked -p areal-mcp --test proxy --test client
cargo test --locked -p areal-engine --lib plugin_host_inherits_proxies_without_other_credentials
```

代理 fixture 使用动态 loopback 端口和独立子进程环境，覆盖 Chat Completions/Responses 流式正文与用量、HTTP/HTTPS 代理、HTTPS CONNECT、SOCKS5 本地/远端 DNS、认证、大小写变量和 NO_PROXY 绕过；真实 MCP 初始化、发现和搜索调用经过代理。MCP HTTP 库的 TLS 测试显式信任 fixture 证书；`tests/fixtures/proxy` 中的公开测试密钥不用于部署，也不安装到系统信任库。stdio MCP 与插件进程验证代理变量继承及其他凭据隔离。第三方搜索供应商、任意插件 HTTP 库和实际部署代理需另行验证。

## Goal 回归

`cargo test --locked -p areal-engine --test watchdog` 同时验证普通请求的网络重试与 Goal 的未知用量约束，覆盖传输失败、限流、服务不可用、断流、请求/流超时和摘要失败；Goal 不进入重试退避，保留预算预留及旧 checkpoint，并释放模型许可。

`cargo test --locked -p areal-engine --test goals` 验证普通 Turn 不续轮、两轮完成、CAS/幂等、预算耗尽与编辑、未知用量预留、暂停恢复、用户队列优先、子任务归因、容量等待、活动期限以及重启不重放。`cargo test --locked -p areal-engine goals::budget` 验证并发预留、嵌套 Workgroup 模型池、模型替换和 Summary 的单次计量。配置回归覆盖默认执行限制、TOML 覆盖与策略范围；Goal 行为测试使用默认 Limits。

`node examples/desktop-api/run.mjs goal-mode` 使用真实 Core/Runtime 与 HTTP/SSE fixture，通过生成 schema 验证 Goal API、两次 Turn 的文件创建/验证、隔离 Workgroup 共享计量、观察权限、重复请求、多客户端恢复和 headless 跨 Turn 等待；已纳入 `make examples-desktop-api`。它不替代真实模型的任务成功率评估。

## 共享本地服务

`make local-service-smoke` 使用临时目录、真实 Core/Runtime、两个 PTY 和 HTTP 模型 fixture，验证并发 ensure、工作区/符号链接身份、配置冲突、认证、Web 发现、窗口退出、忙碌拒绝停止/显式取消、历史保留、launcher/host 强杀清理与重新连接。已纳入 `make harness-smoke`。`make desktop-schemas` 同时导出 `schemas/local-service-v1.json`。

故障清理时，控制 socket 或 Core 的本机 HTTP 端点可先关闭而实例锁仍由清理进程持有；故障状态轮询只等待明确的连接拒绝过渡，仍须在原有期限内读到预期的 `stopped` 或 `unavailable`。其它错误立即失败，正常状态查询不放宽。`AREAL_TEST_EVIDENCE` 可指定 JSON 回执位置，记录阶段和状态轮询；CI 将其保存在 `target/ci/local-service.json`，失败时与日志一起上传。

`cargo test --locked -p areal-app-server --test browser_auth` 验证可信客户端到真实 HTTP/WebSocket 的自动登录、并发单次兑换、Origin 校验、实例隔离、权限继承、手动登录与会话到期断连；该 crate 单元测试使用虚拟时间检查登录码/会话过期和容量上限。`node --test scripts/web-progress.test.mjs` 检查兑换前清除 URL 片段、成功后连接、失败时手动登录兜底和普通刷新。

PTY helper 在等待 CLI、服务停止和窗口退出时持续消费终端输出，避免缓冲区背压阻塞 TUI。`make script-test` 包含退出前输出超过 PTY 容量的确定性回归。

TUI 与共享服务 PTY 检查共用终端画面解析器，处理增量重绘中保留的字符及分片 UTF-8/控制序列。模型热更新检查等待标题中的新模型名称，再确认服务 generation 未改变；不依赖原始输出字节或短暂状态通知。

`cargo test --locked -p areal-engine --test model_reload` 验证活动子任务和队列保持旧模型、新提交使用新默认值，以及忙碌 `ifIdle` 拒绝不关闭准入。本地服务 smoke 同时覆盖非法编辑、队列跨重启恢复、工作区定位和限额变化后的空闲重启。

## Task Mode 回归

`cargo test --locked -p areal-app-server --lib calendar_` 通过公开 Task dispatcher、Core 测试时钟和真实调度器核对 UTC 字面值、前五次持久 Run、Host 准备与模型观察、重启、夏令时、迟到边界和已受理计划。测试时钟只在 test-support 中可用，不是生产 RPC。GUI 日历路径使用 `AREAL_TASK_CALENDAR_REGRESSION=1 pnpm --dir clients/gui run test:task-conversation`，验证配置会话、Core 预览、错过窗口和保存后重开；本地确定性模型不代表真实供应商效果。

`AREAL_COMPAT_OLD_BIN=/absolute/v4/areal AREAL_CORE_BIN=/absolute/current/areal node examples/desktop-api/calendar-storage.mjs` 要求两个已确认身份的固定产物。它用旧二进制创建真实 v4 状态，通过当前 Core 的生产 WebSocket 路由验证迁移、只读 preview/context 权限、原收据和不可变引用，再确认旧二进制拒绝 v5 且不修改 Task 文件。脚本打印独立 Evidence 目录，保留根、收据、哈希、日志和进程停止结果；它不执行模型或 GUI，也不覆盖安装包升级。

`cargo test --locked -p areal-engine --test task_modes` 覆盖异步提问期间继续工作、独立回复与同 Run 恢复、单个问题过期时仍有其他待答问题的唤醒、headless 提问和审批、定时持久恢复、前台 Goal 异步提问、跨协调 Turn 的 worker 与共享预算、取消清理及重启回复去重。app-server 单元回归校验 Task 请求/响应/通知符合生成 schema，并验证 Thread 授权过滤与独立订阅/退订。

`node examples/desktop-api/schedule-host.mjs` 使用真实 Core/WS 与持久重启验证 Host 离线补执行、每轮新 Thread、受限身份与订阅的授权、准备失败后同 Run 继续、准备期间停止及旧 Host 迟到回复。`node clients/gui/scripts/schedule-desktop-smoke.mjs` 使用隔离 Electron/Core 和确定性本地模型验证对话创建、时区、新会话无历史、忙碌跳过、暂停和停止分离及普通审批 UI，保留截图与 JSON。设置 `AREAL_SCHEDULE_APPROVAL_EXPIRY=1` 会等待默认 300 秒期限，并验证 Turn 结算及同 Run 明确恢复后的新审批；未设置时不声称超时恢复通过。这些证据不替代真实供应商或安装包验收。

`node examples/desktop-api/run.mjs task-matrix` 使用真实二进制与 Runtime 检查 headless 普通对话/Goal 的提问与审批拒绝、允许的命令继续执行、无隐式定时调度、前台异步 Goal 断连后回复、定时触发与控制、独立 worker 文件产物及共享计量。`node --test scripts/web-progress.test.mjs` 检查等待状态、跨分页选中项、旧 revision 拒绝、Inbox 草稿保留和超时回复幂等重试。真实浏览器验收入口与操作见[桌面示例](../examples/desktop-api.md#web-validation)。

统一 CLI 的解析与配置进程回归位于 `clients/cli`，覆盖默认 TUI、exec、旧 -p、参数冲突和无副作用诊断。launcher 回归使用一个 areal fixture 分派 Core 与 TUI；桌面 CLI 验收同时运行 exec 和旧参数协议，发行搬迁验收检查 bin 只含 areal 且内部 Runtime 路径可用。

## 真实上下文连续性验证

构建后执行 `node scripts/context-live-smoke.mjs /absolute/model.toml`，显式选择真实模型配置，会产生模型用量。脚本创建独立工作区和状态目录，追加任务修订、三次压缩、重启 Core，然后以真实读写和命令完成 Goal；独立核验每个输出字段及已验收文件字节不变。JSON 报告记录缓存用量，不把未知用量当零。测试专用字节窗口可设 20,000、近期预算 4,096、`context_target_tokens=16000` 以触发压缩；不要把这些压力配置复制到生产。脚本不重启生产会话。 可追加第二个参数指定新的报告目录。报告分别记录 `functionalVerified`、有效模型摘要数和摘要失败；降级证据回退不能替代三次有效模型摘要，出现摘要失败时脚本非零退出。 可通过 `AREAL_CONTEXT_LIVE_BIN_DIR` 指定已冻结的二进制目录，确保重启使用同一候选版本。

工具慢时在日志过滤器启用 `areal::tool_timing=debug,areal::persistence=debug`。工具阶段区分意图持久化（含锁/clone）、执行、结果投影和最终提交；持久化区分编码、IO 准入、文件写入和 sync/rename。计时事件不增加参数、文件内容或凭据。一次编码仍保持执行前持久化和文件/目录同步顺序。

搜索回归直接运行 Runtime 文件助手，覆盖无宿主 rg/Python 的搜索、工作区 ignore、glob、上下文、截断与符号链接拒绝。原生和发行 smoke 通过 Core 的 `search_files` 验证完整调用链，不依赖 shell 中存在 rg。

桌面 soak 与 GUI 包校验接受不含独立 tools/rg 的内置搜索布局；soak 同时核对平台所需的 Runtime 组件及 manifest 文件摘要。

## Remote GUI 退出连续性

构建 Core 与 GUI 后，运行 `pnpm -C clients/gui test:remote-gui-quit`。可通过 `AREAL_CORE_BIN` 指定已构建的 Core；`AREAL_GUI_EXECUTABLE` 选择包内 Electron/Core，`AREAL_CHROME_EXECUTABLE` 选择本机 Chrome。此独立原生用例创建隔离目录和本地确定性模型，启动生产 GUI 及其独立后台适配器，经桌面界面配对 PWA Operator，在原始文件审批待处理时正常退出 GUI，再由 PWA 允许一次。它核对同一适配器 PID/身份、独占服务注册记录的 Core generation、原 Thread/Turn/交互、一次文件工具结果、持久 Remote 受理记录以及两个正常模型阶段；重新打开 GUI 不得增加模型请求。随后通过公开 `stopService` 和正常确认对话框验证停止意图、描述文件删除、PID 退出、Remote 断连及再次打开 GUI 不自动启动。

`node clients/gui/scripts/remote-gui-quit-e2e.mjs --self-test` 只检查确定性模型的两个阶段和拒绝条件，不加载 Electron、不启动网络，也不构成原生验收。原生运行需要操作系统安全存储可用；生产后台 `enableDirect` 失败返回退出码 2 和 `blocked`，不得替换 safeStorage。报告保存在独占 scratch 的 `report.json`；失败现场保留，若适配器仍存活，先核查并结算该隔离服务后显式停止。报告不包含服务凭据，不宣称精确 Core RPC 派发次数；不覆盖睡眠、手机真机、Relay、公网或发行安装验收。

## CI 门禁与冷启动

PR #111 在初始 G0 快照后整合历史恢复与定时任务所有权。以下六个存量文件上限按集成提交 `9297968c` 的实测值明确修订；指标方向、新文件 800 行上限和 CI 阻断继续生效。这些例外接受模块增长，不代表结构已经改善。

| 所有者 | 原行数 → 当前行数 | 原因 |
| --- | --- | --- |
| `app/src/core/backend.cjs` | 2270 → 2284 | 连接任务目录与定时 owner 生命周期 |
| `app/src/core/history-observation.cjs` | 1072 → 1175 | 协调有界历史读取、owner 任务与恢复 |
| `app/src/core/lifecycle-operations.cjs` | 845 → 878 | 持久化调度抑制并支持显式恢复 |
| `renderer/src/Composer.tsx` | 1564 → 1580 | 通过 owner 任务目录定位 worker 的原任务运行 |
| `renderer/src/Messages.tsx` | 1561 → 1718 | 加载早期历史时保持阅读锚点 |
| `renderer/src/TaskCenter.tsx` | 2356 → 2380 | 观察任务目录修订与共享 owner 激活 |

推送 GUI/Core 集成分支前，获取实际目标引用并准备锁定依赖，运行 `make check-changed CI_BASE=upstream-readonly/main`；按需使用 `make ci-preflight CI_BASE=upstream-readonly/main` 完整本机验收。共享计划包含适用的 Rust/SDK、schema、静态检查、生产构建与预算、Portable/Core 契约、原生与 Electron smoke。GUI 普通检查使用 Node 24.22.1；Relay 合同使用 Node 24.2.0，本机可通过 `AREAL_RELAY_NODE_BIN` 指定其可执行文件。完整本机验收执行当前平台全部适用项；快检仍列出未执行的完整验收项，Linux 容器和其他平台列为远端必需项，不计作本地通过。

快检只运行一套 Portable 生产构建和包体预算，Relay 与 macOS 的独立构建及原生 helper 留给完整验收。`mobile-types` 在快检执行；`mobile-browser` 与 Relay 安装在完整 `mobile` 组执行。GUI 主进程使用 Node 24.22.1，Relay 子进程通过 `AREAL_RELAY_NODE_BIN` 指定 Node 24.2.0，执行器将它传给夹具的 `AREAL_RELAY_NODE`。移动浏览器需要锁定 Playwright 的 Chromium 和 WebKit，Chrome 能力不代替这两项。类型失败不阻止独立浏览器场景收集结果。

`test:composer-files` 是文件引用的独立必需 smoke，保留普通 `test:composer` 的输入与 IME 检查。移动浏览器与文件专项都由同轮 `GUI gate` 校验，缺失结果、错误平台或旧 attempt 均失败。推送钩子固定执行参数，继承的 `ARGS=--plan` 不得跳过快检。

本机预检使用项目工具链：`export PATH="$PWD/.venv/bin:$PWD/.local/tools/node/bin:$PATH"`。Git 提交与推送 hook 自动按此顺序优先使用仓库内工具，无需先激活终端环境。Python 放在 `.venv`，Node 24.22.1 的官方发行包解压到 `.local/tools/node`（可执行文件为 `.local/tools/node/bin/node`）；这两个目录均被 Git 忽略。缺少仓库内工具时使用调用者的 PATH，版本不足仍由能力探针明确阻塞。能力探针要求 Python 至少 3.11，且具备 `tomllib` 和 tar 解包过滤；缺失时提前 blocked。Cargo 自身管理 verify/native 的可变构建目录与重建，产物哈希冻结限于发布给其他 job 的 GUI bundle；该 bundle 的消费者仍逐文件复核哈希。

本地与 CI 通过 `scripts/ci-preflight.py --groups <组名>` 执行同一计划，`--plan` 只展示。`make ci-gui-static CI_BASE=<ref>` 运行 Portable 的提交阶段，`make ci-gui-portable CI_BASE=<ref>` 运行完整 Portable 组，`make ci-core-contracts CI_BASE=<ref>` 连同产物依赖运行 Core 契约。`make ci-gui-health` 保留轻量健康入口。显式 `AREAL_CORE_BIN` 必须与刚构建的 Core 哈希一致；macOS 原生执行按固定产物路径流程准备。CI 只有同一 run/attempt 的产物依赖报告可跨 job 使用，消费者重新核对产物哈希。最终 gate 独立重算计划，严格核对结果全集、子测试全集和源码/计划/run/attempt 身份，缺项或意外 skip 拒绝放行。

`gui-health.mjs --check --base=<ref>` 会标记基线源码已存在的超限，仍以已审核的 `health-baseline.json` 判定失败。继承分类用于归因，不是自动豁免；显式例外与基准变更继续经过既有审查。模型菜单 smoke 通过稳定的 `composer-model-trigger` 打开入口，在对应服务商标签内选择原生 radio，并以选中模型和后续行为验证结果。

`Track red main` 工作流跟踪 main 上 `Verify` 和 `GUI checks` 的 push 结果。写 issue 前核对当前 main 提交、该 workflow 最新 run/attempt 及终态；过期通知与未完成的新 attempt 不修改告警。当前失败创建或更新对应 issue，当前成功关闭；仓库保护规则拥有必需检查设置。`python3 -m unittest scripts.tests.test_ci_contracts` 在 GitHub CLI 边界使用离线响应，覆盖乱序完成、旧 attempt、新运行未完成和 API 读取失败，测试不会写入真实 issue。

运行 `make hooks-install CI_BASE=upstream-readonly/main` 激活本地 hooks。安装器保存实际远程目标，不覆盖其他 hooks。提交钩子在暂存快照验证 manifest、生成 `target/ci/staged-plan.json`，再检查格式和 workflow；计划展示不等于执行验收。推送钩子要求推送 SHA 等于当前 HEAD、受控文件及非忽略未跟踪输入干净，抓取目标后运行受影响快检加失败专项和依赖。并发工作使用独立干净 worktree。`make workflow-lint` 使用校验 SHA-256 的 actionlint 1.7.12。远端独立执行适用检查；真实供应商、设备和签名安装包仍需专项验收。

`pnpm --dir clients/gui test:macos-dmg` 在 macOS 上独立通过真实 `codesign` 和 `hdiutil` 验证签名 framework 暂存。它需要允许磁盘映像设备访问的环境；受限 Agent 沙箱可能返回 `Device not configured`。应记录环境失败，并在允许的宿主环境重跑相同测试，不跳过断言，也不据此宣称安装包验收通过。macOS GUI job 显式执行该检查；可移植 `verify` 不创建磁盘映像。

GUI CI 只构建一次 Core 和 Renderer。构建 job 完成后，10 项原生 Core 合同与 GUI smoke 并行消费同一份产物，分别校验源码 SHA 和可执行组件；`GUI gate` 同时等待两组结果，失败、取消或意外跳过都不能通过。Core 合同的日志、报告和隔离临时目录单独归档。历史兼容、迁移、Composer、模型选择、队列、对话派生和 Side chat 按清单选择后拆成独立隔离的 matrix job（最多六个并发，`fail-fast: false`）。同轮 artifact 以 tar 保留可执行权限，并记录精确 checkout SHA；smoke 拒绝不匹配的源码。锁定的 pnpm/Electron/FFmpeg 下载使用缓存；构建成功即可保存构建缓存，不再因后续 smoke 失败丢失缓存。报告与跨 job 产物绑定 workflow attempt；需要重跑时执行完整 workflow，旧 attempt 的通过记录或产物不能满足新一轮门禁。缺失产物、失败、取消或意外跳过仍使 gate 失败，不使用 `continue-on-error`。

恢复去重的归属包含项目、聊天和 Core 连接代际；适配器重建后不能复用旧代际的完成/失败尝试。`thread-restoration-ui-smoke.mjs` 使用真实构建的 Renderer 及受控 Desktop 投影复现此边界，同时保持未知提交不重发。

明确拒绝的发送提示由 Composer 持有，并在后续受理后清除；全局提示继续保留真正的未确认或已受理结果。

对话派生 smoke 直接使用 `desktop-contract` 的命令校验和 read/mutation 语义，结合项目/聊天归属验证草稿带回期间的观察；不再维护另一份只读 RPC 白名单。保留全部原始命令及传输 mutation 标记，并继续核对模型请求数、Turn 数和工作区字节不变。

容量与取消夹具对刻意挂起的 SSE 流发送协议注释心跳，并在释放或断线时清理定时器；空闲超时测试仍保留无活动的流。

模型保留检查比较 Core 配置版本和选择的模型、参数、Profile、选项与 Skills，不再将包含派生元数据的整个有效快照序列化比较。smoke 为 Electron 退出设置期限；退出失败时只终止该 fixture 启动返回的子进程，保留测试失败，并继续按代际核对 Core 清理，避免 Node 一直等待到 job 超时。

`make test` 使用 Cargo `--no-fail-fast`，先收集 workspace 各测试目标的失败，再返回失败退出码；断言和 job 超时继续生效。大范围 Core/协议/存储集成仍需完成适用的 Rust 行为测试，由远端完整验收执行，也可使用 `ci-preflight` 提前在本机验证。可移植 CI 排除 `areal-runtime-exec-native`，专用 native/container 通道仍须通过。

`make script-test` 不要求产品二进制；`make launcher-test` 先构建整个 workspace，再执行真实 Rust launcher 回归。直接运行 launcher suite 时缺二进制是失败，不是 skip。`make verify` 包含两个入口。GUI 低成本隐私和 trajectory polling 回归通过 `pnpm --dir clients/gui test:regressions` 执行；`make gui-install` 同时准备 Electron 和 FFmpeg。

Verify 汇总要求 host、container 和独立依赖审计全部成功。GUI gate / Release gate 对每个 PR 运行：Release gate 检查本地打包契约，完整打包及发布由本地发行流程执行；GUI 路径判定明确不适用时才允许对应任务 skipped；失败、取消、意外 skip 均失败。建议将这三个汇总检查设为 required，取消把条件矩阵名称设为 required；需维护者另行确认并配置，本仓库不修改分支保护。

依赖审计独立扫描 Cargo、三个 npm 和 GUI pnpm 锁文件，区分漏洞命中与扫描错误，两者均失败。RustSec revision 与扫描报告保存 7 天；npm 实时数据库无不可变 revision。每周轻量独立审计从冷 cargo-audit 工具缓存安装；不运行每日完整 macOS/GUI。工具版本和锁文件指纹不包含凭据或环境变量。


## Codex 插件 P0

从仓库根先执行 `make build` 与 `make gui-build`。`node scripts/plugin-p0-smoke.mjs` 使用真实共享 Core、CLI、认证 RPC 与本地确定性模型，验证原包发现/安装、摘要变化拒绝、共享资源边界、范围/撤权、setup 去重、丢失响应收据查询和服务重启。`pnpm --dir clients/gui test:plugins` 在隔离 Electron/Core 数据目录中完成目录→安装→setup→打开对话→停用/启用→卸载；setup 响应在 Main 到 Renderer 边界注入丢失，恢复通过真实 Core 收据，不能重放。制品目录由脚本输出，清单包含二进制和变更源码摘要。

包与 Engine 集成：`cargo test --locked -p areal-plugins --test store -p areal-engine --test codex_plugins --test skills --test agents --test queue_transfer`。它们分别检查文件系统/安装事务与会话/Turn 权限和生命周期。上述检查不替代真实供应商、签名安装包、物理输入或跨平台验收，后续范围见[实施计划](codex-plugins-plan.md)。

安装与更新改动：`make script-test` 包含合成完整包的安装事务回归、独立 Git 仓库的来源门禁和无 Electron 依赖的 GUI 更新控制器回归。覆盖下载中断、摘要/版本错误、运行服务保持、入口提交失败、安装互斥、数据不变、原生准备超时与受理未知不重发；模拟传输错误不代表真实签名替换。本地发行验收另运行 `scripts/install-smoke.py` 的真实共享服务保持。正式相邻版本的签名替换、重开及数据保持仍使用隔离包副本的 `test:update` 与合成 `test:history-compat`，按发行影响执行；Gatekeeper、Finder 启动和真人权限不由单元测试代替。

网络回归同时覆盖 persistent 与 bounded 的摘要恢复、短暂断流后保留同一输入、五次上限不被通用响应恢复额度绕过、确认过的写操作只执行一次，以及显式关闭开关的独立配置和环境优先级。有限模式失败后保留全部已观测用量，不把达到重试上限视为成功。

## 仓库内 lint 规则

GUI 的仓库规则位于 `clients/gui/oxlint-plugin-areal`，由 `vite.config.mts` 的 lint.jsPlugins 加载。`pnpm --dir clients/gui check` 继续只检查本次改动文件；CI 或分支验收设置 `AREAL_CHECK_BASE=<base-sha>`。`check:all` 是显式全量检查，存量违规可能失败，不能据此批量豁免。

新增规则：在 rules/ 使用 @oxlint/plugins 的 defineRule，提供原因与替代写法，在 index.ts 注册，并在 vite.config.mts 指定严重度和适用路径。每条规则在 rules.test.ts 增加合法与违规源码，通过真实 oxlint 子进程验证规则名和退出码；运行 `pnpm --dir clients/gui test:unit oxlint-plugin-areal/rules.test.ts`。不引入 ESLint 运行时。豁免写同行 `-- 原因` 或紧邻上方的独立说明注释。

尺寸观察使用 `@areal/ui/observe-resize`，并将清理函数用于 effect 卸载。该工具拥有原生构造；增量门禁约束新增和修改的调用点，存量调用尚未批量迁移。运行 `pnpm --dir clients/gui test:resize-observer` 在隔离 Chrome 中对照原生回调与共享工具的提交时序，并验证 disconnect。该测试不证明所有布局抖动已修复。

无障碍专项只收集四条 JSX-a11y 规则，仓库插件诊断交由常规增量检查；两类检查分别执行，避免存量仓库规则混入无障碍基线。规则正反例和增量检查仍必须通过。
