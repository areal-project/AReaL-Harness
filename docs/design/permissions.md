**中文** | [English](permissions.en.md)

# 权限架构

Core 统一解析聊天权限、审批与授权记录。Runtime 强制执行受管文件和命令的资源边界。Electron Main 负责浏览器原生页面、控制权和逐次目标校验。客户端只展示和提交意图。

## 聊天预设

可选的 `ClientOptions.permissionPreset` 接受 `ask`、`autoReview`、`fullAccess`。桌面应用的 `ApplicationSettings.defaultPermissionPreset` 默认是 `autoReview`。在新聊天草稿或现有聊天的权限菜单中明确选择预设后，应用立即将该选择保存为后续新聊天的默认值，包括 `ask`。

新聊天草稿优先恢复已保存的有效权限选择，否则使用应用默认值。应用默认值变化不改写已打开草稿的权限，清空草稿时使用最新默认值。现有聊天始终使用 Core 配置，不因应用默认值变化而自动更新。更新当前聊天失败或结果为 UNKNOWN 时，应用仍保留菜单选择作为新聊天默认值，当前聊天沿用既有恢复流程。

Remote 新聊天继续显式选择 `ask`。旧快照缺失字段时保留原语义，不能据此显示具有新沙箱或自动审核器。

| 预设 | 受管执行范围 | 额外请求 |
| --- | --- | --- |
| 请求审批 | 工作区、任务 scratch，命令网络关闭 | 用户审批 |
| 帮我审批 | 与请求审批相同 | 独立模型审核，必要时交给用户 |
| 完全访问 | 部署允许的完整资源范围 | 省略常规审批 |

计划模式独立叠加只读限制。部署拒绝、强制人工审批、Profile、父任务限制和工具允许列表仍然优先。完全访问不能突破部署上限或开放未支持的工具动作。

Core 返回 `EffectiveConfig.permissions`，包含 `resources`、`reviewer`、`fullAccessAvailable`。客户端检查 `features.permissionPresets` 与 `features.permissionFullAccess`，不支持时拒绝新预设，不静默退回旧工具数组配置。

创建聊天原子保存初始 options。更新沿用空闲检查和 revision 比较。Turn 与队列在受理时固定配置；恢复不根据当前 Composer 重新解释历史权限。

## 单次授权与清理

Core 为 Turn 保留不直接交给工具的权限父 Scope。基础 Scope 与获批操作 Scope 为其子节点，共享父级资源约束和递归清理。

`run_command.permissionRequest` 显式请求一次操作的额外读取目录、写入目录或网络能力。Core 校验最终参数和部署、父任务上限，绑定摘要后审批。批准只建立本次操作 Scope，不放宽基础 Scope。后台进程的读取、输入和终止仍绑定原 Scope。

`read_file`、`search_files`、`image_read`、`fs_read`、`fs_list` 和 `fs_stat` 复用相同的逐操作审批入口。其 `permissionRequest` 只接受 `readRoots` 和 `justification`，拒绝写入、网络及未知字段；获批读取 Scope 的 `writeRoots=[]`、`network=deny`，不影响原基础 Scope。目录引用仍是任务输入，不从普通 Markdown 自动推导授权；图片可通过获批读取直接进入 Core 媒体链路。

权限不足的复合命令可能已经产生部分副作用，Core 不自动重跑。取消后不得派发新操作；回执丢失或清理失败保留 UNKNOWN，不宣称回滚，重启不重放未知操作。

## 独立审核

帮我审批通过冻结的模型适配器发起独立请求。输入包括用户要求、最终参数、申请范围和强制限制。审核器不接收可执行工具，结构化结果必须匹配本次摘要。Core 保存审核者、决定、理由与用量。审核沿用 20 秒总时限、512 token 输出和无工具约束；实际 HTTP 请求使用求解、摘要相同的模型容量边界。内部网络退避归还容量，再次请求重新排队和记账，在途响应仍占名额。取消不派发待审操作，未知副作用不重放；路由身份按 Thread、Turn 与 permissionReview 用途隔离。

明确拒绝阻止执行。不确定、非法输出、超时或服务不可用进入既有人工审批；非交互任务缺少必要人工许可时拒绝执行。审核器不能覆盖硬拒绝、只读或强制人工要求。PermissionRequest Hook 保留原契约，不替代审核器。

## 浏览器任务

describe 的准备阶段只读取实际页面身份和来源，或记录创建空白页的意图，不认领、不导航、不输入。Core 决定后，执行阶段核验一次性计划、原生目标和受理消息入口，再沿既有 Main 路径认领或复用页面。

当前授权任务与页面控制范围内，已支持的读取、等待、普通导航和搜索不因快照或关键词变化重复询问。每次操作仍生成具体 prepare/execute 计划，Main 逐次核验参数、目标、页面、宿主与控制代次，批量也逐项检查。

人工接管撤销旧计划和入口，旧 Turn 不能自动抢回控制。敏感内容检查、原生权限拒绝、陈旧 Ref、未知动作和 UNKNOWN 不随审批档位放宽。完全访问不开放任意 JavaScript、完整 CDP 或未实现的敏感动作。

浏览器操作许可不是命令网络沙箱。Core、MCP 与插件 Host 也不自动共享 Runtime 隔离，不能将受管命令限制描述为整个应用的隔离。

契约见[桌面 API](../api/desktop.md)、[Core](../api/core.md)、[Runtime](../api/runtime.md)、[浏览器](../api/browser.md)。部署配置见[权限模式](../guides/configuration.md#permissions)。
