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

`run.mjs game-lite-profile` 验证无 Workflow Agent 的 Profile 工具实际调用；`run.mjs profile-workflow` 验证绑定 Workflow 自动启动、完成和恢复不重复启动。`cli.mjs` 验证 `exec --agent` 只暴露所选 Profile 允许的工具。

`AREAL_SOAK_ROUNDS` 设置轮数（默认 12），`AREAL_SOAK_REPORT` 指定 JSON 报告，`AREAL_PACKAGE_PROFILE=release` 验证已构建 release 产物。报告记录实际源码、平台、资源曲线和清理结果。

## 显式部署 Profile

`--desktop-config /absolute/deployment.json`：

```json
{"profiles":[{"id":"example","revision":"v1","displayName":"Example","instructions":"Complete the task and verify the result.","skills":[{"id":"example","revision":"v1"}],"readOnly":false}],"skills":[{"id":"example","revision":"v1","root":"skills/example"}]}
```

root 相对清单目录，必须含 SKILL.md；Renderer 只传 ID/revision，不注册任意宿主路径。清单只登记引用和元信息，Profile 不冻结文件内容；同一引用后续读取当前磁盘文件。不需要显式清单时可用[自动 Skill 发现](../guides/skills.md)。阶段 Workflow 和 Workgroup 策略见[指南](../guides/workgroups.md)。

真实 GUI、外部消费者任务生命周期、签名/公证和其他平台需独立验证。fixture 的通过不证明这些集成已完成。三个契约分别为[桌面 API](../api/desktop.md)、[Native Host](../api/native-host.md)和 [CLI](../api/claude-cli.md)。

Goal 用例 `node examples/desktop-api/run.mjs goal-mode` 覆盖无 Goal 配置时直接创建、CAS/幂等、两轮原生文件验证、隔离 Workgroup 共享计量、observe/interact 权限、重连恢复与 headless 跨 Turn 等待，纳入 `make examples-desktop-api`。契约见 [Core API](../api/core.md#goals)。

Task 用例 `node examples/desktop-api/run.mjs task-mode` 验证提问后继续独立工作、释放协调 Turn、关闭原连接、从新连接的 Inbox 回答、observe 权限拒绝回复、幂等受理和同 Run 恢复；所有消息均通过生成 schema 验证。见 [Task 契约](../api/tasks.md)。

`node examples/desktop-api/run.mjs task-matrix`（TASK-02）进一步覆盖真实 headless 普通对话和 Goal、提问/审批立即拒绝但允许的原生命令继续执行、无隐式调度、前台异步 Goal 断连后回复、一次性定时触发、周期调度控制，以及后台 worker 的文件产物、跨 Turn 生命周期和共享预算，纳入 `make examples-desktop-api`。

<a id="web-validation"></a>
## 浏览器验收

运行 `make build` 后执行 `node examples/desktop-api/run.mjs --serve`，保持该进程运行。它输出临时 Web URL、认证文件路径和工作区路径；使用该文件中的本地测试 token 登录页面。Ctrl-C 停止服务并清理临时目录。模型在 HTTP/SSE 边界使用确定性 fixture；浏览器操作真实 WebUI、Core 和 Runtime，不验证供应商模型质量。

| 操作 | 检查 |
|---|---|
| 新建会话，发送 `hello`，再发送 `native` | 正文完成，原生工具成功，工作区产生 native.txt |
| 创建 Goal `goal-native-fixture` | 自动续轮，两轮后完成并产生 goal.txt |
| 在侧栏删除已完成的 Goal 会话并刷新 | 会话从列表移除且不再出现；文件保留，Core 归档历史而非永久删除 |
| 新会话创建 Goal `task-channel-fixture` | 异步提问后完成独立 plan；从侧栏 Inbox 选择 B，恢复同一 Run |
| 后台创建 `task-workers-fixture`，选择无人值守 | worker 在独立会话生成 task-worker.txt；协调者跨 Turn 验证，频道报告已完成 |
| 后台创建 `task-channel-fixture` | 暂停、页面重载、独立 Inbox 回复 B 后仍暂停；显式恢复后完成 |
| 新会话定时创建 `goal-native-fixture` | 本地未来时间触发，两轮完成；重复任务可在触发前暂停、恢复和取消 |
| 在 Inbox 填写答案后点击刷新 | 草稿保留；原页面断开后问题仍可从新连接回答 |

同时检查窄屏导航、桌面布局和浏览器错误日志。协议 fixture、DOM 替身与实际浏览器验收分别记录，不能用任意一项代替其他层的结果。

发行包的公开入口为 `bin/areal`；`libexec/areal/areal-runtime` 与 `libexec/areal/areal-runtime-fs` 是隔离执行组件，不加入 PATH。完整目录可以搬迁，启动与共享服务身份检查按相对路径找到组件；不要单独复制 areal 后丢弃 libexec。
