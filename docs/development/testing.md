**中文** | [English](testing.en.md)

# 测试

共享失败采集 `captureSmokeFailure` 在清理前保存窗口状态、截图及脱敏的项目/执行代际、pending 方法、Turn 和队列状态；采集失败分别记入 `failure-state.json`，保留原断言错误。Side、Composer 与模型选择共用观察/诊断助手。smoke 的 manifest 顺序同时用于现有矩阵：先运行有失败记录的 Side、模型选择，其余按实测 job 耗时从长到短排列。排序参考 [CI 运行 43540581319](https://github.com/areal-project/AReaL-Harness/actions/runs/43540581319)：Side 314 秒、模型选择 230 秒且失败；其余为 Composer files 327、Composer 300、design 289、migration 240、reading 230、queue 148、browser navigation 134、derivation 129、history 128 秒。这是单轮调度样本，不是稳定性能基线；后续用现有 `ci-timing.py` 的原始数据更新顺序，不改变检查集合、并发上限或通过条件。

共享业务优先在 Web 与真实 Host 服务上用隔离数据验收，不以 GUI 打包为常规前置。窗口、系统加密、浏览器视图和电脑控制等 Electron 专属能力才启动桌面；发行资源、签名与升级仍在对应发行任务单独验证。协议测试、页面交互、原生与发行包证据分别记录，不互相替代。

共享 smoke 夹具位于 `clients/gui/scripts/support/`：`core-observation.mjs` 统一解析原 Thread 的执行工作区与服务代际，并校验返回的 Thread 身份；显式 worktree 与已有投影冲突时直接失败，尚未投影的 worktree 不借用父项目代际。`host-transport-barrier.mjs` 在 Host 传输边界控制本次请求与响应。注入须断言命中的请求 ID，权威结算与 UI 呈现分别验证；清理复用 `application-cleanup.mjs` 核对原 Host 停止回执及实际退出，保留原失败。`test:script-units` 验证夹具，`test:core-observation` 验证真实隔离 Core；`test:workbench-errors` 在 GUI 构建后验证后台进程和 Host 错误码映射，依赖均登记在 manifest。

工作台后台冒烟可按领域运行，例如 `pnpm --dir clients/gui test:workbench-backend --domain=providers`。支持 library、trajectory、feedback、tasks、manage、worktree、providers、lifecycle，可组合；省略参数运行完整链路。每次运行使用独立数据目录；停机任务目录和运行中任务管理分别初始化不同项目。开发时选择目标领域及受影响回归，收尾运行完整链路。协议冒烟不替代真实 Web 页面操作。

高频操作基线 `pnpm --dir clients/gui test:ux-journeys` 在真实 Electron、后台和 Core 上走三条旅程：没配模型时去配置、打开项目发消息并在审批中继续排队、右上角摘要。外部模型是脚本内的假模型。每步截图并做 6 项确定性检查（400ms 内有反馈、无原始错误、中文界面不混英文、浮层不互相遮挡、等审批时不显示“运行中”、用户没操作时不弹提示）；检查逻辑在 `scripts/ux-checks.mjs`，由 `test:ux-checks` 单测。修一个体验问题时，往这里加一条检查防止回退。

双产品对照复用同一合同的[六条基线旅程](conversation-reading-acceptance.md#双产品基线)与共享素材生成器。运行报告区分本轮实测、历史复用、源码推断和未验证，不以开发服务器启动代表用户路径通过。

桌面对话与 Composer 按[体验验收合同](conversation-reading-acceptance.md)先定义输入意图、上下文恢复、提交事实、完整性、可读时机和阅读位置标准，再设计过程与终态用例，随后进行设计、实现和统一验收。单条会话最终加载完整不能替代加载过程与交互检查。

Side Chat 的 Esc 回退测试等待任务资源外层弹层完全退出布局后，再验证主任务停止。内部 `Activity` 隐藏会早于 `keepMounted` 弹层关闭动画完成；动画期间仍应保护主任务。测试显式拉长该动画并记录弹层状态，覆盖两种主/侧任务启动顺序，不用固定 sleep 或重复发送 Esc 掩盖竞态。

模型计量观察器的非干扰测试在磁盘写入仍被阻塞时等待 `drained` 结算信号，再在观察器锁内检查内存账本。客户端收到 HTTP EOF 不代表服务端 `finally` 已完成；不能用延长 sleep 或提前释放磁盘阻塞替代这个先后关系。

发行验收的本地模型将辅助会话标题与求解请求分开处理。主任务退出可取消尚未完成的命名请求，此时命名回包的 BrokenPipe/ConnectionReset 不应把成功的读写验收改判失败；求解回包中断、命名携带工具或其他协议错误仍失败。`scripts/fixture_session_title.py` 仅用于本地 fixture，不改变生产重试、超时或模型消费。

依赖安装见[开发指南](README.md)。常规测试使用临时目录、动态 loopback 端口和确定性模型，无需真实模型凭据。

MCP 隔离回归用 `gated-startup` 夹具显式阻塞 A 的初始化，验证 B 完成控制操作后 A 仍未结束，再放行 A；不以 300ms 内完成磁盘写入作为隔离判据。研究等待容量回归通过结束被等待的子任务收尾，避免把已派发工具取消后的合法 UNKNOWN 当作测试失败。大历史回归保留 140 次操作、超过 2 MiB 历史及重启后续轮的断言，180 秒仅为测试死锁上限，不是产品时延门槛。

模型选择 smoke 以夹具明确配置的思考档位为预期：四档、二档与空列表分别验证选项、滑块边界、键盘/拖动、历史无效值修正和服务默认；Fast 的请求与冷重开断言使用同一受限档位配置。供应商目录读取可能结算待应用配置，保存种子前的空闲检查放在目录读取之后。空目录场景的管理命令在离开设置页后执行，避免设置页的目录刷新与夹具写入竞争；真实用户的单次保存、应用回执和草稿保护断言保持不变。

浏览器终态结果、Worktree 与定时任务合同通过现有 `history.loadItem` 读取成功工具的延期原文，再核对真实执行结果与所属目录中的落盘文件；不能把对话摘要缺少原文判为工具未执行，也不能仅凭摘要宣称执行成功。迁移 smoke 通过当前工具摘要的展开控件查看结果，保留子对话与主草稿隔离断言。

工具事实验收使用 `scripts/support/tool-history.mjs`：只对目标 Turn 的延期工具记录 acquire/loadItem，再按原 Turn/item 身份重读快照，最后释放临时 view。原文已内联时沿用完整历史兼容路径；failed、interrupted 与 UNKNOWN 的原断言不变。读取失败或身份变化直接失败，不自动重试或跳过。界面展示验收继续通过可见摘要展开控件验证加载；RPC 协议验收直接检查正式响应、错误分类、通知、线程及请求收据。缺失 Profile 与缺失 provider 同时出现时先验证 Profile 解析错误，避免默认模型配置掩盖资源引用契约。

新的 history view 在 acquire 时若发现既有窗口已失效，只重建一次基线后按原预算补全；已有 view 的重复注册不触发恢复循环。恢复等待前固定原连接身份与代际；同一连接可生成新窗口，等待期间的新连接不能接管旧请求。读取期间窗口再次换代、失效或本次 view 被释放仍返回真实失败，即使其他 view 存活。并发读取者共享补全，关闭一个读取者只拒绝其自身 acquire，不取消其他仍存活的 view。

调度候选通过 GUI 的 `workflow_dispatch` 输入 `smoke_parallel` 显式比较 4/5；默认值和普通 PR/main 固定为 4，不自动提高共享资源占用。该开关只改变 smoke 矩阵上限，不改变测试、门禁、超时或真实产物依赖。完成同一成功 ref/SHA 的缓存预热后，以同一个 `comparison_base` 和 `qualification=none` 串行运行两个值，记录真实缓存命中、同期工作流、首次失败反馈、总反馈和累计 runner 时间；若有 main 等待或重叠运行，应先结束本次对照再比较。矩阵与共享池空档不能据 created→started 自动解释为容量不足；排序或五并发仅是待证伪候选，不宣称能消除长等待。
Worktree 集成夹具将自动命名响应保持到真实文件工具完成后，确认命名已进入观察状态，再重新打开会话并租用历史视图，避免把合法的命名编辑误判为工具失败。文件、Shell、受管进程、目录隔离与重启断言保持不变。

Side Chat parity 的 P4 使用真实 Shift/方向键与 Enter，读取选区矩形并确认选中文字仍在对话视口内，再执行引用操作；旧阅读锚点不能抢回原生键盘移动后的视口。数量、字数限制、冻结的引用正文及不自动提交断言继续由原场景检查。

模型选择专项在模型回合断言之后，先观察公开的 serviceStatus.canStop，确认后台命令、启动、模型配置更新和资源均已结算，再通过原生菜单发起一次退出；真实退出仍受原有 15 秒断言约束。退出失败时复用已有清理器，只回收本次启动的 Electron 子进程，保留失败与现场，避免存活进程把一次清理失败拖到整个 CI job 超时。

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

`scripts/shared-host-update-smoke.mjs` 的 `cancel-confirmed` 模式要求 `<prefix>/lib/areal/0.1.8-macos-arm64` 与 `0.1.9-macos-arm64` 两份实际构建的不可变完整 bundle，并包含发行格式的 manifest 与 inventory；稳定入口为 `<prefix>/bin/areal`。同一 prefix 串行使用，运行前确认没有活跃 owner。运行 `AREAL_UPDATE_PREFIX=/absolute/prefix AREAL_UPDATE_CASE=cancel-confirmed node scripts/shared-host-update-smoke.mjs`，在隔离 home 和 Store 中用真实 Core 与确定性本地模型验证未确认取消被拒绝、显式确认取消原活动 Turn、原升级回执结算，以及新版本 Core 保留原历史。程序输出隔离目录中的 `result.json`，记录真实产物身份、命令回执、模型尝试和清理；该模式不注册系统服务，不代表 GUI、真实供应商或签名包验收。

macOS 原生 smoke 需要 Seatbelt，Linux 原生 smoke 需要 `/usr/bin/bwrap` 和 user namespace；两者都不能在能力缺失时回退到无沙箱执行。`outer-container-perf` 仍在受控容器中验证。默认 `cargo test` 不运行显式忽略的原生 Workgroup 和容量用例。

Linux 宿主常规检查使用 `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`。原生后端测试要求 `/usr/bin/bwrap` 和 user namespace；CI 的独立任务构建 Dockerfile 的 `runtime-tests` 目标，在带 Bubblewrap 的受控容器中实际运行包含 `outer-container-perf` 的全部后端测试，并启用 `areal-runtime/native-tests` 运行 daemon 的 `native_transport` 目标。该目标经私有 stdio 启动真实 daemon 和完整 Runtime bundle，使 Linux 在 daemon 旁找到 reaper；原生沙箱用例保留普通命令/Hook 并发进展和外部 writer 排他断言，四个 portable transport 用例仍属于默认测试。`make verify-native` 先构建 bundle，再在 macOS 显式运行同一原生目标。该 feature 仅选择测试目标，不改变生产行为；不能只排除 portable 宿主的原生测试就视为完成验收。

在 Cargo 测试进程内嵌入 Runtime 的集成用例，需要同版本 reaper 位于测试宿主旁的 `target/<profile>/deps/`。`runtime-tests` 镜像单独安装并检查该产物，保留前层测试编译缓存。离线 CI 合同执行真实安装命令，验证位置、字节和可执行权限；编译器与包管理器使用边界 fixture，此检查不替代 Linux 原生容器验收。

原生 Side 验收还在运行时通过 `CARGO_MANIFEST_DIR` 启动 MCP fixture。镜像必须复制该文件到对应源码路径；离线合同从测试源码提取路径并核对镜像的 COPY 映射，Docker 构建再检查文件可读性。编译通过不能证明运行时 fixture 已随镜像交付。

截图 IPC 的注册与窗口归属复核由 `app/src/core/snapshots/host.cjs` 负责；健康检查只统计受控源码，不重复统计其 `snapshots/build/` 生成包。GUI 类型检查先生成截图原生模块，支持干净 checkout。Cloud 上传回归打包真实 Composer 上传与状态模块，保留部分批次失败后复用已接收回执的断言。

图表文件预览通过动态导入复用消息图表组件，Mermaid 不进入首屏静态依赖。PDF 预览及独立 worker 按新增模块实测值加 5% 计入总量预算；新增 PDF 和图表懒加载 chunk、重分块后的 KaTeX、截图桌面契约及共享 Remote 入口分别登记有界预算。`index.html` 首屏上限与所有首屏禁载模块继续由原预算检查约束；预算变更须在 PR 中列明来源供审查。

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
pnpm --dir clients/gui test:conversation-reading
```

PR 工作流按 PR 编号取消旧运行；Verify/GUI 的 main 与手动运行按 run ID 独立分组，避免共享并发组替换等待中的 main 提交。纯说明文档保留轻量格式、合同和链接门禁，不下载 Cargo 依赖或恢复 Rust 构建缓存，也不运行依赖审计；内置 Skill Markdown 等产品输入仍按代码处理。工作流本身不使用 paths 跳过必需检查，最终门禁继续验证明确的不适用结果。Linux GUI 安装使用 setup-node 的 pnpm store 缓存，Relay 使用独立 Node 版本和 npm 锁文件缓存；依赖审计下载固定版本与 SHA-256 校验的官方 cargo-audit 二进制。

GUI 的产物 job 完成必要构建与 RPC 校验后即可发布同一源码的输入包；Core 合同按 manifest 稳定分成两片，独立原生/设计校验复用第二个分片的准备，保留单独的执行步骤与结果目录，合同失败后仍继续收集。两条 lane 共用同一 run/attempt 的依赖报告，各自产生唯一结果；原有 `macOS Core contracts` 检查名作为严格汇总保留。桌面模块、截图模块和既有 Core/renderer/原生 helper 产物一起冻结，消费者不再重复 `build:desktop`。最终门禁仍核对检查 ID、子测试全集、平台、源码、计划、run 和 attempt，拒绝漏项、重复、失败或过期输入。

容器使用固定版本和摘要的官方 cargo-chef 二进制，从清单与锁文件生成依赖配方；依赖编译层位于真实源码 COPY 之前。源码变动只重建工作区代码；新增 target、清单或锁文件变化仍会更新配方。运行镜像仅导出最终层缓存，测试镜像保留完整构建层，避免两套完整依赖缓存重复占用空间。测试目标只导入自己的完整缓存图，作为隔离最终镜像 min 图与测试构建图的候选措施。本地 OCI 缓存/native snapshotter 的结构实验支持这一选择；托管 GHA 缓存/overlayfs 仍待验证，尚未证明线上缓存失效的根因或耗时收益。macOS 原生与 GUI 构建共用同一环境键的 Rust 依赖缓存。macOS 私有 Bash 只缓存当前身份目录；锁文件、构建脚本、架构、编译器、SDK、系统或 runner 镜像变化都会换键。恢复后仍核对二进制、对应源码包与许可证摘要，不保存其他身份或下载目录。验收结果及失败报告从不作为缓存通过证据。

用 `python3 scripts/ci-timing.py --collect areal-project/AReaL-Harness --limit 50 --output target/ci/timing` 保存 gh 原始数据并生成逐 job/step CSV；离线重放使用 `--input <snapshot.json>`。采集最近 50 个 run 的全部 attempt，逐轮读取对应 jobs；分析使用各轮 run_started_at，避免把重跑前的等待或前一轮 runner minutes 计入本轮。分析保留取消、失败、重跑 attempt 和 runner 信息；依赖等待只作估计；`post_dependency_delay_estimate_s` 是从 job 创建与估计依赖完成两者较晚时刻到启动的调度等待，可能包含矩阵限流、调度器、共享配额和 runner 准备。API 无法分离真实机器排队，旧 `runner_wait_lower_bound_s` 字段保留为 null，不能据此诊断容量不足。`first_failure_feedback_s` 使用实际失败 step 的结束时间，并记录其准备/验收/混合阶段；单测输出的模拟失败记录不计入。包含安装/编译的复合 step 独立列为 mixed，不能全算测试耗时。缺少日志或子报告时缓存冷热及精确测试拆分保持 unknown；只比较覆盖相同的成功运行，并同时查看墙钟关键路径和累计 runner minutes。

`scripts/ci-scope.py` 是本地与 CI 共用的检查计划所有者；`check-changed` 解析一次 merge-base，合并暂存、未暂存与未跟踪路径，重命名两侧均纳入，部分暂存相互抵消也保留选检。计划登记命令、依赖、环境能力、平台和 manifest 子测试全集，并绑定 base/source/head 与输入摘要。共享 Rust、schema、锁文件、构建与 CI 变化扩大范围，未知代码保守扩大；比较基准不可用时不得放行。

`check-changed` 默认运行计划的 `commit` 阶段，加上历史报告中尚未通过的项目及其依赖；`ARGS=--phase=full` 执行完整计划。推送钩子固定选择 `push` 阶段：运行适用的快速结构与静态检查及其构建依赖，完整调度器单测、慢套件和历史失败专项留在默认或完整入口与远端 CI。Clippy 已包含同范围 Rust 类型编译，推送阶段只运行其中的 lint 检查。未选项继续列为 pending，不代表通过。命令读取 `working-tree`，暂存内容影响选检和漂移检测；快检不证明部分暂存内容已执行验收。报告将未选的完整验收列为 `pendingRequired`，其他平台列为 `remoteRequired`。`passed` 只表示本轮所选项通过，`blocked`、`invalidated`、`failed` 均不得作为通过。

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

`test:conversation-reading` 使用生产 Messages、Desktop 历史窗口与确定性 Core RPC fixture，组合验证旧页淘汰、离开返回、重观察、后台增量、宽度变化和 Renderer 重载。该短场景登记为常规 ciSmoke；它不启动真实 Core 或 Electron，不证明供应商、安装包或物理输入验收。历史窗口的多视图保护、有限扫描、取消及预算失败由 bounded-history-client 行为检查覆盖。

`node clients/gui/scripts/bounded-history-ui-smoke.mjs` 在生产 Renderer 和 Desktop 历史所有者上使用受控 Core 响应。上滑分页应静默加载；场景在请求挂起时检查无分页加载文字，完成后检查旧消息出现，并验证正文与输入框位置、失败重试，以及读取期间上滑只续读一次、向下取消续读。场景延迟滚动后的动画帧，在该帧前合入历史页，验证同一可见段落的偏移不超过 2 像素；另检查 30 轮完整快照的上下滚轮浏览，以及超过 16 页后的淘汰和缺页重读。`AREAL_HISTORY_UI_LOCALE=en` 可复验英文。该场景不代表真实 Core 或安装包验收。

`test:navigation-cache` 使用生产 React App、真实 Chrome 和 fixture PlatformServices，记录无关 UI 操作的派生计算次数，检查名称、未读、运行、排序和新快照刷新，并保存源码身份及截图。它不启动 Core/Electron，也不验证安装包或感知延迟。`readingViews` 单测覆盖 32 项内存边界、最近访问淘汰、存储不可用和语义锚点重载；真实主题与布局连续性仍需 Renderer 场景。旧 `conversation-flow` 场景在 `.tool-summary-row .tool-failed` 定位器超时；生产折叠失败状态由 `ActivityRowStatus` 的 `data-tone="failed"` 表达。该 markup 与 `readingViews` 容量裁剪属于不同边界，本专项未修改旧 runner，完整对话流未计为通过。

Linux 移动浏览器 job 安装依赖前，将托管 runner 的 Ubuntu mirror list 指向官方 HTTPS archive。发行版、组件、APT 签名校验、锁定 Playwright 的完整依赖与两种浏览器保持原样；下载超时仍属于 CI 安装失败，不计作浏览器测试通过。

对话流设计验收先等待活动面板的展开过渡结束，并确认列表中心是实际鼠标命中区域，再发送一次真实滚轮输入。`conversation-wheel.json` 保留可信输入、命中和滚动前后位置；仍要求该列表真实滚动，不用脚本改滚动位置替代滚轮断言。

## 本地验证产物与启动诊断

`make build` / `make release` 在 Cargo 成功后写入 `target/<profile>/verification-build.json`，绑定现有 Core `inputHash`、构建提交和整套 Core/Runtime 的 SHA-256。GUI 构建沿用 bundle 分析插件，在 `renderer/dist/verification-build.json` 中记录 GUI 输入摘要与输出文件哈希；构建期间源码改变则失败。

从仓库根将同批产物部署到独立固定槽，随后诊断：

```sh
python3 scripts/verification.py deploy --source-dir "$PWD/target/debug" --bin-dir "$PWD/.local/dev-bin/verification" --evidence "$PWD/.scratch/verification/deployment.json"
make gui-build
python3 scripts/verification.py doctor --core "$PWD/.local/dev-bin/verification/areal" --report "$PWD/.scratch/verification/startup-1.json"
```

部署复用现有进程/打开文件检查，拒绝占用中、缺组件或构建后被改写的产物。验证助手在整轮测试期间持有同槽 `.verification-lock`，部署也使用此锁；锁不自动过期。异常退出后先读取 `owner.json`、确认进程和本轮服务已停止，再处理残留锁。原本机固定路径部署与 doctor 入口调用这些受控实现，不能以测试目录隔离代替构建身份核验。直接 `cargo build` 不产生同批回执，应使用 `make build`。

macOS 固定产物还包含 `shells/bash`、`shells/sh`、构建元数据、GPL 许可与对应源码包。构建回执沿发行打包校验私有 shell 来源并记录全部文件的 SHA256；部署在同一槽锁内复制，doctor 核对文件完整性。缺少或篡改这些文件会拒绝验证，Runtime 不回退到系统 Bash。Linux 保持原有 Runtime 与 reaper 闭包。

doctor 在启动 Electron 前检查 Core 内嵌输入身份、整套组件哈希、Renderer 源码和输出哈希。报告包含三个程序的路径、SHA、探测命令、退出码或信号，以及 macOS 签名检查；任一失败仍保留其余探测，返回非零。每次使用新的报告文件，已有报告拒绝覆盖。文件助手无请求探测只验证启动，不执行文件操作。退出 0 和签名有效均不证明人工授权；`authorization` 默认 `unknown`，人工实际观察后可用 `--authorization-observation areal=allowed` 等逐组件记录。SIGKILL 只记为信号，不能自动归因为防护拦截。报告不替代真实 Runtime、供应商或安装包验收。

doctor 也接受安装器版本目录的 `bin/areal`：先复用安装器校验 manifest 与完整文件清单，再从同一 bundle 的 `libexec/areal` 探测 Runtime，核对 manifest、实际 Core 版本、内嵌输入与当前源码及 Renderer。它不往 bundle 写入固定槽回执或锁；版本化产物仍保持原清单。这个入口用于源码 GUI 的受控升级验收，不替代签名安装包或系统授权验收。

浏览器静态验收通过现有 `verification.py` 从匹配当前 GUI 输入的构建创建独立副本：

```sh
python3 scripts/verification.py snapshot-renderer --source-dir "$PWD/clients/gui/renderer/dist" --output-dir "$PWD/.scratch/verification/renderer-1"
pnpm --dir clients/gui test:history-navigation-ui
```

输出目录必须尚不存在；复制前后核对构建回执、源码摘要和每个输出文件，全部成功后才发布副本回执。后续共享 `renderer/dist` 重建不会改变已复制产物。回执保留源码提交、输入摘要、原构建路径和副本文件哈希，证明的是本轮产物，不代表后来源码通过。工作区选择和终验期间的构建顺序遵循[并行修改与终验](README.md#并行修改与终验)。

历史导航 runner 自动调用该入口，只服务本轮静态副本；设置 `AREAL_RENDERER_DIST` 仍要求其回执匹配当前源码。`renderer/test-fixtures/history-navigation.ts` 直接实现生产 `DesktopBridge`，随 Renderer 类型检查；删掉 `onPreviewEvent` 或 `onUpdate` 会在启动浏览器前失败。runner 以现有 Vite 构建该夹具并核对与 Renderer 相同的输入摘要，保留真实桌面适配器和投影读取路径。检查覆盖鼠标与键盘历史导航、冷项目切换、UNKNOWN 原请求保留和零提交；边界是 Chrome + Renderer + bridge 夹具，不覆盖 Electron/Core。

任务目录 smoke 的页面夹具位于 `clients/gui/renderer/test-fixtures/scheduled-workspace.tsx`，与 Renderer 一起类型检查，并由原浏览器 runner 直接加载。它验证新意图经 `onStartDraft` 打开草稿、项目默认值及旧请求的显式核对与被动回执；夹具仅替换 IPC 边界。

CI smoke 执行器与共享源码 Electron fixture 在产品场景启动前自动运行此 doctor，每次尝试保留独立启动报告；CI 随二进制传递 Core 构建回执。身份或探测失败即阻止场景启动，不计为场景通过。评审证据绑定源码提交与相关文件哈希，无关 HEAD 移动本身不使这些哈希失效。

`pnpm --dir clients/gui verify` 在执行契约和测试前运行 `pnpm health`，直接检查生产源码相对已审核基线的健康预算。`test:health` 验证检查器自身，不能替代该门禁；健康失败会使 `verify` 返回非零。完整受影响检查、构建体积与平台验收仍由既有 CI 计划执行。

## 验收用例：文件夹中的三张图片

在隔离桌面实例中使用支持视觉输入的模型和工作区外的本机文件夹。文件夹包含三张内容不同的 PNG/JPEG 图片，使用不透露内容的文件名。通过 Composer 拖入或粘贴文件夹引用，发送“这个文件夹里的三张图片分别是什么内容？”。

成功条件是目录接收、列举和三个原图读取成功；只读操作经过当前权限模式的审批，Scope 不增加写入或网络权限；模型请求实际包含三个对应图片载荷，最终回答逐张描述并与图片内容一致。仅返回文件名、复制成功、OCR 文本或本地脚本模型的固定回答均不足以证明视觉识别。另在后续轮次不带追加权限读取同一外部目录，验证本次操作授权没有改变基础 Scope。

可重复的确定性桌面入口为 `pnpm --dir clients/gui test:composer-folder-vision`，使用匹配当前源码的 `AREAL_CORE_BIN` 和已构建的 GUI。它复用 Composer runner，在工作区外创建三张无语义文件名的不同 PNG，经目录拖入、四次“允许一次”、真实 Runtime 读取与媒体投影，核对模型收到与三个原图逐一对应的 Core 图片载荷，并确认后续未申请追加权限的读取被拒绝。原生项目选择器返回值是注入边界；目录拖入使用 CDP 合成事件，模型仅在本地确定性边界替换。

证据目录的 `folder-vision-evidence.json` 按阶段记录目录接收、Runtime 读取、模型载荷和 `visualRecognition: not_run`；同目录保留 `manifest.json`、`model-requests.json`、`authoritative-history.json` 与审批截图。`test:composer-folder-vision-contract` 检查证据断言会拒绝缺图、重复图、失败工具和扩大权限。这些通过结果只证明目录到模型输入的链路；真实视觉识别仍须按上述完整成功条件，以已授权的视觉模型逐张核对最终回答，不能把确定性模型输出计为识别通过。

工具契约回归为 `cargo test -p areal-engine --lib read_tools_request_only_additional_read_roots` 和 `cargo test -p areal-engine --lib read_permission_admission_rejects_write_and_network_fields`。零写/禁网下真实文本读取和搜索回归为 `AREAL_TEST_BIN_DIR=/absolute/verified/bundle cargo test -p areal-engine --features native-tests --lib read_helpers_work_without_write_or_network_permissions`。这些回归不替代真实桌面媒体链和真实视觉模型验收；保存源码与产物身份、审批 Scope、工具媒体摘要、模型图片摘要及最终回答，凭据不进入证据。

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

临时目录统一使用 `scripts/support/temp.mjs` 的 `makeTempDir(prefix)`。它对 `os.tmpdir()` 做 `realpath`，保留 macOS 路径比较语义。`verify:tests` 通过 AST 检查所有登记脚本及本地导入，拒绝实际路径字面量 `/private/tmp` 和 `/var/folders`。审计规则及负例中的字符串不构成临时目录创建。需要固定前缀（如 `/tmp` 短路径）时改用 `support/host-cleanup.cjs` 的 `trackedMkdtemp`，不直接调 `mkdtemp`：CLI 自动拉起的 Host 脱离了测试进程组，只有登记过的临时目录会在测试退出或 Ctrl-C 时被 `host stop`，否则每次运行都会在机器上留下一套 Host、Core 与 Runtime。

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

`pnpm --dir clients/gui test:service-connection` 区分当前应用的 Main 连接与发现的旧 Desktop。当前应用夹具经 `initialize` 和 `connectMain` 进入生产连接边界，每次连接建立独立传输，覆盖原请求身份、丢失回复、停止及重连失败后的回执核查；外来后台经真实 WebSocket `attach` 观察，并验证命令被拒绝且不会自动接管。生命周期兼容夹具提供旧 Desktop 回执，不能替代真实 Host 升级、服务注册或 GUI 验收。

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

丢失发送响应的验收以本次请求的回执和消息为完成条件，不能借用上一轮的完成状态。使用屏障保留核对与发送并行的顺序，并在同一挂载的编辑器中核对正文、附件和草稿存储一致结算；短暂显示为空不代表恢复完成。阅读恢复验收先确认历史加载、焦点和真实阅读输入已生效，再建立目标几何位置并核对保存的 item、block 和 offset。

阅读取消验收用一次性屏障控制旧恢复请求，先确认用户新意图的 retain 已受理，再释放并等待原 ensureAnchor 的取消回执。滚轮触发的前文加载可以改变绝对 `scrollTop`；验收比较同一可见 item、block、正文及视口偏移，而不是以单次 RPC 的 pending 计数或绝对滚动坐标判断整次恢复完成。

Composer smoke 通过 Side 标签的 Delete 键关闭已完成的阅读视图，并等待主编辑器可见，覆盖窄窗完整视图和宽窗分屏；窄窗的面板按钮仅切换视图。模型选择 smoke 在冷重启后的配置应用前，读取真实 `serviceStatus`，等待任务、操作、项目启动和配置更新全部结算后单次提交。

Slash 键盘验收等待本次打开触发的 Core 目录刷新完成，再核对方向键移动到的具体选项及编辑器 `aria-activedescendant` 一致后按 Enter；原选项的已选中状态不能证明方向键已经生效。

原生工具 smoke 在断言前等待 HTTP fixture 的请求线程全部结束。主求解请求与完成审计严格等量；单次辅助命名允许在 HTTP 抵达前取消，此时只接受无 HTTP 状态的中断审计。已观测请求缺审计、重复命名、未观测却完成以及命名携带工具均失败。

Runtime 输出验收分页收齐超出热窗口的全部原文，并独立检查显式输出额度超限。Harness 的转义密集输出验收通过 `read_tool_result` 续读预览省略的快照，逐字核对 stdout/stderr、终态与页大小；验证命令同时核对有界尾部和保存的完整日志。恢复与重试测试按 `kind=discardedCompletion` 选择审计，不能把上下文预算等诊断记录计作丢弃响应。

`node --test clients/gui/scripts/browser-diagnostics-contract.test.cjs` 覆盖原生关闭的资源所有权和错误边界：先释放后 dispose/profile quiesce、输入与录制收敛、旧 Page 重建、隔离动作超时及迟到销毁。它用受控事件检验等待条件，不证明真实 DOM、窗口焦点或 SELECT popup。后者须用隔离 Electron 核对活动 open SELECT 的关闭、无窗口聚焦、真实 `destroyed` 与自然退出；保留原 10 秒原生关闭和 20 秒 runner 清理期限，强杀仍计失败。

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

CI 失败先按“证据 → 操作身份与状态所有者 → 可控反例 → 修复 → 同版本验收”推进。同类失败再次出现，或本地通过而 CI 失败时，下一轮修改前重新审查整条因果路径，不能以局部补丁和无新信息重跑代替诊断。

1. 汇总同一版本的失败项，区分产品缺陷、测试缺陷、环境阻塞和契约问题。保留 PR head、CI 实际 checkout/merge revision、产物身份、工具版本和首跑日志；核实差异后再判断环境原因。
2. 沿本次请求记录权威受理、回执、投影、存储和界面终态的所有者及完成信号。异步断言绑定 `requestId`、目标和执行 Core 代次，历史视图绑定 `viewId/revision`；上一轮完成、发送计数或单次 RPC 的 pending 清零不能代替本次操作完成。
3. 用一次性屏障固定已观察的并发顺序，确认暂停位置及原请求身份后才执行竞争动作。保持原挂载实例和连接生命周期；新增导航、重挂载或移动暂停阶段作为另一用例记录。释放后等待对应响应及 Renderer 投影，失败清理也释放屏障。
4. 夹具复用真实状态所有者的订阅、登记、取消和释放逻辑。简化传输仍需显式连接身份，覆盖刷新、连接重叠及关闭后的迟到 acquire。同一所有者先结算其状态与存储，再通知同步消费者；验收同时检查通知时状态和结算后的正文、附件及界面。
5. 对产品缺陷保留同一反例的修复前红灯和修复后绿灯；对测试缺陷记录前置或断言与契约不符的证据。断言用户可观察结果，允许契约内的空值表示或历史前插坐标变化，继续拒绝内容复活、错误目标结算和可见锚点偏移。未复现时记录未知并补有界观测，不以重跑通过宣称根因已修。

每次诊断运行应区分一个明确假设。候选原因仍无法区分或补丁开始跨模块扩散时，先进行针对性的所有权与设计审查。复用现有日志、状态和 trace；不要求新增统一诊断平台。修复完成后检查 owned diff、运行受影响测试及必需门禁，按最终源码版本核对远端状态；本地快检通过只证明其已执行范围，条件跳过单独列出。

Side Chat 引用烟测等待选区弹层完成入场过渡后再操作；键盘选区使用真实 Shift 扩展和 Enter，其他引用使用鼠标点击，保留内容、去重和容量边界断言。manifest 记录引用长度、目标和操作阶段。浏览器导航烟测被动保存原生快捷键及最近 128 个 Main 页面回执；这些记录不改变页面返回顺序，不将未复现的 CI 失败声明为已修复。

选区夹具在脚本定位后发出 pointerdown，先由既有阅读所有者确认当前位置，再建立可见的原生 Range；激活前保存按钮与视口几何。队列烟测对 snapshot/command 和退出使用既有期限，Main 的 `uncaughtExceptionMonitor` 只落盘错误栈，不吞异常；任何异常或清理失败仍使验收失败。 Hook 崩溃夹具先完成副作用计数，再发布进程就绪 PID；测试读到就绪信号后仍核对恰好一次副作用，并在重启后确认 UNKNOWN 与禁止重放。

macOS 与 Linux 宿主检查使用同一矩阵定义，`fail-fast: false` 保证任一平台失败不取消另一平台的覆盖。macOS 使用 `make setup-node`，仅安装原生 smoke 和 SDK 所需的 Node 依赖；Linux `make setup` 继续安装全部锁定格式工具。原生验收在同一次子 Make 调用中运行 Runtime、Harness、桌面 API 和 Workgroup smoke，共用一次 workspace build。Docker 只复制所需 CLI/TUI/Web 客户端，GUI 不进入构建上下文。原生 Runtime 和 Harness 覆盖保持不变。

`harness-smoke.mjs` 通过真实 Core/Runtime 和模型请求检查根/嵌套 `AGENTS.md` 与 `AGENTS.override.md` 的单层替换、空白回退、顺序、无关目录隔离、缺失文件、跨 Turn 刷新、32 KiB 边界、UTF-8 和符号链接拒绝。

对话流预览的图片可用性验收等待不可用提示实际出现，再操作展开按钮；恢复可用后等待提示消失并核对收起状态，避免把选择框事件派发完成当作组件状态已提交。

同一脚本还在没有 `AGENTS.md` 预读取的工作区，将首次模型回复延迟到超过 2 秒的单进程期限，再通过真实 Runtime 创建并读回文件；反例在相同模型等待后实际执行命令，确认其显式 200 毫秒期限仍终止进程并完成清理。它验证模型等待不侵占工具进程额度，不提高产品默认预算，也不证明长任务整体收益。

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

### A0 协议契约

`python3 scripts/generate-host-protocol.py --check` 比较 schema 生成的 Rust 与 TypeScript 类型，并核对本机、Gateway 和回环方法清单。A0 不接入生产代码；A1 的握手与票据边界开始使用生成类型。现有消息封装与提案分开；结构类型不替代字节预算、授权及可变归属检查。

`make host-protocol-check` 检查生成物、生成器回归和桌面 IPC 冻结反例，并运行需要 GUI 依赖的两条用例（生成的 TypeScript 声明、Host 经工作台后台冻结上下文），所以要先装 `clients/gui` 的依赖。CI 还以 PR 基线的完整提交 SHA 运行 `node clients/gui/scripts/check-desktop-ipc-freeze.cjs --base <SHA>`，拒绝新增顶层命令或已有命令下的业务 operation，原生 bridge 通道不在冻结范围内。

Main 总行数和业务行数分别通过 `gui-health.mjs --check --metric=mainSourceLines --base=<SHA>` 与 `--metric=mainBusinessLines` 报告；混合文件整计为业务规模上界，不代表新增职责。总量和逐文件统计沿用 `vite-plus/fmt` 固定格式（宽度 100、缩进 2），基点以同一算法实测，压行不会隐藏增长。规模变化输出 `signals` 和诊断，不单独阻断；指标缺失、未知值、owner/direction 变化及新增原生/保留职责豁免仍阻断。Renderer 平台边界继续通过 `pnpm --dir clients/gui exec vp lint --config oxlint.renderer-boundary.json renderer packages/remote packages/remote-client packages/ui` 检查。

`cargo test --locked -p areal-host --test host_protocol_conformance` 编译生成类型并调用真实本机 wire。准备匹配的固定路径 Core/Runtime 后，运行 `AREAL_TEST_HOST_KEYCHAIN=1 AREAL_CORE_BIN=/absolute/verified/areal pnpm --dir clients/gui test:host-protocol-conformance`，通过隔离 Host、Core、Relay 和 Noise 对照实际收发及资源边界。macOS 的钥匙串仅使用夹具合成项；该检查不代表安装包、真实数据或手机真机验收。

### A1 回环状态链路

`cargo test -p areal-host --lib server::loopback::tests` 通过真实 Unix 和 WebSocket 连接核对票据、Origin、代际、过期、重放及资源边界。`pnpm --dir clients/gui test:host-client` 检查共享客户端的连接身份、断线新鲜度与取消；它的 WS 服务是确定性测试服务，不代表真实 Host 或安装包通过。

隔离启动 GUI 时设置 `AREAL_HOST_WEBSOCKET=1` 可启用状态探测。Host 必须以该环境开关启动；已有关闭此能力的 Host 不会被自动重启。项目清单、会话详情与写入都经共享 Host；协议检查不能替代安装包上的真实数据验收。GUI CSP 从运行时私有描述授权回环主机的动态端口；票据只由原生能力提供并放进 WS 首帧。

开发验收可运行 `node clients/gui/scripts/seed-host-copy.mjs --from <旧 Core home> --home <隔离 Host home> --binary <待验收包内 areal>`，一致性快照后通过现有 CLI 登记路径创建测试项目，不调用导入器。工具只读源，运行副本不载入待提交、调度、凭据或远程身份，任务历史原字节另存 Core 不载入的 `seed-copy/archive/`，来源摘要和测试标记保存在隔离 home；历史 UNKNOWN 不阻塞项目，macOS Host 仅为访问系统钥匙串保留系统用户 HOME，AReaL 数据目录仍显式隔离。登记仍指向原代码目录，验收发消息须使用确定性模型或另行复制代码目录，不能在真实仓库执行真实 Agent。

`node scripts/runtime-rotation-smoke.mjs` 使用隔离目录、真实 Core/Runtime 和本地模型，分别降低 Scope、operation 与累计输出容量，验证达到预警但未耗尽时的自动轮换、活动轮次推迟、旧 Core/Runtime 退出、部署漂移保护、新 epoch、历史与 Queue 意图保留、跨轮换请求去重及后续续轮。该检查进入 `make local-service-smoke` 和 `make harness-smoke`。宿主测试覆盖维护 RPC 超时与退出取消；Engine 生命周期测试同时验证并发新轮与轮换的原子准入，以及历史 UNKNOWN 保留和未确认资源清理的阻塞；这些是确定性契约回归，不代表整体 Agent 能力提升。

`make local-service-smoke` 使用临时目录、真实 Core/Runtime、两个 PTY 和 HTTP 模型 fixture，验证并发 ensure、工作区/符号链接身份、配置冲突、认证、Web 发现、窗口退出、忙碌拒绝停止/显式取消、历史保留、launcher/host 强杀清理与重新连接。已纳入 `make harness-smoke`。`make desktop-schemas` 同时导出 `schemas/local-service-v1.json`。

`cargo test --locked -p areal-host gateway_owner::session::interaction_tests::create_` 和 `cargo test --locked -p areal-host stop_lost_response_keeps_original_unknown_without_redispatch` 使用真实 Host journal、隔离 home 和认证 WebSocket 模拟 Core，检查创建的 pending 与 outcome 写入失败、同 home owner 重建后按原 operation 查询 typed 回执，以及停止请求的原 turn 与普通会话保护和丢响应后的 UNKNOWN。此夹具不启动真实 Core/Runtime，也不模拟 Host 进程崩溃或 Core 内的 turn 切换竞态。

`AREAL_CORE_BIN=/absolute/verified/areal AREAL_NATIVE_FAULT_EVIDENCE=/absolute/evidence cargo test --locked -p areal-host native_create_success_reply_lost_recovers_without_redispatch -- --ignored` 显式运行真实 Core/Runtime 单场景。测试专用 WebSocket 代理丢弃真实创建成功回复，核对原 command 与 native request 身份、UNKNOWN、原 Core 回执恢复及重复请求不再转发创建，只产生一个 Thread。后续普通 Turn 的 Runtime 单次写入单独断言。普通单测忽略此入口；使用匹配的固定组件槽并串行运行，保留失败、回执与清理证据。Host owner/journal 使用进程内夹具，此测试不覆盖 Remote 传输、独立 Host 崩溃或原命令整套验收。

同一环境下，将测试过滤器改为 `native_creation_recovery_tests -- --ignored --test-threads=1` 可串行运行创建、交互、发送丢回复及下述 outcome 写入失败场景。交互场景丢弃真实 Core 审批成功回复，检查原命令保持 UNKNOWN、观察到 answered 不构成准入证明、重连与重复提交不再转发审批，以及原 Runtime 副作用一次。后续普通 Core 配置与 Turn 单独执行，不能替代 Main 的 pending/hasWork 门禁或未知普通提交拒绝验收；跨设备查询隔离与撤权后的查询拒绝也在此场景检查。发送场景对应有限 T19，核对原 Turn 创建回复丢失后的 UNKNOWN、原 Core typed 回执恢复、journal 的 digest 与存储身份、重复发送不再转发、单 Turn 与单 Runtime 写入，以及同 command 改变文本时的 `COMMAND_CONFLICT`。这些场景不替代原 100 轮竞态验收。

在同一固定组件环境中，`cargo test --locked -p areal-host native_detail_publication_fences_revoke_after_real_core_read -- --ignored` 以真实 Core 的原 `areal/interaction/list` 成功回帧作为发布屏障。无撤权对照核对完整详情与 review token；撤权分支在持有原回帧后修改隔离设备授权，再放行原帧，要求精确返回 `GRANT_CHANGED`。两组均核对原 interaction 内容不变、工具效果文件不存在。该测试使用进程内 Host owner，Runtime 启动后等待审批；不覆盖 Noise 错误编码、独立 Host 或工具执行。

`cargo test --locked -p areal-host native_detail_publication_fences_service_identity_change -- --ignored` 在同一回帧屏障内启动第二个真实 Core，由 Host owner 夹具显式发布新的服务描述符；原共享连接返回 `scheduleHostUnavailable`，不发布旧详情。测试核对两个 Core 的 PID 与端点不同、原审批和 journal 不变、无工具副作用及全部自有进程退出。它验证服务身份变更的发布边界，不替代真实 Host 受控重启或 Noise 错误映射验收。

`cargo test --locked -p areal-host native_approval_preflight_revocation_preserves_pending_interaction -- --ignored` 先完成真实审批详情审阅，再持有提交前检查的真实 Core 回帧并撤销设备授权。它要求返回 `GRANT_CHANGED`，没有 `areal/interaction/respond` 转发，原审批、journal 和未执行的工具状态不变；该进程内 Host 屏障不代表 Noise 撤权或派发后恢复验收。

`cargo test --locked -p areal-host native_delayed_duplicate_preflight_preserves_original_outcome -- --ignored` 在同一 Core 连接上完成两个客户端会话的审阅，持有同一命令的首次预检回帧，等另一会话持久化原 accepted 后再释放旧帧。要求重复请求返回完整相同结果、journal 不再改变、只转发一次审批且真实 Runtime 只追加一次标记。屏障不更换审阅 token 所绑定的连接；该测试不覆盖独立 Host 崩溃或 Noise 传输。

`cargo test --locked -p areal-host native_command_observation_fences_capability_and_service_changes -- --ignored` 在真实审批完成并产生一次 Runtime 副作用后，持有 `command.read` 读取原已回答交互的 Core 回帧。移除原 answer 能力时返回 `FORBIDDEN`，Host owner 发布不同服务代际时返回 `RESYNC_REQUIRED`；两组均不发布原命令结果、不再次转发审批，原 journal 和单次副作用不变。服务描述符变更由进程内夹具触发，不代表真实 Host 重启。

`cargo test -p areal-host --lib interaction_tests` 还运行 artifact HTTP 测试。真实 Host 使用隔离文件 vault 和认证的本机模拟 Core WebSocket 与 HTTP 服务，验证合法图片、404、短流、错误 Content-Length、超长流取消、HTTP 响应等待期间授权版本变化，以及读取后媒体成员被移除。该测试不启动真实 Core 或 Runtime，也不能证明分块读取期间的授权变化。

同一固定组件环境下，`cargo test --locked -p areal-host native_outcome_write_denied_preserves_original_pending_and_recovers -- --ignored` 运行有限 T22。测试代理收到真实 Core 成功回复后、向 Host 转发前，将隔离 journal 目录设为只读，检查实际 outcome 写入返回 `PermissionDenied` 且原 pending 字节保留。恢复权限后按原 typed 回执结算，重复命令只有一个 Turn 和一次 Runtime 写入。权限 guard 在正常路径和 panic 时恢复目录权限；测试记录原错误及内部 UNKNOWN 投影，不声称观察到 Remote wire 的 `submissionUnknown`。

`AREAL_NATIVE_STOP_REPETITIONS=100 cargo test --locked -p areal-host native_stop_admitted_race -- --ignored` 在同一固定组件环境运行 T23 的 100 轮 owner 层竞态；省略轮数时只运行一轮。测试代理在 A 的原停止命令已持久准入后扣住请求，让 A 完成并启动 B，再转发原 A 请求，核对原命令拒绝且 B 不受影响。随后双设备并发停止 B，丢弃真实 Core 成功回复，保留双方原结果，要求至少一个原命令维持 UNKNOWN、无回执且重连查询不重派。每轮保存原 command、operation、Turn、journal 与代理帧。此测试启动真实 Core/Runtime，但模型停在受控响应屏障，不执行 Runtime 工具；不替代 Remote Noise、独立 Host 崩溃或原命令整套验收。

`AREAL_CORE_BIN=/absolute/verified/areal AREAL_TEST_HOST_KEYCHAIN=1 pnpm --dir clients/gui test:remote-crash-recovery` 运行有限 T18。真实 Relay/Noise 请求进入独立 Host 后，测试在原 journal pending 窗口暂停该 Host，从真实 Core 核对原创建完成回执，再终止该 Host。确认旧进程退出、生命周期锁释放与原清理回执后，同 home 重启并用原设备身份读取原命令，要求恢复 accepted、保持 operation/Thread，重复创建不增加 Thread。后续普通 Turn 的 Runtime 单次写入独立验证。未命中暂停窗口即失败，不自动换轮重试；本入口不代表原 100 轮命令整套通过。macOS 仅使用获准的隔离合成 Keychain 条目，收尾核查原停止回执并清理测试条目。

macOS 可使用同一环境下的 `pnpm --dir clients/gui test:remote-crash-recovery-lldb` 选择确定性屏障。该入口显式依赖 LLDB 与系统调试授权，在发送原创建命令前确认唯一 `settle_command` 函数断点已就绪，命中后核对原 pending、无 outcome 与真实 Core 完成回执，再终止原 Host。缺少符号、授权未完成或未命中断点均按失败保留，不降级为概率重试；系统认证由用户确认。

`pnpm --dir clients/gui test:remote-outcome-recovery-lldb` 使用相同环境和 LLDB 前提，执行单轮真实 Noise outcome 写入失败及原回执恢复验证。在原持久 pending 字节可核查且未改变时，wire 返回原 `result.admissionState=unknown` 与 `submissionUnknown=true`，不返回伪造 receipt；恢复后按原 Core 回执结算。此入口不代表原 T22 整套通过。

原 `test:remote-command-e2e` 的 Rust worker 支持 `RC05_OUTCOME_WRITE_ONLY=1`，分别配合 `AREAL_REMOTE_TRANSPORT=direct` 或 `relay` 验证真实 outcome 写入失败。worker 使用同一 LLDB 屏障，持有原成功回执后将本案 journal 目录设为只读；收到原 UNKNOWN 后显式恢复权限，再核对原 command/operation/Thread 恢复与重复创建不新增 Thread。证据包括原 pending 字节、Core receipt、Debugger 清理和 Host 原停止回执。该有限选择保持 `acceptance=false`，未接通的其他故障控制及 100 轮原整套验收仍需继续。

`node scripts/shared-host-smoke.mjs` 验证共享 Host 的本机认证、并发启动、登记回执、旧服务受控重启、多项目隔离、活动 Runtime 命令期间的 Host 崩溃清理与停止回执。崩溃场景暂停旧 service-host 并确认生命周期锁仍被持有，核对继任 Host 的原启动请求返回 `migrationBlocked`，再恢复旧进程并等待清理后验证新代际和历史保持。`AREAL_TEST_BIN_DIR` 指向完整新产物，`AREAL_LEGACY_TEST_BIN_DIR` 指向支持 service-v1 的完整旧产物；缺少旧产物会失败。`node scripts/shared-host-client-smoke.mjs` 使用同一新产物验证 exec、`-p`、headless TUI 和真实 PTY 在客户端强退后继续原 Turn，以及 resume 与 Web 复用。两者使用隔离 home/workspace、确定性模型与真实 Core/Runtime，并通过 `AREAL_TEST_EVIDENCE` 保存 JSON 证据。固定产物串行使用。这些检查不替代 GUI、Remote、真实供应商或安装包验收。

macOS 实际崩溃预算使用 `AREAL_HOST_SERVICE_ROOT=/absolute/authorized/root AREAL_HOST_SERVICE_INSTALLER=/absolute/install-helper AREAL_CORE_BIN=/absolute/stable/bin/areal node scripts/shared-host-crash-budget-smoke.mjs`。服务 root、其 `home`、`agents` 与 label 须事先获准；安装 helper 通过现有 `ServiceInstallation::at/install` 写入该目录，并提供只读 `--describe`。脚本要求空项目、已卸载服务和保留的已完成停止意图，先核对 descriptor 的 label、稳定入口与 home，再注册并显式启动。它只终止认证身份匹配的隔离 Host，观察 launchd 的五次自动恢复和 1、2、4、8、16 秒退避、下一异常退出后的 `crashLoopStopped`，以及显式启动清除预算。最终仅发送一次已持久记录 ID 的停止，确认原回执后执行 `--stopped-only` 卸载。`result.json` 保留产物、管理器、代际、信号、时间与清理记录；失败时保留注册和原请求供核查。该检查不运行 Core 任务，不读取凭据，不替代真实注销登录或 Linux 验收。

`node scripts/shared-host-schedule-smoke.mjs` 使用 `AREAL_TEST_BIN_DIR` 指定的完整固定产物，默认 `.local/shared-host-bin`。它经真实 Core 创建启用、暂停及显式停止的定时任务，重启 Host 后检查仅启用项目自动激活、到期执行一次、停止抑制仍生效及显式恢复。另验证 managed 技能变更触发受控 Core 重启、新 profile 生效且 Run 不重复。独立工具连接发布 Browser/Computer 后，验证模型收到目录，工具连接关闭后原 Run 继续，后续 Run 不声明桌面工具；该检查不执行真实桌面动作。模型为本地确定性 HTTP fixture；原子发布根、不可变 Task body 和 Host 状态共同提供断言。临时目录的 `result.json` 保留源码、产物、请求与清理证据。该场景不启动 Electron，不访问 Keychain，不替代 GUI 退出交互、真机、真实供应商或系统服务登录验收。

`AREAL_TEST_HOST_KEYCHAIN=1 AREAL_CORE_BIN=/absolute/verified/areal AREAL_SCHEDULE_GUI_ROOT=/absolute/source/clients/gui AREAL_SCHEDULE_MODE=accept node clients/gui/scripts/schedule-reliability-lifecycle-smoke.mjs` 运行真实源码 Electron/Main/Host 调度生命周期回归。夹具使用独立应用身份和已构建的 Renderer 资源，通过公开 bridge 创建任务；不验证任务创建对话框。原断言覆盖未打开项目到期一次、GUI 退出后触发、显式停止期间不准入及显式重连后的 misfire。生命周期身份取认证 Host 描述及原停止回执，不依赖旧 Desktop 的 core/service.json。停止未确认时保留隔离凭据和现场，清理只核查原请求。结果、trace、截图与清理在 `.scratch/schedule-reliability-lifecycle-*/manifest.json`；该路径不覆盖真实供应商、真机或系统登录。

将上述选择变量换为 `RC05_PUBLIC_COMMANDS_ONLY=1`，并分别设置 `AREAL_REMOTE_TRANSPORT=direct` 与 `relay`，运行真实 Rust Host 的公开命令子集。它核对重复发送复用原 operation/Turn、不同设备使用同一 commandId 各自隔离、改变语义返回冲突及每个 Runtime 文件副作用恰好一次。一次合法 create 在本案 journal 目录只读期间必须返回带原 commandId 的 `CORE_UNAVAILABLE`，恢复原权限后核对 journal 字节、Core Thread 集合不变和原命令 `notFound`。迟到的旧 Turn 停止请求必须返回 `TARGET_CHANGED`，当前 held Turn 继续并正常完成。此选择保留 `acceptance=false`，不覆盖受理后崩溃、丢失 Core 回应、outcome 写入失败、已准入 interrupt 屏障或 100 次竞态验收。

使用 `AREAL_TEST_HOST_KEYCHAIN=1 AREAL_CORE_BIN=/absolute/verified/areal node --test clients/gui/scripts/remote-relay-system-ca.test.mjs` 运行 Rust Host 的原 CA 契约。测试以隔离 `SSL_CERT_FILE` 输入两个团队及组合根，真实执行 HTTPS 登记、WSS 和保存登记后的新隔离 Host 恢复；错误根、域名和过期证书检查实际握手失败、配置不变与原操作拒绝回执。操作目录观察只解析已发布的 `.json` 回执，排除原子写入期间的临时文件。此输入不修改系统信任，也不证明 macOS 钥匙串根枚举；独立 Node probe 仅标识测试证书类别，不替代 Rust 验证。证据与精确合成凭据清理保存在 `native-remote-host-*/evidence.json`。

同一 CA 和产物环境下，将上述选择条件换为 `pin mismatch|Direct and Relay share device limits|noncanonical base64|unfinished Direct and Relay handshakes|foreign channel injection|paced orderly close`，运行六个原连接与安全场景。它们使用真实 Rust Host、Direct/Relay 和 Noise 客户端，核对邀请、设备与未完成握手预算、授权收缩、攻击连接隔离及健康读取。关闭验证使用原类型化拒绝、实际 socket 关闭和应用流结束，替代 JS 私有缓存计数；不声称测得内部缓存或物理发送次数，也不代表整个传输套件已迁入。

将选择条件设为 `Direct and Relay share one readonly Core observer`，可运行原观察恢复场景：Direct 与 Relay 读取同一真实 Core Thread 基线，Relay 断连期间由公开配置 API 更新 revision，恢复连接取得 sequence 0 的新订阅和新基线；Direct 的原连接和订阅持续可读。Relay 停止后同时等待手机连接关闭和 Host 权威状态变为断开，再重启并等待新的连接状态，避免把旧连接的在线值当作重新登记成功。原 Host journal 与权威 Thread 对照用于核对无额外提交。场景名沿用旧名称，证据不推断物理 Core 连接数或 RPC 次数。

同一 CA 和产物环境下，选择 `connection write burst|receipt reads preserve|all current write methods|write budgets isolate|authentication and grant changes` 可运行两种 transport 的五个原预算场景。各场景先保留完整 JS 精确时钟 reference，再验证真实 Rust 连接；原 199/200ms 与 999/1000ms 边界还由 `cargo test --locked -p areal-host --lib request_budget_tests` 覆盖。真实连接的拒绝前缀使用 `params: null`，在预算扣减后、授权与项目读取前被参数校验拒绝，避免前缀的无关磁盘读取消耗预算窗口。一次发送有界前缀后提交合法命令，必须实际收到 `LIMIT_EXCEEDED`，再通过原命令查询和完整 journal、Thread 身份集合核对无副作用。写额度和总请求额度分别保留“命令超过允许的预算”和“请求过于频繁”；同设备跨 Direct/Relay、其他设备与重连使用实际连接核对分桶。真实混合请求的前缀包含十个参数无效的 `command.read` 和十个参数无效的写请求，核对两类请求合计计费及末项合法命令按总额度拒绝。合法回执读取不消耗写额度及精确窗口边界由 JS reference 和 Rust owner 时钟测试覆盖；另一条真实连接上的合法回执可用性另由共享写额度场景检查。真实经过时间仅作证据，不当作可控时钟，也不据此声称精确物理派发次数。

同一 CA 与固定产物环境下，选择 `sequential large history reads` 运行原大历史速率场景。默认和降低限额各使用独立真实 Host/Core，经公开 API 生成 50 个已完成 Turn、100 个原生消息；每次读取核对全部原 Item ID，保持 20 次历史读取、健康设备读取、4 个关闭帧和原滚动帧数、字节、单帧及心跳断言。TLS 代理只旁读 Host 帧类型、channel、接收时间与 JSON 字节数，不保存内容或登记 capability；实际 pong 必须发生在读取负载期间。180 秒场景预算容纳两组真实数据准备，单个应用请求仍为原 5 秒 deadline。证据保存在各 `native-remote-host-*/evidence.json`，记录接收端观察而非 Rust 物理发送调用。 整个 transport 入口的 CA 子进程直接继承标准输出与错误输出，失败时保留完整子测试日志；包装预算为 600 秒，容纳多个真实场景的完整生命周期；这不改变各场景和请求预算，也不表示整个七文件套件已验收。 同一入口可选择 `legacy encrypted` 与 `a real paused Relay TCP reader`：前者使用真实 Host 加密配置验证旧登记先持久禁用、拒绝无新登记码的启用，再显式重新登记；后者使用真实 50 Turn、100 Item 历史，暂停实际 TCP 读取，在原 16×8 请求和 1050ms 间隔内核对慢设备离线并实际关闭，健康设备与 Host 继续服务，原 journal、线程和 Item 身份不变。慢读场景的 180 秒预算包含真实数据准备。公开设备在线状态和实际连接关闭替代旧私有 Core 连接计数，不据此推断物理 RPC 次数。

同一 CA 与固定产物环境下，选择 `revocation aborts already paced|re-enabling drops paced` 运行原两种 fence 场景。每例保留完整 JS queue、timer 和发送计数 reference，再用真实 Rust Host/Core 生成 50 Turn、100 Item 历史。完整 `session.open` 与后续读取屏障后，唯一未完成请求是 `session.history`；观察该连接的大数据首片到达且完整回执尚未结束，再公开撤销设备或重新启用 Relay。断言原连接实际关闭、旧回执以 EOF 或截断 EOF 结束、撤销后的原身份被拒绝，或重新启用后的原身份保留同一 Host 的 Gateway generation，并取得新的 Relay TLS 连接、应用连接及订阅；健康读取及原 journal、Thread 和 Item 身份同时核对。180 秒单例预算包含真实数据准备，单请求仍为原 5 秒。接收端在途证据不证明当时 Rust 队列非空或物理发送次数。精确排队中止与 pending socket send 取消由 `cargo test --locked -p areal-host --lib accepted_close_waits_for_queue_and_abort_invalidates_old_stream` 和 `cargo test --locked -p areal-host --lib pending_socket_send_is_cancelled_before_old_generation_can_flush` 分层覆盖。

同一环境下，选择 `failed durable save` 保留原 JS 存储故障 reference，再运行真实 Rust Host 的生产配置入口。夹具仅将本案已有的 Gateway operation 文件设为只读，必须实际收到 `EACCES`，最后恢复原权限；原请求 ID 的公开查询必须不存在，Remote 配置与原文件字节在内存中完整比较，公开状态保持禁用及断开。随后 250ms 的有界观察要求没有 TLS 连接或 Host 登记，不将这段观察单独当作无限期无登记的证明。证据只保存配置摘要、原请求身份和错误类型，测试使用本次合成钥匙串项。

同一已验证产物环境下，`node --test clients/gui/scripts/remote-artifact-native.test.mjs` 通过 Rust `review.read`/`artifact.read` 读取原生 Task 图片，核对分片拼接、媒体归属与精确清理；`node --test clients/gui/scripts/remote-project-models-native.test.mjs` 从真实 Core 读取有界六字段模型目录及已配置显示名。这两条原生路径单列证据，不外推为原 Remote 套件全部通过。

双设备并发场景使用两个独立 Noise 设备，分别完成同一审批的审阅后并发提交不同 command。要求一条 accepted、一条 rejected，败方为 TARGET_CHANGED，operation 与设备归属独立，跨设备查询为 notFound；原 Core 交互为 answered，原 Turn 仅有一条成功 Runtime 写入结果。公开 wire 并发不证明两条请求同时通过内部预检，也不测量底层物理派发次数。

分页的 `partialChecks` 另包含 Core 换代 cursor 边界：先正常拒绝原审批并等待工作结算，保存已回答交互的分页 cursor，再经公开 `project.stop` 原回执和 `project.ensure` 重开同一 dataDir。用例要求原启动参数、serviceId、principal identity、journalEpoch、完整交互内容、Remote journal 和无文件副作用保持一致，Core generation 与 coreInstanceId 变化。重开后先用纯读 `project.models` 核对共享 Host 连接已到达新 serviceGeneration，仅轮询 `CORE_UNAVAILABLE` 暂态并记录次数与错误码；随后只发送一次旧 cursor 读取，要求原手机连接拒绝它而新分页可完整读取。它不增加完整组数；九组加 partial 不等于原 17 组全部经过真实 Core，同 digest 内容突变及其余故障屏障仍单列。新增路径的实际执行结果以本次产物的 `native-interaction-contract.json` 为准。

`pnpm --dir clients/gui run test:shared-host-consumers` 使用隔离真实 Host/Core 验证 GUI 命名环境凭据、等价 CLI 别名及外来项目的原配置和会话创建。`node clients/gui/scripts/shared-host-gui-journal.mjs` 经普通提交 owner 验证双客户端 CAS、大记录和丢回复后的原回执恢复。`node clients/gui/scripts/gui-host-lifecycle-smoke.mjs` 验证项目登记、客户端断开、显式停止/重开，以及独立客户端活动轮次的全局观察和结算；活动查询不把轮次重复计入任务数。三个脚本使用 `AREAL_TEST_BIN_DIR` 指定的固定完整产物；默认使用本仓 `.local/shared-host-bin`。这些场景不访问真实 Keychain，不启动 Renderer，不替代旧 Desktop writer fence、GUI/TUI 审批交接或安装包验收。

`node clients/gui/scripts/gui-terminal-connection-smoke.mjs` 使用同一固定产物，在独立 Node 客户端中运行生产 Main 终端连接适配器。场景覆盖显式 Profile 权限、真实 PTY 输入/输出/resize、强杀客户端后的定向 Runtime 清理、原请求恢复及普通 thread 资源继续。它不启动 Electron，不验证 Desktop 提交 journal 桥接或退出界面。

`node clients/gui/scripts/gui-toolhost-connection-smoke.mjs` 使用真实 Host/Core、DesktopService 与 ProjectConnections。Main socket 断开后 Desktop 保持运行，原 Turn 继续，动态工具报告不可用；后继 Main 只能观察活动 Turn，空闲后显式动作才重绑。另覆盖普通观察客户端断开不撤销 Main 工具。模型由本地 HTTP/SSE fixture 提供，不启动 Electron 或真实浏览器，也不证明供应商和安装包可用。

`pnpm --dir clients/gui run test:host-handoff` 使用隔离 Electron、真实 TUI PTY 和固定 `.local/shared-host-bin` 产物。GUI 提交停在审批后强退 Main，TUI 连接原 Core 完成原 Turn，Runtime 文件副作用恰好一次。GUI 重开后核对原 Turn、同项目 TUI 新会话和独立 CLI 项目的历史。脚本检查源码、构建与产物身份，并将截图、终端输出、注册记录和清理结果保存在 `.scratch/shared-host/h2-gui-tui-handoff/`。模型仅使用本地确定性 fixture，目录选择器由测试注入；该场景不覆盖凭据迁移、真实供应商或安装包。

`node clients/gui/scripts/shared-host-source-handoff.mjs --unit` 检查迁移适配器的 journal CAS、凭据版本和丢回复核查。真实迁移使用同一脚本，传入 `--legacy-app=<冻结旧版 app 目录>` 和 `--host-bin=<固定 areal 产物>`，并要求旧目录旁的 `source-manifest.json` 校验通过。macOS 运行须先取得隔离 Keychain 读写与测试条目清理授权，再设置 `AREAL_TEST_HOST_KEYCHAIN=1`。脚本使用随机应用身份的 Electron 副本和独立 Host home，先核对原生 safeStorage 条目身份，再测试凭据持久化和 journal 接管后的两次强杀恢复。旧入口真实创建请求的回复在 CoreClient 收到前被截断；新入口只能核查原回执，并断言没有再次创建且仅有一个会话。证据目录保留 `result.json`、中断与恢复记录、`keychain-cleanup.json`；清理仅针对记录的测试 service/account 和本次进程。脚本通过且正常退出才算验收完成。此项不证明发行签名身份、真实凭据或供应商可用。

macOS 上即使 GUI 配置为空，启动也会生成订阅传输 token 并写入 Keychain。运行前须取得测试 Keychain 读写授权，再设置 `AREAL_TEST_HOST_KEYCHAIN=1`；未设置时脚本在创建测试状态或启动进程前退出。系统授权可能需要用户手动确认。超时且回执为 `acceptedPending` 时保留原隔离目录和请求 ID，先核查原操作；不能视为未写入后重新提交。

故障清理时，控制 socket 或 Core 的本机 HTTP 端点可先关闭而实例锁仍由清理进程持有；故障状态轮询只等待明确的连接拒绝过渡，仍须在原有期限内读到预期的 `stopped` 或 `unavailable`。其它错误立即失败，正常状态查询不放宽。`AREAL_TEST_EVIDENCE` 可指定 JSON 回执位置，记录阶段和状态轮询；CI 将其保存在 `target/ci/local-service.json`，失败时与日志一起上传。

Core 不提供网页：`cargo test --locked -p areal-app-server --test contracts` 检查 `/ui` 不存在、任何带 Origin 的请求都被拒绝。

PTY helper 在等待 CLI、服务停止和窗口退出时持续消费终端输出，避免缓冲区背压阻塞 TUI。`make script-test` 包含退出前输出超过 PTY 容量的确定性回归。

TUI 与共享服务 PTY 检查共用终端画面解析器，处理增量重绘中保留的字符及分片 UTF-8/控制序列。模型热更新检查等待标题中的新模型名称，再确认服务 generation 未改变；不依赖原始输出字节或短暂状态通知。

`cargo test --locked -p areal-engine --test model_reload` 验证活动子任务和队列保持旧模型、新提交使用新默认值，以及忙碌 `ifIdle` 拒绝不关闭准入。本地服务 smoke 同时覆盖非法编辑、队列跨重启恢复、工作区定位和限额变化后的空闲重启。

## Task Mode 回归

`cargo test --locked -p areal-app-server --lib calendar_` 通过公开 Task dispatcher、Core 测试时钟和真实调度器核对 UTC 字面值、前五次持久 Run、Host 准备与模型观察、重启、夏令时、迟到边界和已受理计划。测试时钟只在 test-support 中可用，不是生产 RPC。GUI 日历路径使用 `AREAL_TASK_CALENDAR_REGRESSION=1 pnpm --dir clients/gui run test:task-conversation`，验证配置会话、Core 预览、错过窗口和保存后重开；本地确定性模型不代表真实供应商效果。

`AREAL_COMPAT_OLD_BIN=/absolute/v4/areal AREAL_CORE_BIN=/absolute/current/areal node examples/desktop-api/calendar-storage.mjs` 要求两个已确认身份的固定产物。它用旧二进制创建真实 v4 状态，通过当前 Core 的生产 WebSocket 路由验证迁移、只读 preview/context 权限、原收据和不可变引用，再确认旧二进制拒绝 v5 且不修改 Task 文件。脚本打印独立 Evidence 目录，保留根、收据、哈希、日志和进程停止结果；它不执行模型或 GUI，也不覆盖安装包升级。

`cargo test --locked -p areal-engine --test task_modes` 覆盖异步提问期间继续工作、独立回复与同 Run 恢复、单个问题过期时仍有其他待答问题的唤醒、headless 提问和审批、定时持久恢复、前台 Goal 异步提问、跨协调 Turn 的 worker 与共享预算、取消清理及重启回复去重。app-server 单元回归校验 Task 请求/响应/通知符合生成 schema，并验证 Thread 授权过滤与独立订阅/退订。

`node examples/desktop-api/schedule-host.mjs` 使用真实 Core/WS 与持久重启验证 Host 离线补执行、每轮新 Thread、受限身份与订阅的授权、准备失败后同 Run 继续、准备期间停止及旧 Host 迟到回复。`node clients/gui/scripts/schedule-desktop-smoke.mjs` 使用隔离 Electron/Core 和确定性本地模型验证对话创建、时区、新会话无历史、忙碌跳过、暂停和停止分离及普通审批 UI，保留截图与 JSON。设置 `AREAL_SCHEDULE_APPROVAL_EXPIRY=1` 会等待默认 300 秒期限，并验证 Turn 结算及同 Run 明确恢复后的新审批；未设置时不声称超时恢复通过。这些证据不替代真实供应商或安装包验收。

`node examples/desktop-api/run.mjs task-matrix` 使用真实二进制与 Runtime 检查 headless 普通对话/Goal 的提问与审批拒绝、允许的命令继续执行、无隐式定时调度、前台异步 Goal 断连后回复、定时触发与控制、独立 worker 文件产物及共享计量。

统一 CLI 的解析与配置进程回归位于 `clients/cli`，覆盖默认 TUI、exec、旧 -p、参数冲突和无副作用诊断。launcher 回归使用一个 areal fixture 分派 Core 与 TUI；桌面 CLI 验收同时运行 exec 和旧参数协议，发行搬迁验收检查 bin 只含 areal 且内部 Runtime 路径可用。

## 真实上下文连续性验证

构建后执行 `node scripts/context-live-smoke.mjs /absolute/model.toml`，显式选择真实模型配置，会产生模型用量。脚本创建独立工作区和状态目录，追加任务修订、三次压缩、重启 Core，然后以真实读写和命令完成 Goal；独立核验每个输出字段及已验收文件字节不变。JSON 报告记录缓存用量，不把未知用量当零。测试专用字节窗口可设 20,000、近期预算 4,096、`context_target_tokens=16000` 以触发压缩；不要把这些压力配置复制到生产。脚本不重启生产会话。 可追加第二个参数指定新的报告目录。报告分别记录 `functionalVerified`、有效模型摘要数和摘要失败；降级证据回退不能替代三次有效模型摘要，出现摘要失败时脚本非零退出。 可通过 `AREAL_CONTEXT_LIVE_BIN_DIR` 指定已冻结的二进制目录，确保重启使用同一候选版本。

工具慢时在日志过滤器启用 `areal::tool_timing=debug,areal::persistence=debug`。工具阶段区分意图持久化（含锁/clone）、执行、结果投影和最终提交；持久化区分编码、IO 准入、文件写入和 sync/rename。计时事件不增加参数、文件内容或凭据。一次编码仍保持执行前持久化和文件/目录同步顺序。

搜索回归直接运行 Runtime 文件助手，覆盖无宿主 rg/Python 的搜索、工作区 ignore、glob、上下文、截断与符号链接拒绝。原生和发行 smoke 通过 Core 的 `search_files` 验证完整调用链，不依赖 shell 中存在 rg。

桌面 soak 与 GUI 包校验接受不含独立 tools/rg 的内置搜索布局；soak 同时核对平台所需的 Runtime 组件及 manifest 文件摘要。

## Remote Rust wire 对照

先运行 `cargo build --locked -p areal-host --example remote-wire-fixture`，再运行 `cargo test --locked -p areal-host gateway::` 和 `node --test clients/gui/scripts/remote-rust-noise.test.mjs`。测试专用 runner 从 stdin 读取非敏感测试身份，复用 `core/host/src/gateway/` 源码，验证原 Ed25519 protobuf/PeerId、Relay codec 差分、双向 Noise、拆分字节、消息限额、pin、prologue 及损坏数据。`AREAL_REMOTE_RUST_WIRE_BINARY` 可指定同一 example 的已构建路径；缺少 runner 或异常退出会失败。

## Remote GUI 退出连续性

构建 Core 与 GUI 后，运行 `pnpm -C clients/gui test:remote-gui-quit`。可通过 `AREAL_CORE_BIN` 指定已构建的 Core；`AREAL_GUI_EXECUTABLE` 选择包内 Electron/Core，`AREAL_CHROME_EXECUTABLE` 选择本机 Chrome。此独立原生用例创建隔离目录和本地确定性模型，启动生产 GUI 和共享 Rust Host，经桌面界面配对 PWA Operator，在原始文件审批待处理时正常退出 GUI，再由 PWA 允许一次。它核对同一 Host PID/身份、独占服务注册记录的 Core generation、原 Thread/Turn/交互、一次文件工具结果、持久 Remote 受理记录以及两个正常模型阶段；重新打开 GUI 不得增加模型请求。随后通过公开 `stopService` 和正常确认对话框验证停止意图、描述文件删除、PID 退出、Remote 断连及再次打开 GUI 不自动启动。

以 `AREAL_RC13_MODE=relay-protocol AREAL_CORE_BIN=/absolute/verified/areal AREAL_TEST_HOST_KEYCHAIN=1 node clients/gui/scripts/remote-gui-quit-e2e.mjs` 运行独立的 Relay 协议客户端模式。该模式先由公开 CLI 在同一隔离 registry 预启动带测试 CA 的 Host，再让真实源码 Electron 附着，完成项目、配对确认、退出和重开。远端使用生产 `RemoteConnection`，经本地生产 Relay 和严格 TLS 完成原交互的分页审阅与一次 `allowOnce`。同一原命令失去回复后只读取原 `commandId`；不再次响应审批。原 Relay 登记未结算时，保留本案合成凭据和 Relay store 供原 ID 核查。结果继续核对原 Host/Core 代际、原 Turn、一次文件副作用、持久受理记录及显式停止意图。协议客户端的原会话快照与 JSON 证据替代此模式的 PWA 画面；默认 Direct 模式的全部浏览器断言仍独立执行。该模式不代表浏览器 TLS 或手机真机验收，不改系统 CA 信任。运行须独占已验证产物和隔离 profile，由 GUI 验收驱动执行；报告和精确进程、测试凭据清理保存在同一 `report.json`。

`node clients/gui/scripts/remote-gui-quit-e2e.mjs --self-test` 只检查确定性模型的两个阶段和拒绝条件，不加载 Electron、不启动网络，也不构成原生验收。原生运行需要操作系统安全存储可用；生产后台 `enableDirect` 失败返回退出码 2 和 `blocked`，不得替换 safeStorage。报告保存在独占 scratch 的 `report.json`；失败现场保留，若适配器仍存活，先核查并结算该隔离服务后显式停止。报告不包含服务凭据，不宣称精确 Core RPC 派发次数；默认 Direct 模式不覆盖睡眠、手机真机、Relay、公网或发行安装验收。

## CI 门禁与冷启动

PR #111 在初始 G0 快照后整合历史恢复与定时任务所有权。以下六个存量文件上限按集成提交 `9297968c` 的实测值明确修订；指标方向、新文件 800 行上限和 CI 阻断继续生效。这些例外接受模块增长，不代表结构已经改善。

| 所有者 | 原行数 → 当前行数 | 原因 |
| --- | --- | --- |
| `services/workbench/src/desktop/core/backend.cjs` | 2270 → 2284 | 连接任务目录与定时 owner 生命周期 |
| `services/workbench/src/desktop/core/history-observation.cjs` | 1072 → 1175 | 协调有界历史读取、owner 任务与恢复 |
| `services/workbench/src/desktop/core/lifecycle-operations.cjs` | 845 → 878 | 持久化调度抑制并支持显式恢复 |
| `renderer/src/Composer.tsx` | 1564 → 1580 | 通过 owner 任务目录定位 worker 的原任务运行 |
| `renderer/src/Messages.tsx` | 1561 → 1718 | 加载早期历史时保持阅读锚点 |
| `renderer/src/TaskCenter.tsx` | 2356 → 2380 | 观察任务目录修订与共享 owner 激活 |

推送 GUI/Core 集成分支前，获取实际目标引用并准备锁定依赖；推送钩子执行 `make check-changed CI_BASE=upstream-readonly/main ARGS=--phase=push`。按实际影响运行本地专项；默认 `check-changed` 保留较广的选检和失败专项，`ARGS=--phase=full` 或 `make ci-preflight CI_BASE=upstream-readonly/main` 执行完整本机验收。共享计划包含适用的 Rust/SDK、schema、静态检查、生产构建与预算、Portable/Core 契约、原生与 Electron smoke。GUI 普通检查使用 Node 24.22.1；Relay 合同使用 Node 24.2.0，本机可通过 `AREAL_RELAY_NODE_BIN` 指定其可执行文件。完整本机验收执行当前平台全部适用项；快检仍列出未执行的完整验收项，Linux 容器和其他平台列为远端必需项，不计作本地通过。

快检只运行一套 Portable 生产构建和包体预算，Relay 与 macOS 的独立构建及原生 helper 留给完整验收。`mobile-types` 在快检执行；`mobile-browser` 与 Relay 安装在完整 `mobile` 组执行。GUI 主进程使用 Node 24.22.1，Relay 子进程通过 `AREAL_RELAY_NODE_BIN` 指定 Node 24.2.0，执行器将它传给夹具的 `AREAL_RELAY_NODE`。移动浏览器需要锁定 Playwright 的 Chromium 和 WebKit，Chrome 能力不代替这两项。类型失败不阻止独立浏览器场景收集结果。

`test:composer-files` 是文件引用的独立必需 smoke，保留普通 `test:composer` 的输入与 IME 检查。移动浏览器与文件专项都由同轮 `GUI gate` 校验，缺失结果、错误平台或旧 attempt 均失败。推送钩子固定执行参数，继承的 `ARGS=--plan` 不得跳过快检。

本机预检使用项目工具链：`export PATH="$PWD/.venv/bin:$PWD/.local/tools/node/bin:$PATH"`。Git 提交与推送 hook 自动按此顺序优先使用仓库内工具，无需先激活终端环境。Python 放在 `.venv`，Node 24.22.1 的官方发行包解压到 `.local/tools/node`（可执行文件为 `.local/tools/node/bin/node`）；这两个目录均被 Git 忽略。缺少仓库内工具时使用调用者的 PATH，版本不足仍由能力探针明确阻塞。能力探针要求 Python 至少 3.11，且具备 `tomllib` 和 tar 解包过滤；缺失时提前 blocked。Cargo 自身管理 verify/native 的可变构建目录与重建，产物哈希冻结限于发布给其他 job 的 GUI bundle；该 bundle 的消费者仍逐文件复核哈希。

本地与 CI 通过 `scripts/ci-preflight.py --groups <组名>` 执行同一计划，`--plan` 只展示。`make ci-gui-static CI_BASE=<ref>` 运行 Portable 的提交阶段，`make ci-gui-portable CI_BASE=<ref>` 运行完整 Portable 组，`make ci-core-contracts CI_BASE=<ref>` 连同产物依赖运行 Core 契约。`make ci-gui-health` 保留轻量健康入口，需先按 GUI 锁文件安装固定格式化器依赖。显式 `AREAL_CORE_BIN` 必须与刚构建的 Core 哈希一致；macOS 原生执行按固定产物路径流程准备。CI 只有同一 run/attempt 的产物依赖报告可跨 job 使用，消费者重新核对产物哈希。最终 gate 独立重算计划，严格核对结果全集、子测试全集和源码/计划/run/attempt 身份，缺项或意外 skip 拒绝放行。

`gui-health.mjs --check --base=<ref>` 会标记基线源码已存在的超限，硬检查仍以已审核的 `health-baseline.json` 判定失败。继承分类用于归因，不是自动豁免；显式例外与基准变更继续经过既有审查。模型菜单 smoke 通过稳定的 `composer-model-trigger` 打开入口，在对应服务商标签内选择原生 radio，并以选中模型和后续行为验证结果。 架构迁移需要整体换基线时，在 `health-baseline.json` 写一条 `$rebaseline`（基点提交、原因、放行的 IPC 名字）：只有以该提交为基点的比较免去“相对基点只降不升”和 IPC 冻结，合入后自动失效，下次写基线时删除。

规模信号包括 Main 总量/业务量、工作台迁移规模、App 行数和 hooks、Renderer CSS 行数、设计文档字节数、已检查文件数、单测文件数及逐文件大小。保留基线和实际 PR 基点对照供职责审查，不通过提高阈值或无关删改消除信号。类型覆盖、能力清单、preload/transport 一致性和依赖边界继续硬检查。数组风险规则 `areal/no-unchecked-array-method` 保持 warning；现有 lint correctness 规则设为 error，提交和 push 入口不再把该信号升级为失败，其他 lint、格式和类型错误仍阻断。

`Track red main` 工作流跟踪 main 上 `Verify` 和 `GUI checks` 的 push 结果。写 issue 前核对当前 main 提交、该 workflow 最新 run/attempt 及终态；过期通知与未完成的新 attempt 不修改告警。当前失败创建或更新对应 issue，当前成功关闭；仓库保护规则拥有必需检查设置。`python3 -m unittest scripts.tests.test_ci_contracts` 在 GitHub CLI 边界使用离线响应，覆盖乱序完成、旧 attempt、新运行未完成和 API 读取失败，测试不会写入真实 issue。

运行 `make hooks-install CI_BASE=upstream-readonly/main` 激活本地 hooks。安装器保存实际远程目标，不覆盖其他 hooks。提交钩子在暂存快照验证 manifest、生成 `target/ci/staged-plan.json`，再检查格式和 workflow；计划展示不等于执行验收。推送钩子要求推送 SHA 等于当前 HEAD、受控文件及非忽略未跟踪输入干净，抓取目标后固定运行 `push` 阶段及依赖；较慢的失败专项由默认/完整入口和远端执行，报告保留未执行清单。并发工作使用独立干净 worktree。`make workflow-lint` 使用校验 SHA-256 的 actionlint 1.7.12。远端独立执行适用检查；真实供应商、设备和签名安装包仍需专项验收。

`pnpm --dir clients/gui test:macos-dmg` 在 macOS 上独立通过真实 `codesign` 和 `hdiutil` 验证签名 framework 暂存。它需要允许磁盘映像设备访问的环境；受限 Agent 沙箱可能返回 `Device not configured`。应记录环境失败，并在允许的宿主环境重跑相同测试，不跳过断言，也不据此宣称安装包验收通过。macOS GUI job 显式执行该检查；可移植 `verify` 不创建磁盘映像。

GUI CI 只构建一次 Core 和 Renderer。构建 job 完成后，两条 Core 合同 lane 可以并行，GUI smoke 同时消费构建产物开始执行，不等待合同结果。smoke 保留现有测量选出的并发上限，各 job 仍受共享 runner 配额约束。两组消费同一份产物，分别校验源码 SHA 和可执行组件；Core 失败仍收集独立 smoke，`GUI gate` 要求两组全部通过，失败、取消或意外跳过都不能通过。Core 合同的日志、报告和隔离临时目录单独归档。历史兼容、迁移、Composer、模型选择、队列、对话派生和 Side chat 按清单选择后拆成独立隔离的 matrix job（`fail-fast: false`；各 workflow 仍共享 macOS 配额）。同轮 artifact 以 tar 保留可执行权限，并记录精确 checkout SHA；smoke 拒绝不匹配的源码。锁定的 pnpm/Electron/FFmpeg 下载使用缓存；构建成功即可保存构建缓存，不再因后续 smoke 失败丢失缓存。报告与跨 job 产物绑定 workflow attempt；需要重跑时执行完整 workflow，旧 attempt 的通过记录或产物不能满足新一轮门禁。缺失产物、失败、取消或意外跳过仍使 gate 失败，不使用 `continue-on-error`。

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

存量较多的规则不写豁免注释，改用基线脚本：`areal/no-restyle`（R-CHECK-022，页面不改 @areal/ui 组件外观）由 `node clients/gui/scripts/restyle-lint.mjs` 对照 `design-system/restyle-baseline.json`，基线外的新违规失败；修好后运行 `--write` 删除对应条目，`--write` 不能加入新条目。

尺寸观察使用 `@areal/ui/observe-resize`，并将清理函数用于 effect 卸载。该工具拥有原生构造；增量门禁约束新增和修改的调用点，存量调用尚未批量迁移。运行 `pnpm --dir clients/gui test:resize-observer` 在隔离 Chrome 中对照原生回调与共享工具的提交时序，并验证 disconnect。该测试不证明所有布局抖动已修复。

无障碍专项只收集四条 JSX-a11y 规则，仓库插件诊断交由常规增量检查；两类检查分别执行，避免存量仓库规则混入无障碍基线。规则正反例和增量检查仍必须通过。

`python3 scripts/runtime-image-smoke.py --bin-dir target/debug --evidence /tmp/runtime-image-evidence.json` 使用真实 Runtime 和文件助手验证大源图在传输前缩小、派生输出计量、只读来源、分页回取与小额度失败，不调用模型。可用 `--image /path/to/existing.png --dimension 1500` 复用既有原图；运行记录必须区分原始文件与 observer 导出的缩略图。

### 有限真实模型场景

`npm run test:model-live -- /absolute/model.toml` 使用配置中的模型和端点，经真实 Core/Runtime 执行对话文件读取、后台 Task 写文件和正常重启后的原 Thread/Task 恢复。对话要求成功的读取工具和回复包含输入；后台要求原 Run 完成且文件字节一致；重启后重新检查原 Turn、Run 和文件。它不覆盖运行中崩溃、UNKNOWN 恢复、GUI 或真机，也不代表模型整体能力。

先在供应商控制台创建独立、限额的测试 Key，配置 TOML 使用 [模型配置](../guides/configuration.md) 中的端点与模型，不将 Key 写入配置。只在本地交互终端输入，不发送到聊天：

```bash
read -rs 'AREAL_LIVE_API_KEY?Model API key: '; echo
export AREAL_LIVE_API_KEY
npm run test:model-live -- /absolute/model.toml
unset AREAL_LIVE_API_KEY
```

上述 `read` 语法适用于 zsh。脚本以 `--api-key-env AREAL_LIVE_API_KEY` 指定变量名，真实请求会产生费用。可用 `AREAL_LIVE_BIN_DIR` 指向已构建的固定二进制目录；默认使用 `target/debug`。确保产物与待验源码匹配。

每次输出一个权限为 0700 的临时目录，其中 `<run-dir>/evidence/result.json` 记录源码版本、配置摘要、已完成阶段、身份、用量和清理结果；失败退出非零，不将未到达阶段计为通过。`state/` 含认证令牌与模型历史，整个运行目录均视为私有，不上传；分享摘要前仍需审阅。脚本不保存原始服务日志。验证后可按输出的确切目录手动删除。不要对生产数据运行，也不要把凭据放入 shell 历史、命令参数或证据。
