**中文** | [English](workgroups.en.md)

# Workgroup 使用

Workgroup 为写任务和验证器创建独立工作区/Runtime，使用生产 Engine，最终组合检查通过才算完成。适用于 macOS 可信宿主；共享工作区委派见 [Agent](../design/multi-agent.md)。

## 独立 CLI

先配置[模型](configuration.md)。以下 Python 示例需要一个已展开、无符号链接的可信工具链，含 `bin/python3`；输入源码须包含对应测试。

```sh
cargo build --locked --workspace
target/debug/areal-workgroup run \
  --workspace /absolute/source --state-dir /absolute/runs/new-run \
  --plan /absolute/plan.json --checks /absolute/checks.json \
  --runtime "$PWD/target/debug/areal-runtime" \
  --file-helper "$PWD/target/debug/areal-runtime-fs" \
  --toolchain /absolute/materialized-python \
  --strategy balanced --workers 2 --seconds 600
```

state-dir 必须是不存在的新目录，位于源码外；toolchain 与 attempt 存储不得相同或互为祖先。输入是快照来源，产物在 `<state-dir>/candidate/`，不会覆盖原 checkout。运行期间避免外部编辑初始源码。

## 计划与检查

`plan.json`:

```json
{"objective":"Implement a parser","tasks":[{"id":"parser","instruction":"Implement parse(text): parse JSON Lines into objects, reject non-object records, preserve order.","writes":["parser.py"],"depends":[],"checks":[[".toolchain/bin/python3","-B","-m","unittest","tests.test_parser"]]}]}
```

`checks.json`:

```json
[[".toolchain/bin/python3","-B","-m","unittest","discover","-s","tests"]]
```

writes 为精确相对文件名，不接受目录/glob/逃逸。depends 要求前置产物集成；integrationDepends 只阻止验收，可按约定提前实现；两者并集无环。最终 checks 必须非空且由可信调用方控制，不能把可修改的测试或 `true` 当质量保证。

模型规划使用 `--prompt-file` 代替 `--plan`，同时提供 `--write-scope`（精确路径 JSON 数组）。规划不能扩权，且计入根预算。

## 策略与预算

| 选项 | 默认与范围 |
|---|---|
| strategy | balanced；single 合为一个 Agent，contract 保留边界，cohesion 合并共享写，balanced 再合并小任务/串行边界 |
| workers / admission | 2（1–32）/ fixed；auto 限制未验收为 W+1，adaptive 在 W 内调整目标 |
| initial-workers | 0 自动选择；显式 1–32 只影响 adaptive |
| verification-batch | 4（1–32），合并已有就绪候选，不等待凑满 |
| repairs / integration-repair | 1（0–3）/ true，原授权与预算内修复 |
| seconds / command-timeout-ms | 600（1–86400）/ 300000（1–86400000） |
| max-model-requests | 128，规划/Worker/修复共享 |
| worker-context-bytes | 65536，0 关闭；裁剪模型视图，不删除历史 |
| worker-stall-rounds | 0 关闭；8–128 为实验性源码无变化检查点 |
| worker-tools | all 或 command；不改变 Runtime 权限 |

最多 64 任务，快照 16 MiB/10000 文件，单文件 2 MiB，制品 128 MiB；拒绝符号链接、硬链接和特殊文件。模型并发、Worker 上限和网关 RPM/TPM 不等价。Adaptive 是显式选项，不保证优于默认。

## 结果与服务

`run.json` 保存状态、head、验收与清理；`usage.json` 保留已知 token 和缺失统计。`candidate/` 只含接纳的源码，失败部分交付不算 completed。`areal-workgroup inspect /absolute/runs/new-run` 获取 owner 锁、校验摘要；崩溃运行变 UNKNOWN，不重放。SIGINT/SIGTERM 取消后仍等待清理。

TUI/server/launcher 可配置 `--workgroup-policy /absolute/policy.json --workgroup-toolchain /absolute/toolchain`，同时授权写入。策略包含 allowedWrites（或目录授权 allowedDirectories）、非空 checks，以及共享 workers/verifiers/activeGroups 和预算。模型不能修改该部署策略。

服务开放 workgroup_start/read/wait/revise/cancel/artifact，TUI 使用 `/groups`、`/group ID`、`/group-start FILE`。requestId 去重，计划修改带 expectedRevision；重连不取消客户端组，重启不重跑旧组。artifact 最多返回 4096 字节文件块及基线/候选摘要，应用回原目录仍需条件检查。

桌面 Workflow 是版本化计划，可按阶段配置 Profile、模型、Skill、工具和 readOnly；isolatedWrite 子 Agent 复用此服务。契约见 [Core API](../api/core.md#workgroups)，机制见[调度设计](../design/workgroups.md)。
