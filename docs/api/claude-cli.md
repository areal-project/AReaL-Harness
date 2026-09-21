**中文** | [English](claude-cli.en.md)

# Claude Code 非交互 CLI 适配

`areal` 实现选定 Claude Code 非交互参数和 stdio 消息，模型循环仍在 Core。它不依赖 Claude SDK 运行，不声明完整 Claude 产品/SDK 兼容。固定消费者与输入输出 fixture 见 [examples/desktop-api/fixtures](../../examples/desktop-api/fixtures/)。

```sh
target/debug/areal -p 'Describe this workspace' --output-format stream-json --verbose
target/debug/areal -p 'Continue' --resume SESSION_ID --output-format json
```

模型使用配置的 Chat Completions/Responses。状态默认 `~/.areal-harness/cli`（AREAL_HARNESS_HOME 可覆盖）；session_id 是 Core Thread UUID，历史不复制。并发进程使用独立数据/Runtime，同会话文件锁保护。恢复缺失或 UNKNOWN 不隐式新建。

| 参数 | 行为 |
|---|---|
| -p/--print, prompt, stdin | 单次输入，prompt 与 text stdin 用换行连接 |
| --input-format text/stream-json | JSONL user 支持文本/base64 图片，活动输入进入 Core 队列 |
| --output-format text/json/stream-json | 文本、单结果或逐事件；日志只写 stderr |
| --verbose / --include-partial-messages | 完整工具消息 / 流式 text block |
| --resume, --model, --effort, --max-turns | 会话、目录模型、推理参数、单 Turn 模型轮次 |
| --tools / --disallowedTools | 精确工具可见/拒绝集合，未知 ID 拒绝 |
| --allowedTools | 仅免除客户端增加的审批，不覆盖 Profile |
| --permission-mode | default/acceptEdits/dontAsk/plan/bypassPermissions，不能替代 Runtime 授权 |
| --system-prompt[-file] / --append-system-prompt[-file] | 通用指令替换/追加，文件最多 32 KiB |
| --mcp-config / --strict-mcp-config | 运行级 MCP；strict 禁用部署 MCP，外部 Core 不允许覆盖 |
| --config / --workspace / --desktop-config | 本地启动配置，不与外部 endpoint 混用 |
| --allow-write / --allow-network / --allow-concurrent-writes | 可信部署授权 |
| --endpoint / --auth-file | 连接外部服务，退出不关闭它 |

工具别名 AskUserQuestion/Bash/Read/Write/Edit/TodoWrite/Task 对应 ask_user_question/run_command/fs_read/fs_create/fs_apply_patch/plan_update/agent_spawn。shell 模式规则、任意 Claude settings/hooks、插件市场和交互 Claude TUI 不支持，未知选项拒绝。

## 消息与终态

输入 `{type:"user",uuid?,session_id?,message:{role:"user",content:[{type:"text",text:"hello"}]}}`，行上限 1 MiB，Core 文本预算 64 KiB。session_id 必须匹配。stdout 输出 system/init、assistant、user/tool_result、可选 stream_event 和最终 result。

审批为 control_request/can_use_tool，宿主用 control_response 回答；updatedInput 必须与 Core 有效参数一致，问题答案必须来自用户。没有双向通道或 EOF 时中断，不伪造答案。迟到、重复和未知关联 ID 拒绝。

成功使用 subtype=success/result；失败使用 error_during_execution 或 error_max_turns/errors。未知 usage/费用省略，不填零；完整计费/API 耗时和 Claude 产品元数据未提供，严格完整 SDK 消费者尚未验收。不能转换的媒体不是成功投影。

成功退出 0，其余非 0；SIGINT/SIGTERM 等待 Core interrupt 和清理。已受理任务完成后无需等待 stdin EOF。断连不重放，消费者的恢复回退仍需单独测试。areal serve 是附加常驻管理入口。

运行级 MCP 仅支持 stdio 或 HTTP Bearer。任务凭据只可经 `--task-credential-command` 注入工作区外的指定可信 executable；普通 shell/文件助手不继承 MULTICA_* 身份。真实第三方 daemon/GUI 联调仍需外部验收，见[示例](../examples/desktop-api.md)。
