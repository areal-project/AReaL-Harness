**中文** | [English](README.en.md)

# 开发指南

先阅读[架构](../design/architecture.md)和[开发规范](../../AGENTS.md)。所有命令从仓库根目录执行。

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

## 验证入口

| 修改范围 | 命令 |
|---|---|
| 格式 | `make fmt` / `make fmt-check` |
| 静态检查 | `make lint` |
| Rust / SDK / 脚本 | `make test` / `make sdk-test` / `make script-test` |
| 常规回归 | `make verify` |
| 原生集成 | `make verify-harness`，包含常规回归 |
| 统一委派集成 | `make unified-execution-smoke`：真实 Runtime 的并行候选组合、交付回执、父任务权限、取消与恢复；已包含在 `make harness-smoke` / `make verify-native`；Linux CI 在允许 Bubblewrap user namespaces 的受控容器中执行，`make verify` 保持跨平台常规回归 |
| CI 原生增量 | `make verify-native`，仅运行原生后端与 Harness 集成 smoke |
| 可选 EnvArena 适配器 | `make envarena-check` / `make envarena-smoke`；不属于默认检查 |
| 容量 | `make capacity`，独立运行 |
| 仅文档 | `python3 scripts/check-docs.py`，同时核对命令与实现 |

统一委派冒烟默认使用 `target/debug`；可用 `AREAL_UNIFIED_BIN_DIR` 指定完整安装包的 `bin` 目录，用 `AREAL_UNIFIED_EVIDENCE_DIR` 保存完整 Core/Runtime stderr。独立 worker 始终使用 native 沙箱；Linux 需要可运行的 Bubblewrap 与 user/mount/PID namespaces，不继承父启动器的 full-access 模式。

`make integration-boundaries` 检查产品、发行入口和默认 Make 依赖图不加载可选平台适配器；它也随 `make script-test` 执行。适配器 Python 源码的格式、静态检查和单元测试由 `make envarena-check` 单独维护。

测试范围见[测试指南](testing.md)。附加参数使用 `make tui ARGS='--prompt hello'`。`make release` 输出至 `target/release`，`make docs` 生成 Rust API 文档。

`make smoke` 还验证可选轨迹导出：本地接收端返回 503 时 Agent 正常返回，Core 退出后独立上传器继续补传，并验证关闭开关。测试还覆盖 401 失败记录在停用后 5 秒自动节流窗口内重新启用、worker 被强杀后的首次显式重试，以及并发重试保持单一 worker、串行发送和无重复接收。可单独运行 `node scripts/trajectory-smoke.mjs`；设置 `AREAL_TRAJECTORY_FIXTURE_OUTPUT` 可保存真实 OTLP protobuf 供接收端互通测试，内容仅为本地测试数据。设置 `AREAL_TRAJECTORY_SMOKE_OUTPUT` 可保存 JSON 验收记录，包含真实启动时间、重试时距和并发观察。

`node scripts/trajectory-semantics-smoke.mjs` 使用真实 owned Core/Runtime 与本地模型、接收端，覆盖多轮工具、子 Agent、同线程换模型、失败和流式取消。`make smoke` 包含此检查；HTTP 模型输入与 OTLP protobuf 默认保存到 `out/trajectory-semantics/`，可用 `AREAL_TRAJECTORY_SEMANTICS_OUTPUT` 改写目录，供接收端逐条核对。脚本使用独立临时 home、状态和工作区，不读取用户配置。

`python3 scripts/tui-local-smoke.py` 在真实 owned TUI/Runtime 中注入隔离的无效轨迹接收地址，验证异常提醒不遮住请求状态，并继续执行多轮、工具、取消和恢复；导出 worker 不启动。该检查属于 `make harness-smoke`。GUI 的状态轮询、协议投影与真实界面检查见 [GUI 验证入口](../../clients/gui/README.md#生命周期)。

项目使用 [Apache-2.0](../../LICENSE)。Cargo workspace 和 npm 包声明同一许可证；两套 SDK 携带 LICENSE，`scripts/package.py` 将许可证复制到桌面包并记录校验和。第三方材料保留原有许可与版权说明。

## 依赖与风格

Rust 使用 `--locked`，升级同时更新清单和锁文件；Cordis 还需同步 [pins.json](../../upstream/pins.json)，见[升级指南](cordis.md)。npm 使用 `npm ci --ignore-scripts`；Python 使用 `uv sync --locked --only-group dev`。不使用临时下载的全局格式工具。冻结的第三方题目与 oracle 不参与批量格式化。

Rust 使用 rustfmt/Clippy；TS/JS/CSS/HTML 使用锁定 Prettier；自有 Python 使用 Ruff。遵循 `.editorconfig`。新注释使用中文解释约束与原因；已有准确英文不机械翻译。

文档按[文档目录](../README.md)分类，同次修改更新中英文。README 只保留简介与导航；API 放在 `docs/api/`；历史结果放在 `docs/benchmarks/reports/`。移动页面同步修复引用。图表同步维护 draw.io 和 SVG/已有 PNG，遵循[图表规范](../design/STYLE_GUIDE.md)。

Homebrew/Linux 发行产物、安装验收与 draft 发布流程见[发行流程](releasing.md)。

## 桌面 GUI

GUI 使用独立 pnpm 11.7.0 workspace。运行 `make gui-install`、`make gui-build`、`make gui-smoke`；启动、打包与隔离配置见 [GUI 指南](../../clients/gui/README.md)。

`make setup-node` 仅安装锁定的 Node 开发依赖，供不运行格式检查的原生 CI 使用；本地完整开发仍使用 `make setup`。

### RSI Artifact：单 query 与人工选择

`/rsi-goal QUERY` 通过 `workflow: "rsiArtifact"` 显式创建 RSI 目标，普通 `/goal` 不变。第一阶段使用 baseline、structured、critic-and-revise 三个固定、可查看的 Harness 模板，基于同一份冻结的工作区输入，最多并行运行三个候选。执行使用原生 `isolatedWrite` 边界；不支持隔离的部署会在创建前拒绝，不降级为共享写。

第一阶段每个候选交付一个不超过 1 MiB 的 UTF-8 `artifact.md`，代码可放入代码块。候选只能修改自己的约定产物路径；原项目不接收自动写回。Core 数据目录的 `rsi/<goalId>/<candidateId>/` 保存 `request.json`、`harness.md`、`metadata.json` 和结算后的 `result.json`；原生执行服务另存隔离工作区、产物与 Runtime 清理回执。候选投影包含 harness、状态、工作区和产物路径、摘要、run/task 身份、起止时间和错误。

GUI 的新建聊天和已有空闲主聊天均支持输入命令，或在功能菜单选择“RSI 产物对比”。候选卡片可查看 Harness/运行信息、分页读取产物和选择 winner。TUI 使用 `/rsi-refresh` 查询、`/rsi-artifact candidate-1 [OFFSET]` 读取、`/rsi-select candidate-1` 选择；状态与摘要显示在右侧面板，`/tasks` 可展开完整候选与产物内容。`/goal-clear` 在候选结算后清除当前目标。

全部候选结算后，有成功产物则进入 `awaitingSelection`，否则进入 `failed`。单候选失败不取消其他候选。选择只持久化 winner 引用，不自动应用产物；重复选择当前 winner 不改变版本，过期 revision 返回冲突。GUI 重开后从 Core 投影恢复；Core 重启仅核对原执行，未完成候选保守标记失败，不重新派发。已完成候选和 winner 保留。运行期间不接受普通 Turn，选择后可继续聊天。

当前已支持评测反馈、显式有界分叉和版本探索树，详见 [RSI 反馈分叉](../guides/rsi-evolution.md)。不做自动质量评分、自动 winner 或跨任务收益推断；模板也不是在线 research agent。执行器只核对写入范围、产物存在性和资源结算，不评价产物质量。可显式设置 token/time 预算；不接受 `inferLimits: true` 或 `maxTurns`。

验收命令（先构建 workspace 与 GUI）：

```bash
cargo test -p areal-engine --test rsi_goals
node scripts/rsi-goal-smoke.mjs
cd clients/gui && corepack pnpm test:rsi
```

两个 smoke 使用脚本模型和真实 Core/Runtime；GUI smoke 驱动真实 Electron 输入、读取、选择及重启。可用 `AREAL_RSI_EVIDENCE_DIR` 指定回执和截图目录。它们验证执行契约，不衡量供应商模型的产物质量。
