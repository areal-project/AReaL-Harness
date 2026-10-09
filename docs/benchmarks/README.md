**中文** | [English](README.en.md)

# Docker 基准测试

`scripts/perf` 比较实际 Harness、Codex、Claude Code 的端到端任务完成表现。Harness 启动本仓库 TUI/Core/Runtime，adapter 只负责启动与统计，不维护另一套模型循环。容量回归见[测试](../development/testing.md)。

## 环境与首跑

需要 Python 3.11+、Docker/BuildKit 和足够镜像空间。正式比较使用原生 Linux amd64；跨架构模拟开销不作为同平台基线。宿主须允许 Bubblewrap 的 user/PID namespace 和 seccomp；沙箱 smoke 失败需排查，不能关闭沙箱继续评分。

```sh
./scripts/perf self-test
./scripts/perf build
./scripts/perf smoke-loop
cp tests/perf/model.example.toml tests/perf/model.toml
read -r -s AREAL_PERF_API_KEY
export AREAL_PERF_API_KEY
./scripts/perf doctor --model-config tests/perf/model.toml
./scripts/perf run --task lite \
  --runner harness --runner codex --runner claudecode \
  --model-config tests/perf/model.toml --repeat 5 --seed 163
```

self-test 和 smoke-loop 无需真实模型凭据；smoke-loop 使用实际 CLI 与本地 fixture。编辑 model.toml 指向可访问服务，再读取所需密钥；无认证服务可省略密钥步骤。文件已 Git 忽略。只需 Harness 时，build 可传 `--without-codex --without-claudecode` 并在 run 只选 harness。

交互入口 `make perf` 选择套件/runner/重复次数并输出汇总。交互模式将 trial 失败作为结果，配置/编排错误才非零；自动化使用 run，默认 trial 失败非零，显式 --allow-failures 可继续汇总。

## 模型与镜像

perf TOML 独立于 Core 配置：model、base_url、protocol、api_key_env；protocol 为 completions/responses/anthropic。base_url 是 API 根路径，网关追加 endpoint；Core 的模型 endpoint 则是完整 URL，不能混用。localhost 在容器网关映射为 host.docker.internal。

LLM-Rosetta sidecar 统一路由到上游；runner_upstreams 可为不同 CLI 配置原生协议，模型和凭据共享。parameters 支持 reasoning_effort/reasoning_summary/verbosity，runner 无对应字段时记录未应用，不宣称相同名称代表等价预算。

```sh
docker build -f tests/perf/gateway.Dockerfile -t areal-perf-gateway:source-0.13.0 .
./scripts/perf doctor --model-config tests/perf/model.toml \
  --gateway-image areal-perf-gateway:source-0.13.0
```

需要固定源码网关时对 run 也传同一 gateway-image。默认 runner 版本固定在 [Dockerfile](../../tests/e2e/docker/Dockerfile)，构建记录镜像 ID 与源码指纹；准备和 Runtime smoke 位于解题计时之外。Linux Harness 使用 outer-container-perf，见[部署边界](../guides/runtime.md)。

<a id="suites"></a>
## lite 与 pro

| 套件 | 环境与评分 |
|---|---|
| lite | 仓库本地任务、每次独立工作区，Agent 后用无网络独立 grader 容器评分 |
| pro | 20 个固定外部 Env 的题面/oracle；用仓库内 Dockerfile 和初始输入构建公开 amd64 环境；Agent 退出后同容器注入测试 |

pro 来源与约束见[快照说明](../../tests/perf/suites/pro/README.md)。fetch-pro 仅校验本地题集；build-pro 无需模型即可构建环境，run 会自动构建所选题目并缓存。首次构建需访问公开镜像和软件源，无需内部凭据：

```sh
./scripts/perf fetch-pro
./scripts/perf build-pro --case tbpc002004-match-device-observation-lines
./scripts/perf run --task pro --runner harness --runner codex --runner claudecode \
  --model-config tests/perf/model.toml --repeat 1 --seed 163 \
  --output target/perf/formal --allow-failures
```

`--case ID` 可重复选择子集，省略运行全部。pro 使用 areal-pro-strict-v1：非空测试全部通过且无跳过才得 1；保留无效评分和失败原因，与平台 core-only 分数不直接比较。模型凭据仅进入网关，不给 Agent/评分进程。

## 恢复与结果

run.json 逐次保存，report.json 为汇总，trials/ 保存日志、工作区、评分和事件。中断后给原命令加 `--resume-run <batch-directory>`，保持源码、配置和镜像一致；已完成 trial 不重跑。改变环境应创建新批次。

```sh
./scripts/perf report target/perf/formal/pro/RUN_ID
```

--fail-fast 在首个失败后暂停保留证据。保存整个批次的脱敏配置、源码/题集摘要、镜像身份和尝试记录。判读与公平性见[方法](methodology.md)，旧结果见[报告索引](reports/README.md)。任务格式以 [lite fixture](../../tests/perf/cases/) 和解析器 [perf.py](../../tests/perf/perf.py) 为准。

## Arena 按需公开输入

原生 Runner 使用 `lazy_files`：将 `ARENA_QUERY_PATH`、可选的冻结 Harness 规则和 `/problem_assets` 的公开文件物化到 `workspace://scratch/public-inputs/`；首轮只提交任务入口和 JSONL 附件清单路径，启动封套最多 64 KiB，不内联媒体或题面全文。清单保留原路径/别名、MIME 提示、字节数和 SHA-256；相同内容共享副本。实际图片格式、尺寸和动画覆盖由 Core 的 `image_read` 解码并报告。shell 使用清单里的实际路径，不能将 workspace URI 当 shell 路径。输入及诊断副本位于仓库/交付目录外。

Runner 通过 Runtime `--read-only-path` 保护输入并在运行结束检查摘要；现有 Graybox public 包保持原路径和输出收集方式。输入身份、Case/Env/Reward 不变。附件文件、入口字节和完整性结果分别保存在 `public-inputs/`、`input-delivery.json`、`input-media.json`，无 Base64 或凭据进入诊断。发布包需包含 `public_inputs.py` 和同次源码构建的 Rust 二进制。

冻结 settings 支持 `max_request_bytes`（默认 16 MiB 本地保护值，发布前按实际网关限额设置）与 `context_compaction_enabled`（默认 false，单独评估后启用）。传输字节与上下文 token 独立；50 MiB 原生分页和长轨迹压缩不属于输入故障修复的验收结论。

离线验证运行 `python3 -m unittest discover -s integrations/envarena`、`cargo test --locked -p areal-engine --lib` 和 `python3 scripts/arena-input-smoke.py --bin-dir target/debug`。模型桩验证真实 CLI/Core/Runtime 输入读取、PNG/GIF 视觉内容、只读拒绝及旧封套超限诊断，不代表四题真实模型复跑或评分通过。线上验收需冻结新 Harness ref/hash，保留原题和评分器，逐题区分输入链路成功、任务终态及原 Reward。
