[中文](claude-cli.md) | **English**

# Claude Code noninteractive CLI adaptation

`areal exec` and the compatibility entry point `areal -p/--print` implement selected Claude Code noninteractive arguments and stdio messages while Core retains the model loop. It does not run through the Claude SDK or claim complete Claude product/SDK compatibility. Pinned consumer and input/output fixtures are in [examples/desktop-api/fixtures](../../examples/desktop-api/fixtures/).

```sh
target/debug/areal exec 'Describe this workspace' --output-format stream-json --verbose
target/debug/areal -p 'Continue' --resume SESSION_ID --output-format json
```

Models use configured Chat Completions/Responses APIs. State defaults to `~/.areal/cli` (overridable with AREAL_HARNESS_HOME). session_id is the Core Thread UUID; history is not copied. Concurrent processes use private data/Runtimes and session locks. Missing or UNKNOWN sessions never trigger implicit new sessions.

| Argument | Behavior |
|---|---|
| exec / -p/--print, prompt, stdin | Single input; prompt and text stdin joined by a newline |
| --input-format text/stream-json | JSONL user text/base64 images; active input enters the Core queue |
| --output-format text/json/stream-json | Text, single result or events; logs only on stderr |
| --verbose / --include-partial-messages | Full tool messages / streaming text blocks |
| --resume, --model, --effort, --max-turns | Session, catalog model, reasoning parameter and per-Turn model rounds |
| --tools / --disallowedTools | Exact visibility/deny sets; unknown IDs fail |
| --allowedTools | Exempts only client-added approvals, never Profile requirements |
| --permission-mode | inherit (default)/default/acceptEdits/dontAsk/plan/bypassPermissions; never substitutes Runtime grants |
| --system-prompt[-file] / --append-system-prompt[-file] | Replace/append general instructions; files up to 32 KiB |
| --mcp-config / --strict-mcp-config | Per-run MCP; strict disables deployment MCP; external Core rejects overrides |
| --config / --workspace / --desktop-config | Local deployment, incompatible with external endpoint |
| --allow-write / --allow-network / --allow-concurrent-writes | Trusted deployment grants |
| --endpoint / --auth-file | Connect externally without shutting down the service on exit |

Tool aliases AskUserQuestion/Bash/Read/Write/Edit/TodoWrite/Task map to ask_user_question/run_command/fs_read/fs_create/fs_apply_patches/plan_update/agent_spawn. Shell pattern rules, arbitrary Claude settings/hooks, plugin marketplaces and interactive Claude TUI are unsupported; unknown options fail.

`--permissions YOLO|ASK_PERMISSIONS` and `--scratch` configure local deployment; `--permission-mode` defaults to inherit, using global policy. Explicit default/acceptEdits/dontAsk/plan/bypassPermissions retain client restrictions and cannot weaken global ask/deny or Profile rules. Local launch now defaults to full-access without requiring --allow-write/--allow-network. Existing remote endpoints retain their own policy.

## Messages and termination

Input is `{type:"user",uuid?,session_id?,message:{role:"user",content:[{type:"text",text:"hello"}]}}`, with 1 MiB lines and Core's 64 KiB text budget. session_id must match. stdout emits system/init, assistant, user/tool_result, optional stream_event and final result.

Approvals use control_request/can_use_tool and host control_response. updatedInput must match Core's effective arguments; question answers must come from the user. Missing bidirectional transport or EOF interrupts instead of inventing answers. Late, duplicate and unknown correlation IDs fail.

Success uses subtype=success/result; failures use error_during_execution or error_max_turns/errors. Unknown usage/cost is omitted, not zero. Complete billing/API timing and Claude product metadata are unavailable, so strict full-SDK consumers remain unvalidated. Unconvertible media is not a successful projection.

Success exits 0; other outcomes are nonzero. SIGINT/SIGTERM await Core interruption and cleanup. Accepted work completes without waiting for stdin EOF. Disconnections do not replay; consumer fallback/recovery requires separate validation. areal serve is an additional persistent-management entry point.

Per-run MCP supports stdio or HTTP Bearer only. `--task-credential-command` may inject task credentials solely into a designated trusted executable outside the workspace. Ordinary shells/file helpers do not inherit MULTICA_* identity. Real third-party daemon/GUI integration still needs external validation; see [examples](../examples/desktop-api.en.md).

`areal service ensure/list/status/stop/bind` and `areal web` provide the [shared local service interface](local-service.en.md). Noninteractive `areal exec` / `areal -p` retains its owned lifecycle; `areal serve` retains its existing foreground launcher behavior.

CLI submissions without a bidirectional response channel use Core interactionMode=headless: questions immediately return unavailable and tools requiring human approval are denied, allowing independent work or a blocker report. Explicit bidirectional stream-json retains the host control protocol above; permission-mode=dontAsk selects headless even with that channel.

See the [client guide](../guides/clients.en.md) for command routing and migration. With no subcommand, areal opens the TUI. Noninteractive options belong to exec / -p; areal config runs diagnostics without a running service.
