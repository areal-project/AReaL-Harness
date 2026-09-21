**中文** | [English](testing.en.md)

# 测试

依赖安装见[开发指南](README.md)。常规测试使用临时目录、动态 loopback 端口和确定性模型，无需真实模型凭据。

| 入口 | 范围 |
|---|---|
| `make verify` | Cordis pin、格式、静态检查、Rust workspace、两套 SDK、Python、文档和 TUI smoke |
| `make script-test` | 启动器、perf 统计/证据与文档链接/语言配对 |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | 并发原语 |
| `make verify-runtime` | Runtime 单元测试与真实文件、进程、权限和关闭 smoke |
| `make verify-harness` | verify 后顺序运行 Runtime、完整 Harness、桌面 API 和 Workgroup smoke |
| `make examples-desktop-api` | [直接 API、CLI、Skill 与搬迁打包产物](../examples/desktop-api.md) |
| `make workgroup-smoke` | 独立 Runtime 写入、组合验收、命令期限与失败后结算 |

原生 smoke 需要 macOS Seatbelt，不能用无沙箱执行代替失败。Linux CI 使用受控容器。默认 `cargo test` 不运行显式忽略的原生 Workgroup 和容量用例。

Linux 宿主常规检查使用 `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`。原生后端测试要求容器边界；CI 随后构建 Dockerfile 的 `runtime-tests` 目标，在带 Bubblewrap 的受控容器中实际运行全部后端测试，不能仅排除后就视为完成验收。

## 恢复与研究 Agent

```sh
cargo test --locked -p areal-engine --test truncated_usage --test http_model --test context --test tools --test async_agents --test recovery
python3 -m unittest discover -s scripts/tests
python3 scripts/native-tools-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
python3 scripts/native-agents-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
```

原生工具/Agent smoke 使用本地固定响应 HTTP 模型、统一 launcher 与临时工作区，无需外部模型。覆盖文件 CAS、搜索、验证 receipt、图像，以及不委派、单 Worker、同步等待、预算失败、父取消和默认异步；异步用例要求三个 Worker 请求结束前父任务继续推进，并检查主/子采样参数。流测试覆盖 length 同帧/尾帧 usage、EOF/取消、不重放 UNKNOWN、压缩后句柄与跨 Turn 边界。

Linux 需要 Bubblewrap user/PID namespace、seccomp，以及 Python、Bash、rg。也可用公开 Dockerfile：

```sh
docker build -f tests/e2e/docker/Dockerfile \
  --build-arg INSTALL_CODEX=0 --build-arg INSTALL_CLAUDE_CODE=0 \
  -t areal-native-smoke .
for smoke in native-tools-smoke native-agents-smoke; do
  docker run --rm --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined \
    --mount "type=bind,source=$PWD,target=/repo,readonly" -w /repo \
    --entrypoint python3 areal-native-smoke \
    "scripts/$smoke.py" --bin-dir /usr/local/bin --sandbox-profile outer-container-perf
done
```

外层容器放宽项仅适用于显式选择的受控 profile，命令仍在 Bubblewrap 内执行。macOS 的 `/usr/bin/python3` 可能经 Xcode 选择器读取未授权配置，不应为 smoke 自动扩大沙箱权限。TUI 重连 smoke 等待 `live` 订阅后再提交，连接和历史缓存可见不代表权威快照已恢复。

## 容量

| 命令 | 负载 |
|---|---|
| `make capacity-primitives` | 20,000 个异步任务的推进与取消 |
| `make capacity-core` | 10,000 个子 Agent、实际持久化与受控模型许可 |
| `make capacity-workgroup` | 32 个真实 Runtime、独立写入与组合检查，需 macOS |

`make capacity` 顺序执行，默认 verify 不包含容量测试。结果须注明硬件、构建模式、存储和模型替身，不能当作真实 LLM 吞吐。

## CI 与契约

[CI](../../.github/workflows/ci.yml) 在 macOS 执行原生 Harness，在 Linux 执行常规回归和 Docker sandbox/文件所有权检查，独立检查 Rust/npm 依赖公告。工作流固定 action commit、使用只读权限并保留失败日志；是否通过以对应提交的运行结果为准。

`make schemas` 更新固定 Codex schema，`make desktop-schemas` 更新桌面 schema；同时维护类型、调用方与契约。真实模型、GUI、第三方 daemon、签名/公证和其他平台不由本地 fixture 代替验收。性能测试见[基准指南](../benchmarks/README.md)。
