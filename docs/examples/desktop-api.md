**中文** | [English](desktop-api.en.md)

# 桌面 API 与发行验证

示例使用真实 Core、app-server、存储与 Runtime，模型在 HTTP/SSE 边界使用本地 fixture。无需模型密钥；原生集成面向 macOS，不能代替真实 GUI/第三方 daemon 验收。

```sh
make setup
make examples-desktop-api
node examples/desktop-api/run.mjs --list
node examples/desktop-api/run.mjs approval-gate
node examples/desktop-api/cli.mjs
node examples/desktop-api/skills.mjs
node examples/desktop-api/soak.mjs
make desktop-schemas
```

| 入口 | 检查 |
|---|---|
| [run.mjs](../../examples/desktop-api/run.mjs) | 版本、认证、resume、Profile、媒体、审批、队列、共享终端、模型切换、MCP、Agent/Workflow |
| [cli.mjs](../../examples/desktop-api/cli.mjs) | 非交互 argv/JSONL、恢复、权限、信号、断管与任务凭据 |
| [skills.mjs](../../examples/desktop-api/skills.mjs) | 目录覆盖、无效全局 Skill 告警隔离、大图片按需读取、显式 Profile 当前文件读取与恢复 |
| [soak.mjs](../../examples/desktop-api/soak.mjs) | 搬迁打包产物、精简 PATH、系统 Python、预算耗尽、归档和 epoch 轮换 |
| [native-host.mjs](../../examples/desktop-api/native-host.mjs) | 真实文件/进程 broker 与外国句柄拒绝 |

`AREAL_SOAK_ROUNDS` 设置轮数（默认 12），`AREAL_SOAK_REPORT` 指定 JSON 报告，`AREAL_PACKAGE_PROFILE=release` 验证已构建 release 产物。报告记录实际源码、平台、资源曲线和清理结果。

## 显式部署 Profile

`--desktop-config /absolute/deployment.json`：

```json
{"profiles":[{"id":"example","revision":"v1","displayName":"Example","instructions":"Complete the task and verify the result.","skills":[{"id":"example","revision":"v1"}],"readOnly":false}],"skills":[{"id":"example","revision":"v1","root":"skills/example"}]}
```

root 相对清单目录，必须含 SKILL.md；Renderer 只传 ID/revision，不注册任意宿主路径。清单只登记引用和元信息，Profile 不冻结文件内容；同一引用后续读取当前磁盘文件。不需要显式清单时可用[自动 Skill 发现](../guides/skills.md)。阶段 Workflow 和 Workgroup 策略见[指南](../guides/workgroups.md)。

真实 GUI、外部消费者任务生命周期、签名/公证和其他平台需独立验证。fixture 的通过不证明这些集成已完成。三个契约分别为[桌面 API](../api/desktop.md)、[Native Host](../api/native-host.md)和 [CLI](../api/claude-cli.md)。
