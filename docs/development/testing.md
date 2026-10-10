**中文** | [English](testing.en.md)

# 测试

依赖安装见[开发指南](README.md)。常规测试使用临时目录、动态 loopback 端口和确定性模型，无需真实模型凭据。

| 入口 | 范围 |
|---|---|
| `make verify` | Cordis pin、格式、静态检查、Rust workspace、两套 SDK、Python、文档和 TUI smoke |
| `make script-test` | 启动器、Web 思考/等待/取消投影、perf 统计/证据与文档链接/语言配对 |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | 并发原语 |
| `make verify-runtime` | Runtime 单元测试与真实文件、进程、权限和关闭 smoke |
| `make verify-harness` | verify 后顺序运行 Runtime、完整 Harness、桌面 API 和 Workgroup smoke |
| `make verify-native` | macOS 原生后端测试与 Harness 集成 smoke；通用回归由 `make verify` 覆盖 |
| `make examples-desktop-api` | [直接 API、CLI、Skill 与搬迁打包产物](../examples/desktop-api.md) |
| `make workgroup-smoke` | 独立 Runtime 写入、组合验收、命令期限与失败后结算 |

快照格式变更须运行 `make verify-harness`：Harness 与插件 smoke 核对写入版本，桌面搬迁测试同时核对发行 manifest、`areal/server/status.stateVersion` 与实际快照版本一致。

macOS 原生 smoke 需要 Seatbelt，Linux 原生 smoke 需要 `/usr/bin/bwrap` 和 user namespace；两者都不能在能力缺失时回退到无沙箱执行。`outer-container-perf` 仍在受控容器中验证。默认 `cargo test` 不运行显式忽略的原生 Workgroup 和容量用例。

Linux 宿主常规检查使用 `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`。原生后端测试要求 `/usr/bin/bwrap` 和 user namespace；CI 的独立任务构建 Dockerfile 的 `runtime-tests` 目标，在带 Bubblewrap 的受控容器中实际运行包含 `outer-container-perf` 的全部后端测试，不能仅排除后就视为完成验收。

## GUI 与桌面路由门禁

`cargo test --locked -p areal-app-server --lib desktop_registered_methods_have_dispatch_routes` 对每个已注册桌面 RPC 经真实连接分派发送非对象参数，要求返回参数错误而不是方法不存在；包含连接层单独接管的 `areal/thread/start`。该检查随 `make test-protocol`、`make test` 和 CI 执行，不启动模型请求或创建 Thread。

[GUI CI](../../.github/workflows/gui.yml) 在 GUI、Core、Runtime、schema 与相关构建配置变更时运行冻结依赖安装、GUI 类型检查、公开边界、Core/GUI 构建、路由检查，以及现有 `make gui-smoke`、`test:composer`、`test:queue`。三个 smoke 顺序运行，使用独立目录和确定性本地模型；日志、截图与源码 manifest 上传为 CI artifact，不替代真实供应商或安装包验收。

Composer 和队列 smoke 共用 `clients/gui/scripts/smoke-navigation.mjs` 的导航与窄窗步骤：悬停项目后新建对话，通过稳定 task ID 切回对话，窄窗先收起侧栏再等待编辑器可见。失败保留 `failure-window.png` 整窗截图和 `failure-state.json` 的原错误、视口、当前项目/Thread 与可见文本；截图或页面已不可用时记录采集失败，不替换原测试错误。

## Python 与 scratch

Linux 回收测试使用随 `cargo test -p areal-runtime-exec-native` 构建的 `areal-runtime-reaper`。若单独运行 `--lib`，先执行 `cargo build --locked -p areal-runtime-exec-native --bin areal-runtime-reaper`，且构建和测试须使用相同 profile。macOS 后代测试让祖先存活至跟踪窗口内再退出，验证已观察后代清理；不把该测试解释为快速孤儿化的完整保证。

macOS Python/scratch 的独立回归（本地模型，不需要供应商密钥）：

```sh
python3 scripts/native-python-smoke.py --bin-dir target/debug
```

`make harness-smoke`（由 macOS CI 的 `make verify-native` 调用）包含此回归。它在默认 YOLO 和显式 native 沙箱下分别验证自动 scratch 与自定义 `--scratch`：两者均暴露 `verify_command`，并在 Thread 私有子目录保存退出码为 0 和 7 的验证回执。共享解析器测试覆盖已安装 CLT 但无 `developer_dir` 链接的发现路径，并验证 framework 外的解释器被拒绝。

`make workgroup-smoke` 同时验证 Worker 命令的 `TMPDIR` 位于私有工作区下的 `.scratch/agent-<threadId>`，该目录可写且 Python 字节码写入被禁用。

## 恢复与研究 Agent

```sh
cargo test --locked -p areal-engine --test truncated_usage --test tool_call_stream --test http_model --test context --test tools --test async_agents --test recovery
python3 -m unittest discover -s scripts/tests
python3 scripts/native-tools-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
python3 scripts/native-agents-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
```

原生工具/Agent smoke 使用本地固定响应 HTTP 模型、统一 launcher 与临时工作区，无需外部模型。覆盖文件 CAS、搜索、验证 receipt、图像，以及不委派、单 Worker、同步等待、预算失败、父取消和默认异步；异步用例要求三个 Worker 请求结束前父任务继续推进，并检查主/子采样参数。流测试覆盖 length 同帧/尾帧 usage、EOF/取消、不重放 UNKNOWN、压缩后句柄与跨 Turn 边界。

请求预算测试覆盖 Chat Completions 与 Responses 在最后一轮返回工具时的 `MAX_MODEL_ROUNDS` 分类，并检查零工具执行、无重试和原始预算审计；普通工具调用预算耗尽及非法 `index` 不应被误分类。桌面 CLI 验收同时检查对应的 `error_max_turns` 结果。Goal HTTP 回归同时验证输出 token 上限与工具数量/缓冲预算经过共享池后仍生效，失败请求的未知消费阻止后续重试和工具执行。

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

## CI 与契约

macOS 与 Linux 宿主检查使用同一矩阵定义，`fail-fast: false` 保证任一平台失败不取消另一平台的覆盖。macOS 使用 `make setup-node`，仅安装原生 smoke 和 SDK 所需的 Node 依赖；Linux `make setup` 继续安装全部锁定格式工具。原生验收在同一次子 Make 调用中运行 Runtime、Harness、桌面 API 和 Workgroup smoke，共用一次 workspace build。Docker 只复制所需 CLI/TUI/Web 客户端，GUI 不进入构建上下文。所有原有检查与测试保留。

`harness-smoke.mjs` 通过真实 Core/Runtime 和模型请求检查根/嵌套 `AGENTS.md` 的顺序、无关目录隔离、缺失文件、跨 Turn 刷新、32 KiB 边界、UTF-8 和符号链接拒绝。

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

`cargo test --locked -p areal-app-server --test browser_auth` 验证可信客户端到真实 HTTP/WebSocket 的自动登录、并发单次兑换、Origin 校验、实例隔离、权限继承、手动登录与会话到期断连；该 crate 单元测试使用虚拟时间检查登录码/会话过期和容量上限。`node --test scripts/web-progress.test.mjs` 检查兑换前清除 URL 片段、成功后连接、失败时手动登录兜底和普通刷新。

PTY helper 在等待 CLI、服务停止和窗口退出时持续消费终端输出，避免缓冲区背压阻塞 TUI。`make script-test` 包含退出前输出超过 PTY 容量的确定性回归。

TUI 与共享服务 PTY 检查共用终端画面解析器，处理增量重绘中保留的字符及分片 UTF-8/控制序列。模型热更新检查等待标题中的新模型名称，再确认服务 generation 未改变；不依赖原始输出字节或短暂状态通知。

`cargo test --locked -p areal-engine --test model_reload` 验证活动子任务和队列保持旧模型、新提交使用新默认值，以及忙碌 `ifIdle` 拒绝不关闭准入。本地服务 smoke 同时覆盖非法编辑、队列跨重启恢复、工作区定位和限额变化后的空闲重启。

## Task Mode 回归

`cargo test --locked -p areal-engine --test task_modes` 覆盖异步提问期间继续工作、独立回复与同 Run 恢复、单个问题过期时仍有其他待答问题的唤醒、headless 提问和审批、定时持久恢复、前台 Goal 异步提问、跨协调 Turn 的 worker 与共享预算、取消清理及重启回复去重。app-server 单元回归校验 Task 请求/响应/通知符合生成 schema，并验证 Thread 授权过滤与独立订阅/退订。

`node examples/desktop-api/run.mjs task-matrix` 使用真实二进制与 Runtime 检查 headless 普通对话/Goal 的提问与审批拒绝、允许的命令继续执行、无隐式定时调度、前台异步 Goal 断连后回复、定时触发与控制、独立 worker 文件产物及共享计量。`node --test scripts/web-progress.test.mjs` 检查等待状态、跨分页选中项、旧 revision 拒绝、Inbox 草稿保留和超时回复幂等重试。真实浏览器验收入口与操作见[桌面示例](../examples/desktop-api.md#web-validation)。

统一 CLI 的解析与配置进程回归位于 `clients/cli`，覆盖默认 TUI、exec、旧 -p、参数冲突和无副作用诊断。launcher 回归使用一个 areal fixture 分派 Core 与 TUI；桌面 CLI 验收同时运行 exec 和旧参数协议，发行搬迁验收检查 bin 只含 areal 且内部 Runtime 路径可用。

## 真实上下文连续性验证

构建后执行 `node scripts/context-live-smoke.mjs /absolute/model.toml`，显式选择真实模型配置，会产生模型用量。脚本创建独立工作区和状态目录，追加任务修订、三次压缩、重启 Core，然后以真实读写和命令完成 Goal；独立核验每个输出字段及已验收文件字节不变。JSON 报告记录缓存用量，不把未知用量当零。测试专用字节窗口可设 20,000、近期预算 4,096、`context_target_tokens=16000` 以触发压缩；不要把这些压力配置复制到生产。脚本不重启生产会话。 可追加第二个参数指定新的报告目录。报告分别记录 `functionalVerified`、有效模型摘要数和摘要失败；降级证据回退不能替代三次有效模型摘要，出现摘要失败时脚本非零退出。 可通过 `AREAL_CONTEXT_LIVE_BIN_DIR` 指定已冻结的二进制目录，确保重启使用同一候选版本。

工具慢时在日志过滤器启用 `areal::tool_timing=debug,areal::persistence=debug`。工具阶段区分意图持久化（含锁/clone）、执行、结果投影和最终提交；持久化区分编码、IO 准入、文件写入和 sync/rename。计时事件不增加参数、文件内容或凭据。一次编码仍保持执行前持久化和文件/目录同步顺序。

搜索回归直接运行 Runtime 文件助手，覆盖无宿主 rg/Python 的搜索、工作区 ignore、glob、上下文、截断与符号链接拒绝。原生和发行 smoke 通过 Core 的 `search_files` 验证完整调用链，不依赖 shell 中存在 rg。

桌面 soak 与 GUI 包校验接受不含独立 tools/rg 的内置搜索布局；soak 同时核对平台所需的 Runtime 组件及 manifest 文件摘要。
