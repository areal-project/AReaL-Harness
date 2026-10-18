**中文** | [English](plugins.en.md)

# 插件边界

`@areal/plugins` 在独立可信 Node Host 中适配选定 DSH 工具和文件服务。Core 保留 Agent loop、会话、历史提交和取消树；Runtime 保留部署授权与执行事实。插件不能替换这些职责。

![插件边界](diagrams/plugin-boundaries.svg)

[源文件](diagrams/plugin-boundaries.drawio) · [PNG](diagrams/plugin-boundaries.png)

| 层 | 职责 |
|---|---|
| SDK | 工具注册、文本渲染、虚拟文件目标、观察版本与条件写入 |
| Node Host | 初始化后串行回调；按 Thread 保存临时文件观察记录 |
| Core | schema、调用身份、期限、hooks、嵌套操作 journal 与收窄 Scope |
| Runtime | 受管文件助手、路径检查、去重与清理 |

只适配 `tools/fs/sandboxPolicy`；真实编辑器验收 `view/str_replace`。不提供完整 DSH Session、Prompt、Todo、Plan、Skill、Subagent、subprocess、事件树或 provider 替换。文件上限 32 KiB，组合结果 16 KiB。

同 Host 串行，不同 Host 受 Core 工具限额控制。取消、超时、崩溃或协议错误终止 generation；成功的嵌套写入不会因外层失败而回滚，UNKNOWN 停止自动执行并要求检查。SDK 冻结对象不是 OS 安全隔离，`trusted:true` 必须对应真实信任。

Host 默认继承 PATH、LANG、LC_ALL、SYSTEMROOT，以及已设置的八个[标准代理变量](../guides/configuration.md#proxies)。代理 URL 中的认证信息也会传入可信 Host；模型凭据和其他环境不会自动透传。搜索等插件的 HTTP 库须自行支持这些变量及选定代理协议；Core 不拦截插件自建连接，也不将这些变量自动注入经 Runtime broker 启动的命令。

[SDK 契约](../api/typescript-sdk.md) · [编辑器示例](../examples/dsh-editor-plugin.md) · [无需 DSH 的 Native Host v2](../api/native-host.md)
