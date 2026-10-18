[中文](mcp.md) | **English**

# MCP tools

`core/mcp` uses the pinned official rmcp client. Server owns connections and injects tools into Engine; TUI/Web need no MCP client. See the version in [Cargo.toml](../../core/mcp/Cargo.toml).

## Configuration

Set `[tools] extensions_file="tools.json"` in user TOML. Example JSON:

```json
{"mcpServers":{"project":{"transport":{"type":"streamableHttp","url":"https://mcp.example.com/mcp","bearerTokenEnv":"PROJECT_MCP_TOKEN"},"enabledTools":["search"],"startupTimeoutMs":30000,"callTimeoutMs":120000}}}
```

A stdio transport uses `{type:"stdio",command:"python3",args:["server.py"],cwd:".",envVars:[]}`; install the server separately. cwd resolves against the JSON directory; argv does not use a shell. PATH and configured standard proxy variables are inherited automatically; other variables require an explicit envVars entry, and missing entries fail. stdio servers are trusted host processes **outside the Runtime sandbox and allow-write restrictions**.

Streamable HTTP uses HTTP, HTTPS or SOCKS proxies from Core's startup environment. Stdio tools such as search servers also inherit proxy variables, which their own HTTP libraries must consume. See [network proxies](configuration.en.md#proxies) for variables, remote DNS, authentication, bypass rules and restart requirements. Compatibility change: stdio proxy variables no longer require individual envVars entries, and credentials in proxy URLs are also passed to these trusted servers.

Up to 16 servers are allowed. Omitted enabledTools exposes all, an empty array none, and missing named tools fail. Startup defaults to 30 seconds and calls to 120 seconds. null removes the MCP-specific call deadline while Turn cancellation/deadlines still apply. HTTP redirects are disabled; Bearer credentials use environment references. `config validate` does not connect, launch servers or validate remote tools.

## Results and recovery

Tools are discovered through paginated tools/list, normally named `mcp__server__tool`; invalid/long names use stable hashes. Core's total tool budget remains 128, with the same schema/hook rules as [other tools](tools.en.md).

Text and structuredContent are retained. Images, audio and embedded binary resources pass through Blob validation and provide actual bytes in original order. Resource links are not fetched automatically; unsupported modalities fail explicitly. Pure text/structured results accept at most 8 MiB before Core snapshot projection, with model-visible pages bounded to 16 KiB and originals available through read_tool_result. Mixed media reference envelopes retain the 16 KiB limit. These are not bounds on SDK transport memory; see [result retrieval](tools.en.md).

isError=true is confirmed failure. Disconnects, timeouts, cancellation and protocol/result errors become UNKNOWN and stop execution. Cancellation notification does not prove rollback. Calls are never automatically retried; expired HTTP sessions are not reinitialized to replay them. tools/list_changed invalidates the old catalog; desktop disconnect/connect rediscovers at a safe boundary without replacing active Turn schemas.

Desktop `areal/mcp/*` separately manages persistent configuration, connection state and catalog revision. Saving does not connect. Shutdown settles Engine before closing servers. OAuth, legacy HTTP+SSE, sampling, elicitation, roots, MCP tasks and full conformance certification are unsupported. See [testing](../development/testing.en.md).
