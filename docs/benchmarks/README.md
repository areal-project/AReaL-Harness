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

| 套件 | 环境与评分                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| lite | 仓库本地任务、每次独立工作区，Agent 后用无网络独立 grader 容器评分                                             |
| pro  | 20 个固定外部 Env 的题面/oracle；用仓库内 Dockerfile 和初始输入构建公开 amd64 环境；Agent 退出后同容器注入测试 |

pro 来源与约束见[快照说明](../../tests/perf/suites/pro/README.md)。fetch-pro 仅校验本地题集；build-pro 无需模型即可构建环境，run 会自动构建所选题目并缓存。首次构建需访问公开镜像和软件源，无需内部凭据：

```sh
./scripts/perf fetch-pro
./scripts/perf build-pro --case tbpc002004-match-device-observation-lines
./scripts/perf run --task pro --runner harness --runner codex --runner claudecode \
  --model-config tests/perf/model.toml --repeat 5 --seed 163 \
  --output target/perf/formal --allow-failures
```

`--case ID` 可重复选择子集，省略运行全部。pro 使用 areal-pro-strict-v1：非空测试全部通过且无跳过才得 1；保留无效评分和失败原因，与平台 core-only 分数不直接比较。模型凭据仅进入网关，不给 Agent/评分进程。

## 恢复与结果

run.json 逐次保存，report.json 为汇总，trials/ 保存日志、工作区、评分和事件。中断后给原命令加 `--resume-run <batch-directory>`，保持源码、配置和镜像一致；已完成 trial 不重跑。改变环境应创建新批次。

```sh
./scripts/perf report target/perf/formal/pro/RUN_ID
```

--fail-fast 在首个失败后暂停保留证据。保存整个批次的脱敏配置、源码/题集摘要、镜像身份和尝试记录。判读与公平性见[方法](methodology.md)，旧结果见[报告索引](reports/README.md)。任务格式以 [lite fixture](../../tests/perf/cases/) 和解析器 [perf.py](../../tests/perf/perf.py) 为准。

## 原生平台接入

外部评测平台使用标准原生发布包及 [CLI 契约](../api/claude-cli.md)。公开输入通过可重复的 `--read-only-path` 绑定保护；使用 `stream-json --include-native-events` 获取完整工具媒体和终态结构化错误。短输入入口、附件清单与完整性检查、模型设置、生命周期期限、产物收集和 Reward 执行由平台负责。

旧 EnvArena Python runner、zipapp 打包器及专用工作流已移除。通用文件/图像工具、只读保护和请求预算继续由 Core/Runtime 与原生 CLI 测试覆盖。平台验收应在原生 Linux 上运行完整发布包，区分模型桩的输入交付验证与真实模型任务评分。

正式策略比较默认每题每方重复 5 次；跨任务、跨来源和四领域确认的最低规模、区间估计及停止规则见[评测方法](methodology.md#重复次数覆盖面与证据规模)。单题、少量题或显式 `--repeat 1` 只作 smoke/探索；当前工具不自动证明泛化。原生平台配置须显式冻结，产品不根据 Env/Task/Benchmark 身份扩大预算或附加解题策略。

默认重复次数由 1 改为 5，也适用于单个 Runner 与 fixture；只需链路 smoke 时显式传 `--repeat 1`。恢复历史批次须按已保存计划显式给出原重复数，不能用新默认值改变冻结调度。
