**中文** | [English](mcp.en.md)

# MCP 工具

`core/mcp` 使用锁定的官方 rmcp 客户端，server 持有连接并向 Engine 注入工具；TUI/Web 无需 MCP 客户端。版本见 [Cargo.toml](../../core/mcp/Cargo.toml)。

## 配置

用户 TOML 设置 `[tools] extensions_file="tools.json"`，JSON 例如：

```json
{"mcpServers":{"project":{"transport":{"type":"streamableHttp","url":"https://mcp.example.com/mcp","bearerTokenEnv":"PROJECT_MCP_TOKEN"},"enabledTools":["search"],"startupTimeoutMs":30000,"callTimeoutMs":120000}}}
```

stdio transport 使用 `{type:"stdio",command:"python3",args:["server.py"],cwd:".",envVars:[]}`；需要自行安装服务。cwd 相对 JSON 目录，argv 不经 shell。默认传入 PATH 和已设置的标准代理变量，其余只传 envVars 中明确列出的变量，缺少时报错。stdio 是可信宿主进程，**不受 Runtime 沙箱或 allow-write 限制**。

Streamable HTTP 使用 Core 启动环境中的 HTTP、HTTPS 或 SOCKS 代理；stdio 搜索等工具也继承代理环境，但须由工具自身的 HTTP 库使用。变量、远端 DNS、认证、绕过规则与重启要求见[网络代理](configuration.md#proxies)。兼容性变化：stdio 不再需要将代理变量逐个列入 envVars；代理 URL 中的凭据也会传入可信服务。

最多 16 个服务。enabledTools 省略表示全部，空数组不开放工具，名称不存在时报错。启动期限默认 30 秒，调用默认 120 秒，null 取消 MCP 自身调用期限但仍受 Turn 取消/期限限制。HTTP 禁止跳转；Bearer 仅引用环境变量。`config validate` 不联网、不启动服务、不验证远端工具。

## 结果与恢复

工具经 tools/list 分页发现，通常映射为 `mcp__server__tool`；非法或过长名称使用稳定摘要。Core 总工具预算仍为 128，schema 与 hooks 规则同[普通工具](tools.md)。

文本与 structuredContent 保留；图片、音频和内嵌二进制资源经 Blob 校验后按原顺序提供实际字节。资源链接不自动抓取，不支持模态明确失败。纯文本/结构化结果在 Core 快照投影前最多接收 8 MiB，模型可见页仍限 16 KiB，并通过 read_tool_result 回取原文。混合媒体引用封套仍限 16 KiB。这些限制不代表 SDK 底层传输的总内存上限，见[结果回取](tools.md)。

isError=true 是确定失败。断连、超时、取消、协议或结果错误记 UNKNOWN 并停止；取消通知不证明外部副作用回滚。调用不自动重试，过期 HTTP session 不自动重初始化重放。tools/list_changed 后停止使用旧目录，桌面 disconnect/connect 在安全边界重新发现，不替换活动 Turn schema。

桌面 `areal/mcp/*` 分别管理持久配置、连接状态和目录 revision；保存不等于连接。正常关闭先收敛 Engine，再关闭服务。未支持 OAuth、旧 HTTP+SSE、sampling、elicitation、roots、MCP tasks 或完整协议一致性认证。验证见[测试](../development/testing.md)。
