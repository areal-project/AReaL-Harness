**中文** | [English](README.en.md)

# 开发指南

先阅读[架构](../design/architecture.md)、[开发规范](../../AGENTS.md)和[Agent 改进目标与方法](agent-improvement.md)。所有命令从仓库根目录执行。

[T3 Code 质量补充设计](t3code-quality-design.md)说明协议回放、可控时序、投影一致性、本地快检和 GUI 派生缓存的实现与验收边界；操作入口见[测试指南](testing.md)。

## 并行修改与终验

开始修改前核对 `git status --short`、当前分支和已有 worktree 的任务归属。当前 checkout 有其他活跃写任务时，优先复用本任务的独立 worktree；没有可复用目录时，从明确的已提交基线创建 `codex/` worktree。未提交改动由原任务提交或显式交接，不能仅因工作区暂时干净就认定无人写入。

隔离在修改版本号、准备 PR 或派发写任务之前完成。新建分支不等于新建工作目录；每个独立并行写任务使用自己的 worktree。同一任务内按不重叠文件分工的子任务可以共用该任务目录，由主任务统一提交与构建；派发信息必须给出该目录的绝对路径、基线提交和文件所有权，子任务先核对 `git rev-parse --show-toplevel` 与分支再编辑。只读审查也明确其读取的 worktree 和提交。

使用 Git 原生入口，不另建任务登记系统：

```sh
git worktree list --porcelain
git worktree add -b codex/task-name /absolute/task-worktree <committed-base>
git -C /absolute/task-worktree status --short
git -C /absolute/task-worktree rev-parse --show-toplevel HEAD
```

切换后，所有编辑、构建和提交命令都以该 worktree 为 cwd。发现意外改动时仍停止并核对归属；隔离不能替代这项保护。共享主目录的原有脏文件不需要为此收起或搬运。

在选定 worktree 完成构建，再进入终验；同一个验收实例使用的源码、依赖与输出在其退出前固定。需要继续开发或构建时使用另一个 worktree。浏览器验收优先消费独立静态产物；必须使用 Vite 开发模式的计量场景在独立冻结 worktree 串行执行，避免类型生成或构建触发 HMR。操作与证据要求见[验证产物与启动诊断](testing.md#本地验证产物与启动诊断)。

## PR 提交身份

获得推送和 PR 创建授权后，先完成目标分支推送，再从干净的任务 worktree 使用以下入口；仓库与分支均显式指定，不从 remote 名称猜测目标：

```sh
python3 scripts/pr-create.py --repo upstream-owner/repository \
  --head-repo fork-owner/repository --branch codex/task-name --base main \
  --expected-head <full-commit-sha> --title 'fix(scope): describe the change' \
  --body-file /absolute/pr-body.md
```

脚本通过 `gh` 读取来源分支，要求远端 SHA、当前 HEAD、当前分支和干净工作区一致，再检查是否已有同来源、同 base 的开放 PR。全部满足才创建，并回读 PR 的状态、`headRefOid`、来源仓库、来源分支及 base。成功输出 JSON；失败退出非零。它不推送、不合并、不自动重试创建。测试随 `make script-test` 执行，仅使用临时 Git 仓库和合成 `gh`。

创建响应丢失时结果为 UNKNOWN；先用 `gh pr list --state all` 核对该来源的开放、关闭和已合并 PR，再决定下一步。已得到 URL 但回读不符时，错误保留该 URL，处理原 PR，不能另建。远端可能在前置检查后变化，回读失败因此不表示“未创建”。之后更新 PR 仍须重新核对 head。合并另需授权，并使用 `gh pr merge <number> --repo <owner/repository> --match-head-commit <verified-full-sha>` 约束实际合并提交；CI 与源码审核要求照常执行。

## 环境

| 依赖 | 要求 |
|---|---|
| Rust | `rust-toolchain.toml` 固定 1.94.0，含 rustfmt / Clippy |
| Python / uv | 开发使用 Python 3.11+；uv 安装锁定工具。macOS 产品运行需要可用的 `/usr/bin/python3`（Xcode Command Line Tools）；Linux 产品启动无需 Python；独立安装与升级脚本需要 PATH 中的 Python 3.9+ |
| Node.js / npm | Node.js 22.19.0+；两套 SDK 与格式工具 |
| 编译工具 | Git、Bash、GNU Make 3.81+、C/C++ 编译器、CMake；macOS 需 Xcode Command Line Tools |
| 文件搜索 | Runtime 文件助手内置 ripgrep Rust 搜索库；`make build/release` 不依赖宿主 rg |
| 原生执行 | macOS `/usr/bin/sandbox-exec`；Linux `/usr/bin/bwrap` + Runtime seccomp；固定评测另用[受控 Docker profile](../benchmarks/README.md) |

```sh
make setup
make build
make verify
```

`setup` 安装锁定的 Cargo、npm 和 uv 依赖。模型 fixture 无需密钥。使用代理时保留已有 `NO_PROXY` 条目并加入 `127.0.0.1,localhost`，同时配置了 `no_proxy` 时也同步更新。

开发时，启动和服务控制统一使用 `target/debug/areal`，避免与 PATH 中的安装版混用：

```sh
make build
./target/debug/areal service restart
./target/debug/areal
```

仅二进制变化时，共享服务空闲会自动重启，无需每次手动操作。若报配置冲突，执行诊断中的完整重启命令；有后台任务时先等待结算，确需取消才加 `--cancel`。频繁切换开发版/安装版时，可给开发版指定独立的外部目录，例如 `--data-dir /tmp/areal-dev-state`，启动和重启都传入同一参数；该目录使用独立历史。服务兼容性见[本地服务契约](../api/local-service.md#实例兼容性与历史)。

macOS 的 `make build/release` 还按 SHA-256 锁定的源码和补丁构建独立 Bash，并缓存到 `target/runtime-shell`、复制到 `target/<profile>/shells`；首次构建需要网络、C 编译器和 Python 3.11+（支持 tar 数据过滤器的补丁版本）。仅运行 `cargo build` 不生成这部分完整 Runtime 资源。运行任务时不下载 shell，不替换系统程序。该独立组件保留 GPL-3.0-or-later 许可证与完整对应源码，项目 Rust 代码继续采用 Apache-2.0；见[发行要求](releasing.md)。

`python3 scripts/tool-capacity-smoke.py --report /tmp/tool-capacity.json` 用真实原生 Runtime 在两个后台进程占满名额后提交 16 个文件操作，并检查受限 Node 创建/关闭订阅适配器。先运行 `make build` 和 `make gui-install`。`node scripts/permission-presets-smoke.mjs` 同时覆盖带 `AGENTS.md` 的审批隔离，以及同一 Turn 的并发 `read_file`/`search_files`。均为确定性机制回归，不代表整体 Agent 收益。

`scripts/managed-toolchains-smoke.py --help` 提供本机已有 Node/npm/pnpm 的输入参数。该测试并发检查常见安装布局，并在 NVM、mise 的父/子 Scope 中实际执行 `node --test`、`npm test`、`pnpm test` 及嵌套 Node 子进程；版本号查询不代替这些执行检查。它同时保留凭据读取、工具链写入、子 Scope 源码写入和网络访问的拒绝断言，不下载依赖。

GUI 验收的服务清理检查复用产品的原生 Core 启动适配，并异步查询进程状态，让同进程内的模型 HTTP 夹具继续响应。验收必须同时确认任务结果、工具结果和所属服务退出；测试驱动完成不等于任务成功，预期权限拒绝或主动终止测试应单独断言。

## 验证入口

| 修改范围 | 命令 |
|---|---|
| 格式 | `make fmt` / `make fmt-check` |
| 静态检查 | `make lint` |
| 本地改动快检 | `make check-changed CI_BASE=<ref>`；`ARGS=--plan` 仅输出计划，所选检查的结果与未执行条件分别报告 |
| Rust / SDK / 脚本 | `make test` / `make sdk-test` / `make script-test` |
| 常规回归 | `make verify` |
| 原生集成 | `make verify-harness`，包含常规回归 |
| 统一委派集成 | `make unified-execution-smoke`：真实 Runtime 的并行候选组合、交付回执、父任务权限、取消与恢复；已包含在 `make harness-smoke` / `make verify-native`；Linux CI 在允许 Bubblewrap user namespaces 的受控容器中执行，`make verify` 保持跨平台常规回归 |
| 子任务权限集成 | `make delegation-permissions-smoke`：真实 Runtime 的强制只读、沙箱不可用提前拒绝、显式继承读取和父子读取协作；模型 fixture，不评价任务能力；已包含在 `make harness-smoke` |
| CI 原生增量 | `make verify-native`，仅运行原生后端与 Harness 集成 smoke |
| 容量 | `make capacity`，独立运行 |
| 仅文档 | `python3 scripts/check-docs.py`，同时核对命令与实现 |

统一委派冒烟默认使用 `target/debug`；可用 `AREAL_UNIFIED_BIN_DIR` 指定完整安装包的 `bin` 目录，用 `AREAL_UNIFIED_EVIDENCE_DIR` 保存完整 Core/Runtime stderr。独立 worker 始终使用 native 沙箱；Linux 需要可运行的 Bubblewrap 与 user/mount/PID namespaces，不继承父启动器的 full-access 模式。

需要从固定产物路径测试时，先构建并部署同一构建的 Core 与 Runtime，再设置绝对路径：`scripts/smoke.mjs`、`scripts/trajectory-smoke.mjs`、`scripts/trajectory-semantics-smoke.mjs` 和 `scripts/local-service-smoke.mjs` 使用 `AREAL_TEST_BIN_DIR`；`scripts/tui-local-smoke.py` 使用 `AREAL_TEST_BIN` 指定 `areal` 文件；GUI 源码测试使用 `AREAL_CORE_BIN`。按需直接运行对应脚本，测试期间保持产物不变；这些变量不改变安装包测试入口，也不授予终端安全软件的执行许可。

`make integration-boundaries` 检查产品、发行入口和默认 Make 依赖图不加载可选平台适配器；它也随 `make script-test` 执行。

测试范围见[测试指南](testing.md)。附加参数使用 `make tui ARGS='--prompt hello'`。`make release` 输出至 `target/release`，`make docs` 生成 Rust API 文档。

`make smoke` 还验证可选轨迹导出：本地接收端返回 503 时 Agent 正常返回，Core 退出后独立上传器继续补传，并验证关闭开关。测试还覆盖 401 失败记录在停用后 5 秒自动节流窗口内重新启用、worker 被强杀后的首次显式重试，以及并发重试保持单一 worker、串行发送和无重复接收。可单独运行 `node scripts/trajectory-smoke.mjs`；设置 `AREAL_TRAJECTORY_FIXTURE_OUTPUT` 可保存真实 OTLP protobuf 供接收端互通测试，内容仅为本地测试数据。设置 `AREAL_TRAJECTORY_SMOKE_OUTPUT` 可保存 JSON 验收记录，包含真实启动时间、重试时距和并发观察。

`pnpm --dir clients/gui run test:trajectory-native` 使用隔离的本地模型/接收端，验证真实桌面后端、Core、Runtime 和上传器：从关闭启动后启用，等待当前任务完成再安全重启；停用保留失败副本；重新开启自动补传。回归证明启停和送达不变量，不用于推断整体 Agent 能力提升。

`node scripts/trajectory-semantics-smoke.mjs` 使用真实 owned Core/Runtime 与本地模型、接收端，覆盖多轮工具、子 Agent、同线程换模型、失败和流式取消。`make smoke` 包含此检查；HTTP 模型输入与 OTLP protobuf 默认保存到 `out/trajectory-semantics/`，可用 `AREAL_TRAJECTORY_SEMANTICS_OUTPUT` 改写目录，供接收端逐条核对。脚本使用独立临时 home、状态和工作区，不读取用户配置。

`python3 scripts/tui-local-smoke.py` 在真实 owned TUI/Runtime 中注入隔离的无效轨迹接收地址，验证异常提醒不遮住请求状态，并继续执行多轮、工具、取消和恢复；导出 worker 不启动。该检查属于 `make harness-smoke`。GUI 的状态轮询、协议投影与真实界面检查见 [GUI 验证入口](../../clients/gui/README.md#生命周期)。

项目使用 [Apache-2.0](../../LICENSE)。Cargo workspace 和 npm 包声明同一许可证；两套 SDK 携带 LICENSE，`scripts/package.py` 将许可证复制到桌面包并记录校验和。第三方材料保留原有许可与版权说明。

## 依赖与风格

Rust 使用 `--locked`，升级同时更新清单和锁文件；Cordis 还需同步 [pins.json](../../upstream/pins.json)，见[升级指南](cordis.md)。npm 使用 `npm ci --ignore-scripts`；Python 使用 `uv sync --locked --only-group dev`。不使用临时下载的全局格式工具。冻结的第三方题目与 oracle 不参与批量格式化。

Rust 使用 rustfmt/Clippy；TS/JS/CSS/HTML 使用锁定 Prettier；自有 Python 使用 Ruff。遵循 `.editorconfig`。新注释使用中文解释约束与原因；已有准确英文不机械翻译。

文档按[文档目录](../README.md)分类，同次修改更新中英文。README 只保留简介与导航；API 放在 `docs/api/`；历史结果放在 `docs/benchmarks/reports/`。移动页面同步修复引用。图表同步维护 draw.io 和 SVG/已有 PNG，遵循[图表规范](../design/STYLE_GUIDE.md)。

Homebrew/Linux 发行产物、安装验收与 draft 发布流程见[发行流程](releasing.md)。

## 桌面 GUI

页面、组件、布局、样式、动效和 UI 文案变更先读[设计系统入口](../../clients/gui/design-system/README.md#开工顺序)。增量审计随 GUI `verify` 执行；本地和 CI 的比较基线、覆盖与限制见[增量设计检查](../../clients/gui/design-system/automation.md#增量设计检查)，交付按[完成条件](../../clients/gui/design-system/governance.md#完成条件)报告设计选择和证据。

GUI 使用独立 pnpm 11.7.0 workspace。运行 `make gui-install`、`make gui-build`、`make gui-smoke`；启动、打包与隔离配置见 [GUI 指南](../../clients/gui/README.md)。

PR CI 以包含 runner 排队的 10–15 分钟端到端反馈为目标。GUI smoke 复用绑定同一 SHA 的 debug 构建，最多四个场景并发。`make verify-native` 先构建，再以四个 Make worker 运行既有 launcher、Runtime、Harness、Desktop API 和 Workgroup 验收组；公共构建及 SDK 前置在对应消费者启动前完成。验收命令保持不变，PR 关键路径不执行发行打包。托管 runner 排队与冷缓存仍可能超出目标，应测量实际流水线耗时，不能用超时设置冒充性能达标。CLI/GUI 完整打包、安装升级验收、签名、公证、上传及频道同步归本地发行流程。

`make setup-node` 仅安装锁定的 Node 开发依赖，供不运行格式检查的原生 CI 使用；本地完整开发仍使用 `make setup`。

## 本机 Rust 共享缓存

可选使用固定版本 [mr-boxington](https://github.com/jdx/mr-boxington) 复用不同工作树的编译结果。项目继续使用 `rust-toolchain.toml` 中的 Rust 版本；`.mbx.toml` 关闭 build.rs 执行结果缓存，保留 Git 修订、源码哈希等构建身份的正常生成与校验。普通 Cargo 和 CI 无需安装 mbx。

```sh
cargo install mbx --version 1.26.0 --locked
mbx settings set build_script_execution false
mbx settings set target.views false
mbx settings set gc.max_total_size 40GiB
mbx settings set gc.min_free_size 30GiB
mbx settings set display plain
mbx settings set savings plain
mbx setup
```

这些 settings 写入本机用户配置，不属于项目 `.mbx.toml`；本机也关闭 build.rs 执行结果缓存，以覆盖尚未合并项目配置的旧工作树。按 `mbx setup` 输出将官方 Cargo shim 目录放到 `PATH` 前部；终端、Codex 和 Python/Node 子进程都需继承该路径。通过 `command -v cargo`、`mbx setup --status` 和 `mbx doctor` 确认入口，再继续使用 `make build`、`make check`、`make test` 等原命令。仅安装 mbx 不会接管现有 Cargo 调用；也不要将所有工作树指向同一个 `CARGO_TARGET_DIR`。

`target.views=false` 保留各工作树的真实 `target` 目录，因此不会自动迁移、回收固定 Core/Runtime 路径，也没有独立的 check/clippy lane。40 GiB 是 mbx 所管理数据的逻辑容量回收目标，30 GiB 是空闲空间回收线，均非硬配额；普通 target、Electron 应用及完整发布包仍按下述规则清理。用 `mbx cache stats` 查看用量，`mbx gc --dry-run` 预览回收，`mbx explain --last` 查看当前工作树的复用情况。

不要对常驻 Core、固定路径验收或发布产物执行递归 `mbx adopt`。托管目录的租约不保护直接从 target 启动的二进制和 mbx 退出后仍存活的子进程。Rust 1.94 可使用共享编译结果，但不支持要求 rustc 1.98 的跨工作树私有增量 seed 或要求 Cargo 1.100 的 target unit seed。移除 shim 的 PATH 激活即可恢复普通 Cargo；不会删除现有产物或共享缓存。

### 临时工作树缓存回收

共享缓存不会限制普通 `target` 的增长。临时工作树使用同一清理入口的预算模式，默认预览：

```sh
make artifact-cleanup ARGS='--temporary-worktrees --cache-budget-gib 40 --min-free-gib 30 --min-idle-hours 72 --report /private/tmp/worktree-cache-preview.json'
```

审阅后追加 `--apply`，并为每次运行指定独立报告路径。该模式只选择本仓 Git 登记中仍存在的次级工作树，主工作树始终排除，不接受 `--root` 或 `--no-worktrees` 覆盖。它只回收已识别 Cargo profile 下的 `deps`、`incremental`、`build` 和 `.fingerprint`；保留 profile 中的可执行文件、shell、完整包、delivery 目录、依赖和符号链接。失效工作树登记只跳过，不移除。

40 GiB 是所有次级工作树缓存的分配块估算总预算，独立于 mbx 共享缓存的 40 GiB。先保护可复用缓存：有暂存、未暂存或未忽略的新文件的工作树整组保留；干净工作树的 profile 只有连续闲置至少 72 小时才参与预算回收，窗口可用 `--min-idle-hours` 调整。最近活动取 profile 内文件和目录的最新写入时间，以及该工作树 Git index、HEAD reflog 的修改时间，覆盖目录时间未改变的文件重写及近期提交/切换。检查 Git 时禁用可选锁，避免扫描自身刷新 index。它不是精确的读取 LRU。

仅在超预算或磁盘低于 30 GiB 时，按最近活动从旧到新选择符合条件的冷缓存。磁盘压力不覆盖闲置窗口或开发改动保护，避免在构建间隙删除依赖与 fingerprint、导致下次完整重编译。删除前持有 Cargo 锁并再次检查复用状态和占用；同一 profile 内任何打开文件或该工作树中的构建/调试进程都会阻止整组回收。单个 profile 无法统计时保留并记录；无法确认 Git 或文件活动时保留并以非零退出。报告的 `cache_policy.min_idle_hours` 和 `retained-recent`、`retained-worktree-dirty` 状态说明保留原因。受保护缓存和范围外数据可能使预算或空闲线无法满足，报告会列出剩余压力。APFS 共享块使分配块估算不同于实际释放量。

可在 Codex 为本聊天配置每 30 分钟调用一次该命令的心跳，追加 `--apply` 并保存独立报告；无删除或无需处理的占用跳过保持安静，仅通知实际回收、失败或无法缓解的磁盘告急。自动化复用此模式，不调用全量包清理，也不停止构建或服务。它不会自动迁移 target；主工作树缓存和完整 GUI/Core 包继续使用下述按需清理入口。

## 验证产物保留

### 按需回收主工作树和自定义 target

磁盘压力来自主工作树、自定义 `CARGO_TARGET_DIR` 或未登记的构建副本时，临时工作树模式不会覆盖这些目录。使用独立的中间文件模式预览，默认只选当前清理脚本所属主仓的 `target`：

```sh
make artifact-cleanup ARGS='--rust-intermediates --report /private/tmp/rust-primary-preview.json'
make artifact-cleanup ARGS='--rust-intermediates --target-root /path/to/checkout/custom-target --report /private/tmp/rust-custom-preview.json'
```

`--target-root` 可重复，每个路径必须是 Cargo checkout 内的真实目录；只识别带 `.cargo-lock` 的 profile。该模式不运行 GUI/Core 包保留和散装产物删除，也不隐式扫描其他工作树；与 `--temporary-worktrees`、`--root`、`--no-worktrees` 互斥。审阅后用新的报告路径追加 `--apply`。它逐文件回收四类缓存中的普通中间文件，保留可执行位文件、动态/静态库、shell、发布归档、带 manifest 的包、应用、依赖目录和符号链接；profile 顶层文件保留。整个 profile 的打开文件、构建/调试进程和 Cargo 锁仍会阻止回收，删除前复核文件身份，保留项变化或删除失败时停止并记录部分结果。

报告列出所选范围、排除范围及 `free_before_bytes`、`free_after_bytes`；前后空闲读数受并发写入影响，不能用分配块估算替代。所有模式拒绝覆盖已有报告。自动回收继续只使用临时工作树模式；主仓、自定义构建目录、Codex 会话/取证文件、依赖、安装目录及发布包需要各自的保留规则和显式范围授权。

运行 `make artifact-cleanup` 预览 `~/Documents/Codex` 及本仓已登记工作树中的 AReaL 产物，默认只读。GUI 以打包记录识别轮次并检查可执行文件及 Core 的完整性，匹配的应用和 ZIP 副本归入同轮。独立 Core 则保留最新 5 个完整且通过清单校验的版本包，以构建身份和文件哈希去重。Cargo profile 是可变构建输出，不作为历史轮次计数。只有某 profile 的三个二进制均匹配已知完整包、且已有至少 5 个校验通过的版本包时，才清理其散装产物；无法识别的产物保留。

Rust 的 `deps`、`incremental`、`build`、`.fingerprint` 独立于版本保留管理。仅把仓库当作工作目录不阻止缓存清理；构建/调试器进程、候选目录内打开的文件及持有的 Cargo 锁会阻止清理。使用中的 profile 产物会一起保护伴随二进制。保留版本包中的 GUI/Core 运行文件保留，清缓存可能损失生成的调试信息。无法识别的归档和小型打包验收记录保留。自定义 `target/delivery-*` 仅按已识别的包处理，不把整目录当作缓存。

单独扫描使用 `python3 scripts/artifact-cleanup.py --root /path/to/artifacts --no-worktrees --json`；`--root` 可重复，`--keep` 修改保留上限。`--report /path/outside/scanned/roots/preview.json` 保存完整清单。空间按已分配块估算并排除路径重叠；硬链接、APFS 克隆和快照可能降低实际回收量。

审阅预览后，显式使用 `--apply --report /path/outside/scanned/roots/result.json` 执行删除。执行会持有 profile 的 Cargo 锁文件排他锁、复查活动，并在每项删除前后记录结果；锁文件保留，检查失败时跳过路径。无法检查进程时阻止删除。命令不停止进程，不移除工作树、源码、配置和历史。失败以非零退出；结果文件记录已完成与可能中断的删除，部分失败后先检查记录并重新预览。命令本身不安装定时任务。
