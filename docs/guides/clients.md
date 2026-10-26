**中文** | [English](clients.en.md)

# CLI、TUI 与本地 Web

先完成[快速开始](quickstart.md)。客户端使用同一 Core 历史；工具由 Runtime 执行，不需要 Codex 二进制。

## 启动

产品命令统一为 `areal`。源码构建后使用 `target/debug/areal`；发行包只把 `bin/areal` 加入 PATH。子命令的选项放在子命令之后。

| 命令 | 行为 |
| --- | --- |
| `areal [PROMPT]` | 打开 TUI；可选首条消息在会话就绪后提交一次 |
| `areal version` / `areal --version` | 显示当前产品版本，不启动服务 |
| `areal upgrade [--check]` | 检查或升级已安装的完整发行包；详见[安装指南](installation.md) |
| `areal exec [PROMPT]` | 非交互执行，支持文本、JSON 和 stream-json |
| `areal serve` | 前台启动 Core + Runtime，由同一 launcher 负责清理 |
| `areal app-server` | 直接启动 Core 服务，Runtime 连接需显式部署 |
| `areal config show/validate` | 查看脱敏配置或校验配置，不启动服务 |
| `areal trajectory status/retry/sync-config` | 查看轨迹队列、重新排队失败记录或应用持久导出控制，输出 JSON |
| `areal service` / `areal web` | 共享服务管理与 Web 启动 |
| `areal workgroup run/inspect` | 隔离任务组执行与状态检查 |

迁移：`areal-tui …` 改为 `areal …`；`areal-server …` 改为 `areal app-server …`；其 `config` 命令改为 `areal config …`；`areal-workgroup …` 改为 `areal workgroup …`。旧独立可执行文件不再构建或发布。`areal -p/--print …` 保留原非交互协议，等价于 `areal exec …`。无参数 `areal` 现在打开 TUI；自动化应显式使用 `exec` 或 `-p`。`--prompt`、`--goal`、`--input-file` 保留原 TUI headless 行为，与位置参数 PROMPT 互斥。

```sh
target/debug/areal
target/debug/areal --resume THREAD_ID
target/debug/areal exec --workspace /absolute/task 'Describe the task'
# 连接已有服务；使用它的数据目录中的认证文件
target/debug/areal --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json
```

省略 endpoint 时，交互式 TUI 连接共享 Core/Runtime，监听随机 loopback 端口。同一工作区多个窗口复用服务，关闭窗口保留后台服务和任务。`--prompt`、`--goal`、`--input-file` 默认使用 owned 模式，退出后清理所拥有的服务；`--local-mode shared|owned` 可覆盖默认选择。显式 endpoint（别名 `--remote`）只连接已有服务，不能与本地部署参数混用。

共享模式默认在 `~/.areal/instances/` 下按工作区保存数据；显式数据目录配置保持优先级。旧 `~/.areal-harness/state` 历史须使用 `--data-dir`，或停止旧 Core 后绑定。模型 TOML 配置自动热更新；其他 TOML 变化等待后台工作结算后重启，权限/部署参数变化需显式 restart。发现、迁移、日志和 Desktop 接入见[本地服务契约](../api/local-service.md)。

TUI 的模型凭据来自 Core 启动时的环境。先在终端导出密钥变量，再通过供应商 TOML 的 `api_key_env = "MY_MODEL_KEY"`、`AREAL_HARNESS_API_KEY_ENV=MY_MODEL_KEY` 或 `--api-key-env MY_MODEL_KEY` 指定变量名；优先级为 CLI、环境覆盖、TOML。GUI 保存的加密密钥不会自动进入独立 TUI 的环境，共享模型目录也不共享这些密钥。缺少或无效的凭据会显示环境变量名，会话创建失败后可退出修正配置。

修改终端环境不会改变已运行 Core 的环境。已有共享服务需要使用相同配置、工作区和部署参数执行 `areal service restart`，再启动 TUI；有后台任务时先等待结算，不要为更新密钥自动取消工作。`Ctrl-R` 只重连，不能注入新密钥。使用 `--endpoint` 时，应在远端 Core 的启动环境中配置凭据。密钥值不要放入命令行参数或 TOML。配置示例见[模型配置](configuration.md#gui-与-cli-共享模型目录)。

```sh
target/debug/areal web --workspace /absolute/task
target/debug/areal service list --json
target/debug/areal service status --json
target/debug/areal service restart --json
target/debug/areal service stop --json
```

`areal exec 'prompt' --output-format stream-json --verbose` 提供非交互 CLI，`areal serve` 启动持续服务；参数、认证、恢复与退出码见 [CLI 契约](../api/claude-cli.md)。Web 位于服务的 `/ui`；通过 `areal web` 打开会自动登录，无需复制 token。直接打开地址且没有有效会话时，可在设置中填写服务数据目录 `security/auth.json` 中的本地 token。

本地 `areal exec` 通过受监督的 launcher 拥有 Core/Runtime；macOS 复用可信服务启动适配，需要可用的 `/usr/bin/python3`，Linux 直接启动。CLI 退出时等待实际 launcher 的清理回执；启动阶段提前退出会报告其退出状态，就绪或认证文件无效也会先回收已启动的 owned 服务。显式 `--endpoint` 连接不拥有远端服务生命周期。

TUI 的 `--input-file /absolute/input.json` 与 `--prompt` 互斥，接受最多 2 MiB 的 Core Input 数组，如 `[{"type":"text","text":"Inspect the image"},{"type":"localImage","path":"/absolute/image.png"}]`。本地模式和显式 endpoint 均支持，可信 launcher 可用 `--tui --input-file` 透传；媒体路径与字段仍按 [Core API](../api/core.md) 验证。

## Web 操作与外观

Web 采用中性灰工作台布局：240px 可收起侧栏、任务标题与视图标签、居中会话内容，以及圆角输入框。浅色和深色外观对齐 AReaLGameAgent 的工作台；默认跟随系统，也可在侧栏底部「设置 → 外观」切换，偏好保存在当前浏览器。窄屏使用可关闭的任务导航抽屉。

- 通过侧栏新建、切换、刷新或分页加载任务；新任务显示居中的输入区域，产生记录后输入框固定在底部。
- `areal web` 自动登录；一次性链接 60 秒有效，会话 1 小时有效。失效或服务重启后重新运行该命令，也可在「设置 → 本地连接」输入访问令牌；错误在设置内显示。有效会话可刷新页面恢复连接和任务快照。
- Enter 发送，Shift + Enter 换行；输入法确认候选字不发送。运行中可以追加说明或停止执行。
- Web 输入 `/` 会显示命令提示，支持 `/help`、`/new`、`/refresh`、`/goal`、`/skills` 和 `/skill NAME`；点击输入框下方的 `Skills` 或执行 `/skills` 可为当前任务选择 Skill。
- Web 侧栏的删除会话按钮调用 Core 归档；需先停止活动 Goal 并结算队列/资源。确认后会话从列表移除，磁盘历史与去重收据仍保留，不是永久擦除。
- 输入框上方的「持续目标」可展开查看预算与进度、创建或编辑目标、暂停、恢复和清除；有活动 Goal 时停止按钮暂停目标，自动续轮保留来源标记。
- 「任务记录」展示消息和可展开的工具结果；UNKNOWN 工具结果仍需记录检查说明。「协同任务与验收」保留计划提交、进度查询、取消和调整入口。

外观与导航由 Web 客户端维护，任务、权限和执行状态以 Core 返回的数据为准。

Web 与 TUI 在上下文压缩后仍保留已显示的用户输入、追加说明和 Agent 回复。轮次完成、停止或失败只合并事件携带的消息尾部；刷新或重连再从 Core 恢复完整历史。合并规则见 [Core API](../api/core.md#传输与会话)。

TUI 顶部和 Web 显示 YOLO/ASK_PERMISSIONS，以 Core 状态为准。TUI 审批展示有效参数，↑/↓ 选择拒绝/允许一次/记住会话/项目，Enter 回答，Esc 拒绝，PgUp/PgDn 阅读参数；初始选中拒绝。Web 提供对应按钮。强制审批只提供单次回答。`/permissions` 查看模式、来源和记忆；`/permissions clear-session` 或 `clear-project` 撤销记忆。详见[配置](configuration.md#permissions)。`--prompt`/`--input-file` 无交互应答通道，遇到请求会中断并提示使用交互式 TUI/Web。

## TUI 操作

| 操作 | 行为 |
| --- | --- |
| Enter | 空闲时开始 Turn；运行中追加指令 |
| ←/→、Option+←/→、Ctrl-A / Ctrl-E | 输入框内按完整字素移动光标；Option+←/→（Alt+b / Alt+f）按 Codex 词边界跳到上一词开头 / 下一词结尾；Ctrl-A / Ctrl-E 跳到当前行首 / 行尾 |
| Ctrl-D / Delete、Backspace | 删除光标处 / 光标前的完整字素；空输入或相应边界不操作，不退出 |
| `/`、Tab、Esc | Slash 候选、补全和关闭候选 |
| Ctrl-C / Ctrl-Q | Ctrl-C 暂停当前 Goal 或中断活动 Turn，没有活动任务时退出 TUI；Ctrl-Q 从任意界面退出 TUI |
| Ctrl-R | 重连并恢复快照，不重放请求 |
| F5、`/sessions`、`/new`、`/open ID` | 选择、创建或打开会话 |
| F6、`/model` | 空闲时选择模型或恢复默认值 |
| `/skills`、`/skill NAME` | 选择或按名称应用当前会话 Skill |
| F2、`/theme` | 预览主题，Enter 保存，Esc 撤回 |
| `/agents`、`/executions`、F4 | 子任务进度、验证与交付 |
| F3、`/topology` | 会话历史树与根拓扑 |
| `/spawn prompt` | 通过统一委派入口手工派发当前 Turn 的只读分析子任务 |
| `/tasks` | 当前任务计划 |
| `/execution-cancel ID` | 停止子任务，等待 Core 结算与清理 |
| `/groups`、`/group ID`、`/group-start FILE` | 高级兼容 Workgroup 历史与显式计划 |
| PageUp/PageDown/Home、End | 阅读历史；End 恢复跟随 |
| 点击历史摘要 | 展开组后，再展开指定记录；滚轮滚动历史 |
| ↑/↓、Enter/Space、←/→ | 历史焦点下选择、切换、收起/展开；Esc 返回输入框 |
| Ctrl-O、`/details` | 切换紧凑/详细历史，保留局部展开选择 |
| `/restore-input` | 恢复提交失败或结果未确认时保留的输入 |

在输入框中输入 `/quit` 并回车退出；在选择器中将完整筛选词输入为 `/quit` 后回车也可退出。在导航或历史区输入 `/` 会聚焦输入框。所有弹窗中均可按 Ctrl-Q 退出。断线、快照尚未恢复或提交尚未确认时，Ctrl-C 提示先核查状态，仍可按 Ctrl-Q 明确退出。共享模式下退出 TUI 保留 Core 和后台任务。

`AREAL_TEST_BIN=/absolute/fixed-slot/areal python3 scripts/tui-recovery-smoke.py` 用隔离 Core/Runtime、真实 PTY 和本地模型验证环境凭据恢复、取消与退出，保留终端画面和报告。测试不调用真实供应商，也不修改用户配置。

子任务列表分页读取；TUI 用 `/more` 加载后续记录。等待或断开客户端不会重放子任务，停止操作由 Core 处理。手工 `/spawn` 默认为只读分析；实际开发任务直接在普通输入区提出，由协调 Agent 声明修改与交付意图。

`--prompt` 只输出本次 Turn 的文本，Thread ID 写 stderr；失败返回非零，不读取 TUI 偏好。外观配置见[配置指南](configuration.md#tui)。

`--prompt` 和 `--input-file` 可显式加 `--no-session-name`，关闭展示用自动命名并保留持久历史；`areal serve --tui` 同样传递该选项。客户端先检查 Core 能力，再按原入口创建或恢复会话，仅修改命名选项，等待配置成功后提交任务；配置冲突会报错，不自动重试。省略开关不会改写已有选择。该开关不适用于全屏 TUI 或 `--goal`；`areal exec/-p` 的同名选项见 [CLI 契约](../api/claude-cli.md)。这只省去可选命名请求，不表示任务 token 或耗时已有测量收益。

## 思考与等待状态

Web 将 Chat Completions / Responses 返回的思考文本放在可展开的“模型思考”区域，只有摘要时标为“思考摘要”，正文独立展示。等待正文期间显示“正在等待模型回复”或“已收到模型思考”，并显示本页观察到的等待秒数；超过 30 秒提示可继续等待、刷新或停止。这是界面提醒，不表示模型超时或停止。刷新当前任务保留同一请求的观察计时，重新打开页面从当前观察时刻计时。

“刷新任务”显示刷新状态，以 Core 的最新快照替换历史。“停止执行”提交取消后显示“正在停止”，等 Core 结束任务与工具；连接断开时控制按钮禁用，服务端任务可能仍继续。恢复连接后先刷新确认状态，不自动重发任务。

TUI 默认紧凑显示：连续工具调用、思考和过程正文合为一条 Activity 摘要，参数、成功输出首行及思考需显式展开。最终回复直接显示；无阶段标记的旧消息保留正文。点击组后再点指定记录，或用 Tab 将焦点移入历史并使用上表按键。`--mouse=false` 关闭捕获，保留终端原生选择行为。

错误原因保留在所属 Turn 旁，重连后仍可见；不显示空 Agent 标题。失败前部分回复标记为未完成，Goal 阻塞、等待交互、自动重试和未确认用量均有明确提示。提交失败仅在输入框为空时自动恢复原输入；`/restore-input` 显式替换当前草稿。断线显示状态待同步，不自动重发提交或工具。非交互输出沿用正文输出行为。详见 [TUI 设计](../design/tui.md)与 [Core API](../api/core.md#思考进度)。

## 历史、恢复与观测

Core 保存原始历史、工具意图与结果；上下文压缩只改变后续模型视图。每个 Turn 开始时，Core 通过 Runtime 先解析会话 cwd 的路径别名，再按工作区根到 cwd 的顺序读取路径上的 `AGENTS.md`；文件须为普通 UTF-8，正文合计最多 32 KiB，目录链最多 64 层，读取时拒绝符号链接文件及被替换为符号链接的目录。缺失文件跳过，不扫描兄弟目录或 cwd 下的子树；cwd 必须仍在 Runtime 工作区内。每份规则只适用于其目录及后代，较近规则优先，用户请求与部署权限优先于项目规则。模型被要求在处理其他目录前读取适用规则；自动加载不跟随工具命令临时 cwd。指令快照在当前 Turn 内固定，下个 Turn 重新读取。

普通任务通过统一委派入口组织子任务；Core 根据意图、依赖、有效权限与运行条件选择共享执行或隔离执行，用户无需选择工作区模式。GUI 的“子任务”、TUI 的 `/executions` 和 Web 的“子任务与交付”读取同一 Core 投影，分别展示执行、验证和交付状态。候选生成、检查通过、改动已应用是不同状态，冲突或部分应用不能显示为交付完成。高级入口保留[兼容 Workgroup](workgroups.md)与旧任务历史。 GUI 可预览候选文件并应用全部改动，后端统一校验与执行交付；原任务不活跃时需继续原任务承接候选，不支持逐文件应用。

重启把未确认的工具/hooks 标为 UNKNOWN 并阻止新 Turn。检查实际文件与进程后，在 Web 中记录检查或调用 `areal/tool/acknowledge`，历史仍保留 unknown。它不是重放、审批或旧进程恢复。损坏快照不会被静默丢弃。

```sh
export OTEL_SERVICE_NAME='areal-core'
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4318'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
make server
```

OTLP 仅支持 HTTP/protobuf；未设置 endpoint 不启用，`OTEL_SDK_DISABLED=true` 可关闭。轨迹记录实际模型输入输出、工具参数与结果，以及 ID、usage、状态和时长，不执行脱敏。上报失败不改变 Turn 结果；完整配置见[轨迹上报](configuration.md#opentelemetry-轨迹上报)。

<a id="goals"></a>

## Goal 模式

无需修改配置；交互式 TUI 输入 `/goal 完成模块迁移并通过相关测试` 创建并运行目标；`/goal` 查看当前状态。`/goal-pause` 暂停，等待活动 Turn 清理完毕后用 `/goal-resume` 恢复；`/goal-edit 新目标`、`/goal-budget 200000`（或 `none`）仅编辑已停止目标，保留累计用量。`/goal-clear` 清除已停止且队列与资源均已结算的目标。Web 的 Goal 面板提供对应操作。

目标状态、token 用量、活动时间、Turn 次数和停止原因展示在客户端。自动续轮有单独的来源标记。普通最终回复只结束当前 Turn；模型通过 `goal_update` 报告完成，并在 Core 结算完资源后提交目标终态。用户追问优先于自动续轮，追加输入会使旧完成申请失效。

```sh
make tui ARGS='--goal "完成模块迁移并通过相关测试" --goal-token-budget 200000'
target/debug/areal --endpoint ws://127.0.0.1:4500 --goal '检查代码并整理迁移建议'
```

`--goal` 与 `--prompt` / `--input-file` 互斥，可用 `--resume THREAD_ID` 在已有空闲 Thread 中创建新 Goal。headless 跨 Turn 等待目标终态，仅 completed 返回成功；其他停止状态返回非零并输出目标 JSON 和原因。远端 headless 退出或断连不取消服务器上的 Goal；owned 本地 launcher 退出会关闭所拥有的 Core，shared 模式仅断开连接。通过交互式 `/open` 和 `/goal-resume` 恢复已停止目标。普通 `--prompt`、Claude CLI 入口保持单次执行语义。

Core 重启后 active 目标恢复为 paused/serverRestarted，`thread/resume` 只恢复订阅，不自动运行。未知模型消费不会补零；显式 Goal resume 确认保守预留并继续保留该消费。工具 UNKNOWN 仍须检查和 acknowledge。预算、活动时间、轮次或历史容量耗尽时停止，不自动重试。预算配置见 [执行策略](configuration.md#goals)，接口字段见 [Core API](../api/core.md#goals)。

## 后台任务与 Inbox

Core 提供统一的 [Task Mode API](../api/tasks.md)，可创建前台、定时和后台任务。前台 Goal 的模型也可异步提问，任务频道与执行会话分开；通过 inbox/list 找到问题，用 channel/reply 回答。Web 的「后台与定时」提供任务创建、进度、频道、暂停、恢复和取消；侧栏「收件箱」是独立入口，无需打开执行会话即可回复。TUI 的专用 Inbox 面板仍待接入；API 客户端应使用 channel/reply，不把异步问题提交给 interaction/respond。

后台任务可选择异步提问或无人值守。定时任务绑定当前选中的会话，使用本地日期时间创建一次性触发，或填写固定重复间隔；默认无人值守。无人值守只是交互策略，普通 headless 对话与 Goal 不会自动创建定时调度。任务控制受理后等待状态结算；暂停期间回复不会解除暂停。刷新收件箱保留当前表单草稿，页面重载后可重新查询持久问题。

TUI headless 与无双向应答通道的 Claude CLI 使用 headless 交互策略；明确启用双向 stream-json 的 CLI 保留宿主应答，dontAsk 仍禁止等待。headless 中：问题立即返回不可用，必须人工批准的工具立即拒绝，模型继续其他工作或报告 blocker。要让任务在窗口关闭后运行，连接持续存活的共享或外部 Core 服务；owned launcher 退出仍会关闭其服务。

TUI 默认启用鼠标捕获，支持点击和滚动。需要终端原生拖选复制时使用 `areal --mouse=false`，选中后使用终端的复制快捷键；这不会把 Ctrl-C 改成复制。
