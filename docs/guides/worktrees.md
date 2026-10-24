**中文** | [English](worktrees.en.md)

# 桌面 Worktree

桌面新会话可以选择起始分支和项目环境，在同一 Git 仓库中创建 Worktree。每个隔离目录使用独立的 Core 与 Runtime，侧栏仍在原逻辑项目中显示线程。新会话的工作区准备发生在首条消息执行前，已有会话不会透明搬迁。

## 新会话的工作区选择

新会话 Composer 上方右侧的齿轮打开工作区设置。打开“新 Worktree”，选择起始分支和项目环境。分支支持搜索。环境入口可以跳转到“设置 > Worktrees > 环境”配置当前项目。选择只作用于当前未发送草稿，发送首条 Prompt 后才创建目录；新会话不继承旧的全局或项目 Worktree 偏好。来源必须属于同一个 Git common directory。宿主先把来源 ref 固定为提交，再创建独立命名分支，不复用已占用分支或覆盖目录。项目位于仓库子目录时，新执行根保留相同相对目录；选定提交缺少该目录时准备失败。

普通新会话默认使用当前目录和分支，与已有会话共用当前 Core。只有在本次创建时明确打开“新 Worktree”才创建独立目录。未选择、旧草稿缺少明确方式、旧偏好值或来源已有会话均不触发自动隔离。

创建过程中显示准备阶段、输出和已发送的 Prompt 预览。取消请求先阻止首条消息发送，再确认准备进程终止；已建目录保留。“不使用 Worktree”只有在原请求确认取消后，才以新的明确请求选择原目录。未确认结果不会自动回退。侧栏的分叉图标及对话中的创建标识来自实际 Worktree 绑定。

## General 与目录管理

“设置 > Worktrees > General”保存根目录、分支前缀、创建前 fetch、自动清理和保留数量。空根目录使用 `~/.areal/worktrees`，其下按项目分组。默认前缀为 `areal`，新分支未命名时按前缀和请求 UUID 生成。配置只影响未来创建，不移动已有目录或修改已有分支。fetch 默认关闭；开启后先获取远端，再解析固定起点。

管理列表按项目展示宿主登记的 Worktree。删除会核对目录身份和实际执行宿主，执行所选环境的 cleanup，再次检查 Git 状态，以非 force 的 Git 操作移除目录，保留分支和历史。活动任务、未确认操作、未提交或未跟踪文件、忽略文件及未合并提交等会阻止删除。主 checkout 不能通过此入口删除。自动清理默认关闭，仅考虑已归档且未固定的会话及未绑定目录，复用相同检查；受保护目录可以使数量超过上限。

## 项目环境

“环境”按项目保存名称、Setup script、Cleanup script 和自定义 Actions。脚本提供 Default、macOS、Linux 标签。当前平台的非空脚本覆盖 Default，空白覆盖使用 Default。环境在创建受理时固定，之后编辑不会改变已经准备或运行的 Worktree。

先从项目列表进入环境列表，再新建或编辑环境。Setup、Cleanup 和每个 Action 分别切换平台，切换不会清空其他平台的未保存内容。变量入口只解释当前支持的变量。Actions 在所属行展开编辑；保存配置不会运行脚本。返回时保留项目归属，并保护未保存修改。

Setup 在新 Worktree 的项目根执行，成功后才发送首条 Prompt。准备期间可以存在尚未收到 Prompt 的空线程。Cleanup 在删除前执行。Actions 从当前 Worktree 的入口显式运行，可用于构建、测试或执行其他项目命令。它们复用 Core 的受管进程，并遵循原有权限、超时、输出和清理规则。

脚本可读取 `AREAL_WORKTREE_PATH`、`AREAL_PROJECT_PATH`、`AREAL_WORKTREE_BRANCH`。路径和分支通过环境变量传递，不拼接到命令中。只执行用户保存并选择的环境，不自动发现或执行仓库中的 setup 或 Git hooks。当前脚本入口支持 macOS、Linux。每次脚本最多运行 10 分钟，输出最多保留 64 KiB；它是一次受管命令，不会留下不受管理的后台服务。

Setup 失败保留草稿、创建记录和目录，不自动发送 Prompt。脚本执行结果未知时只检查原回执，不自动重跑。Cleanup 失败或未知时保留目录，不强制删除。手动以新请求重试前，需要核对原脚本可能已经产生的副作用。

## 来源改动与兼容性

新 Worktree 只包含选定提交。来源的 staged、unstaged、untracked 和 ignored 内容均不复制，来源 HEAD、index 和文件保持原状。宿主不自动 stash、commit 或执行 Git hooks；未选择已保存环境时不运行 setup；也不自动复制 `.worktreeinclude` 所列文件。新宿主使用当前部署的全局或默认资源，不复制来源项目专有的 Skills、MCP 或 Profile。指定资源在新宿主不可用时，创建不能静默改用来源目录。

旧 `source: "working-tree"` 快照入口会创建临时 Git 提交。该模式现明确拒绝并提示选择提交或分支，不再沿用“包含未提交的改动”的旧含义。已有 Worktree 和旧创建记录保留，不自动搬迁。确需以尚未提交的内容开始工作时，由用户先明确准备合适的来源提交或独立目录。

## 创建、绑定与恢复

创建请求使用稳定 `requestId`。相同请求返回原目录和线程；相同标识携带不同模型、选项或 Worktree 参数会被拒绝。超时或连接中断后，应核对原请求。不得通过生成新标识来推定原操作没有执行。

| 状态 | 含义与恢复边界 |
|---|---|
| `creating` | 已保存创建意图，Git 结果尚未确认。重复请求不能创建第二份目录。 |
| `created` | Git checkout 已确认。线程绑定尚未完成，不表示可以开始模型执行。 |
| `binding` | 已选择实际执行宿主，线程创建或其回执仍待确认。恢复读取原 Core 回执，不重发未知提交。 |
| `settingUp` | 空线程已绑定，正在核对环境 setup；首条 Prompt 尚未发送。 |
| `cancelling` | 已请求取消，等待原操作或进程静止，不能改用原目录。 |
| `cancelled` | 准备已确认取消，保留已建目录和草稿。 |
| `ready` | 线程身份、实际宿主和环境准备均已确认，可以发送首条 Prompt。 |
| `failed` | 已确认失败。保留来源和已创建资源，修正问题后使用新的明确请求。 |
| `unknown` | 部分 Git 操作结果不确定。先查询并核对现有分支、目录和记录，不重放或强制清理。 |

创建结果仍不确定时，先点击“检查操作状态”核对原 UUID。检查后仍需返回编辑，可点击“保留原结果，返回草稿”并确认。此操作归档原请求信息、保留原目录和可能已创建的空会话，不重发请求、不发送草稿。随后可手动选择新的工作区，再以新请求发送；这会创建另一份资源，原结果仍须单独核查。

创建事件属于桌面宿主的持久日志。界面把事件投影到对话流，并在线程、工作区上下文中显示分支和目录；这些投影不伪造 Core 消息或模型工具结果。重连从原记录及宿主快照恢复。Git 成功而登记、资源初始化或绑定失败时，保留目录供核查，不回退来源目录继续执行。

显式 Worktree 创建会拒绝已存在的目标分支、目录冲突、非法 ref、跨仓库来源和非 Git 来源。非 Git 目录可以创建多个普通会话。根目录禁止路径穿越和符号链接祖先。并发创建通过独立请求记录和目标预留处理；`git worktree lock` 不是文件写互斥。删除与可选自动清理只处理通过上述检查的受管 Worktree，不自动合并。

## 执行隔离的范围

逻辑项目、来源 checkout 和实际执行宿主是不同身份。工具路径、shell 默认 cwd、受管进程、子 Agent 和队列归属于实际 Core 与 Runtime。桌面文件编辑、Git、媒体、历史、进程控制和浏览器回调也按线程所有者路由。原生文件打开使用同一线程目录，未保存文件缓存按逻辑项目和实际根区分。

系统不自动决定创建 Worktree，也不因已有会话或目录写入而迁移普通线程。已经创建的 Worktree 和旧自动隔离请求继续使用原目录与 Core；恢复原请求不改变既有绑定。

普通会话、Fork 和同一 Session 的子 Agent 可共享当前目录。桌面仍核对 Core 线程身份，普通 Side 保持只读，可执行 Side 核对来源与 cwd。共享目录中的普通会话可能同时读写相同文件，Worktree 由用户按任务需要显式选择。

普通执行仍完整分页读取同 checkout 的 Task 目录。未取消的 scheduled 任务即使休眠、暂停或 `activeTasks` 为零也保留专用目录资格，只有核对后的原任务家庭可执行。读取失败、目录未知或分页异常均阻断执行，不自动暂停、删除或迁移任务。只读检查、明确取消及资源清理继续可用。

定时任务操作先核对持久化的实际宿主归属，再使用经 Core 核对的线程锚点进入同一作者准入。任务归属不明、冲突、原宿主已移除或读取超时时，不回退逻辑项目的来源目录。`taskRunNow`、`taskResumeRun`、`taskReply` 和 `taskResume` 没有可核对的线程锚点时拒绝执行；调用者提供的线程不能覆盖已记录的任务归属。

定时任务使用专用准入：一个任务家庭只可占用为其自动分配的独立项目外目录，共用同一目录作者登记。只读规划会话的开始、发送和原自动保存确认流程继续可用；创建执行锚点和任务前先保留目录，再核对创建收据并绑定任务。`scheduled` 创建可使用可信已有锚点，或在预约完成后创建锚点。后续启动和恢复还核对 Task、run、线程锚点及实际 cwd。前台和后台任务继续核对可信线程锚点，不取得普通目录的永久独占作者。

当前 scheduled Run 的交互可以映射到原预约的任务家庭作者，但仅限严格核对的 `respond` 和 `continue` 请求：预约、唯一活动 Run、goal、当前 Turn、实际 cwd，以及 Core 已登记 worker 和有界父链都须一致。问题或审批响应还须匹配未过期的 pending interaction、线程、Turn、requestId 和回答种类。它不授权任意后代、其他 Session、普通 send、编辑或 manage 写操作；native Task Agent 的研究和工具限制继续生效，不能递归委派。

回答有效问题或审批后，Core 自动继续原 Run。Core 的普通 Continue 仍不支持 goal 所有的定时执行线程；暂停或 blocked Run 使用 `taskResumeRun`，在同一 Run 和线程创建新 Turn。交互等待时 Host 断开会暂停 Run，旧 requestId 不可重放；恢复后只回答新 Turn 的新问题。取消、暂停、已结束或不属于当前 Run 的身份不能用于交互作者映射。

共享目录、用户选择的已有目录及没有原预约的旧定时任务不能启用或恢复执行，返回 `SCHEDULE_WORKSPACE_REQUIRED` 或对应的作者准入错误；暂停和取消仍可进行。符合专用目录预约的 `taskDraftConfirm` 创建、更新和恢复可继续使用。

直接 Core 或 CLI 调用、不同桌面数据目录中的宿主，以及绕过桌面入口的原生调度不受这份作者登记统一控制。准入不会追溯停止已准备或已运行的旧自主任务，不能据此承诺这些路径已获得同样隔离。

调度家庭的作者登记在桌面数据目录的 `workspace-authors` 中。旧普通作者记录保留，普通会话不再取得或受其永久独占限制。`claim.lock` 串行化新作者登记；正常操作结束后释放，崩溃留下的锁不会因超时自动删除。人工恢复前，必须确认原桌面宿主、Core、Runtime、子 Agent 及后台进程全部停止，备份完整桌面数据目录，并核对作者、任务和创建收据。只有确认锁确为陈旧且不存在旧执行后才可人工移走该锁；保留作者记录，不通过删除记录转让目录。无法确认时继续阻断。

独立 Runtime 根不等于文件系统安全沙箱。`full-access` shell 可以使用绝对路径访问其他 checkout；可信 MCP、插件 Host 和外部程序也可能产生根目录之外或延迟发生的副作用。Git Worktree 仍共享对象、refs 和部分仓库配置。OS 权限、外部服务授权和上游的作者租约、读集版本及进程清理保护继续生效，不能据此承诺所有入口绝无并发写。

## 与 Codex 的取舍

[Codex App Worktree 文档](https://learn.chatgpt.com/docs/environments/git-worktrees)描述选定起始分支、默认 detached HEAD、可应用来源分支未提交改动和可配置 Worktree root。AReaL 的命名分支、默认 `areal` 前缀和只使用已提交内容是本产品的明确选择，不是 Codex 的默认合同。

[固定版本的公开模型工具合同](https://github.com/openai/codex/blob/e6ebdfe00b520e21ed50ac0362656f32dd64d2fc/codex-rs/tui/src/managed_worktree_tool_specs.rs)包含 `create_worktree`、`get_worktree_creation_status` 和 `list_worktrees`。该 TUI 合同默认使用 remote default branch，不复制未提交改动，通过 operationId 查询，且不改变调用线程 cwd。它与 App 新会话入口的语义不同。

AReaL 复用统一宿主管理能力，不新增要求模型自愿调用的创建工具。写前隔离属于宿主准入策略，不能由模型工具替代。新根会话采用独立 Core 与 Runtime，避免仅修改 `Thread.cwd` 却仍使用旧执行根。代价是更多服务实例、持久路由及聚合状态。图标沿用现有设计系统中的分支和 Worktree 含义，不宣称复刻 Codex 私有实现。

## 复验入口

从仓库根运行 Git、宿主和桌面契约测试：

```sh
node --test clients/gui/scripts/worktree-git.test.cjs clients/gui/scripts/worktree-host.test.cjs clients/gui/scripts/worktree-contract.test.cjs clients/gui/scripts/worktree-admission.test.cjs clients/gui/scripts/worktree-task-routing.test.cjs clients/gui/scripts/schedule-admission.test.cjs
```

生产组件交互由 `node clients/gui/scripts/worktree-ui-smoke.mjs` 验证。它使用 Chromium 和确定性桌面动作 fixture，不代表原生 Electron、安装包或 macOS 验收。

构建真实 Core 后，在支持原生执行边界的环境运行：

```sh
make build
AREAL_CORE_BIN="$PWD/target/debug/areal" node clients/gui/scripts/worktree-integration.mjs
```

环境专项在固定可信 Core 路径上运行。第一项验证真实受管脚本、40 秒准备和取消、cleanup 与删除。第二项验证隔离 Electron 设置、首条 Prompt、Action、失败、取消及原目录选择。文件选择器和外部模型使用 fixture，其余经过真实桌面与 Core 路径。

```sh
AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:worktree-environment
AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:worktree-environment-ui
```

真实 Core 的定时任务交互协议可另行复验：

```sh
AREAL_CORE_BIN="$PWD/target/debug/areal" node clients/gui/scripts/worktree-schedule-interactions.mjs
```

也可从 `clients/gui` 运行 `node scripts/worktree-schedule-interactions.mjs`，默认使用仓库构建的 Core。该脚本使用确定性本地模型边界和真实 CoreBackend/Core，覆盖问题回答、错误身份与旧请求拒绝、审批拒绝、allowOnce、管理器重连及同 Run 恢复。它保存原始日志和 manifest，分别报告协议结果与 payload 结果。协议通过不等于文件工具成功：allowOnce 获准后仍可能在 Runtime reaper 启动处失败，目标文件未写入。它不运行 Electron，也不代表 macOS 或真实 provider 验收。

Linux 需要可用的 Bubblewrap namespaces 和 Runtime reaper 可读取的 `/proc/self/task/<pid>/children`。能力不足或清理证据缺失时保留失败，不关闭保护。GUI 业务结果、跨平台行为和实际工具写入分别验证。完整宿主字段见[桌面宿主契约](../api/desktop.md#桌面宿主-worktree-契约)。
