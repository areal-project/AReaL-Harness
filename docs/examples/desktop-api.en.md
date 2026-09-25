[中文](desktop-api.md) | **English**

# Desktop API and package validation

Examples use real Core, app-server, storage and Runtime, with local fixtures only at the HTTP/SSE model boundary. No model credentials are needed. Native integration targets macOS and does not validate a real GUI or third-party daemon.

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

| Entry point | Checks |
|---|---|
| [run.mjs](../../examples/desktop-api/run.mjs) | Version, authentication, resume, Profiles, media, approvals, queues, shared terminals, model switching, MCP, agents/workflows |
| [cli.mjs](../../examples/desktop-api/cli.mjs) | Noninteractive argv/JSONL, resume, permissions, signals, broken pipes and task credentials |
| [skills.mjs](../../examples/desktop-api/skills.mjs) | Directory precedence, invalid global Skill warning isolation, large-image reads, explicit Profile current-file reads and resume |
| [soak.mjs](../../examples/desktop-api/soak.mjs) | Relocated packages, minimal PATH, system Python, budget exhaustion, archive and epoch rotation |
| [native-host.mjs](../../examples/desktop-api/native-host.mjs) | Real file/process brokers and foreign-handle rejection |

`run.mjs game-lite-profile` verifies actual Profile tool calls without a Workflow; `run.mjs profile-workflow` verifies automatic startup, completion, and no duplicate launch after resume. `cli.mjs` verifies that `exec --agent` exposes only the selected Profile's tools.

`AREAL_SOAK_ROUNDS` sets rounds (default 12), `AREAL_SOAK_REPORT` selects a JSON report, and `AREAL_PACKAGE_PROFILE=release` tests prebuilt release artifacts. Reports record actual source, platform, resource curves and cleanup.

## Explicit deployment Profile

`--desktop-config /absolute/deployment.json`:

```json
{"profiles":[{"id":"example","revision":"v1","displayName":"Example","instructions":"Complete the task and verify the result.","skills":[{"id":"example","revision":"v1"}],"readOnly":false}],"skills":[{"id":"example","revision":"v1","root":"skills/example"}]}
```

root resolves against the manifest directory and must contain SKILL.md. Renderer supplies ID/revision references rather than registering arbitrary host paths. Manifests register references and metadata; Profiles do not freeze file content, and subsequent reads of the same reference use current disk files. Use [automatic Skill discovery](../guides/skills.en.md) when explicit manifests are unnecessary. See the [Workgroup guide](../guides/workgroups.en.md) for staged workflows and policy.

Real GUIs, external-consumer task lifecycles, signing/notarization and other platforms require independent checks. Passing fixtures does not establish these integrations. The three contracts are [desktop API](../api/desktop.en.md), [Native Host](../api/native-host.en.md) and [CLI](../api/claude-cli.en.md).

`node examples/desktop-api/run.mjs goal-mode` covers Goal creation without Goal configuration, CAS/idempotency, native file verification across two Turns, isolated Workgroup accounting, observe/interact permissions, reconnect recovery and headless waiting across Turns. It is included in `make examples-desktop-api`. See the [Core API](../api/core.en.md#goals).

The Task scenario `node examples/desktop-api/run.mjs task-mode` verifies independent work after asking, coordinator Turn release, closure of the original connection, an Inbox reply from a new connection, rejection of observer replies, idempotency and same-Run resumption. Generated schemas validate all messages. See the [Task contract](../api/tasks.en.md).

`node examples/desktop-api/run.mjs task-matrix` (TASK-02) additionally covers real headless ordinary conversations and Goals, immediate question/approval refusal while permitted native commands continue, no implicit scheduling, foreground asynchronous replies after disconnection, one-shot timers, recurring schedule controls, and background worker files, cross-Turn lifetimes and shared budgets. It is included in `make examples-desktop-api`.

<a id="web-validation"></a>
## Browser validation

After `make build`, run `node examples/desktop-api/run.mjs --serve` and keep it running. It prints a temporary Web URL, authentication-file path and workspace path. Sign in with that file's local test token. Ctrl-C stops the service and removes temporary data. Deterministic fixtures replace only the HTTP/SSE model boundary; browser actions use the real WebUI, Core and Runtime without assessing provider-model quality.

| Action | Check |
|---|---|
| Create a conversation; send `hello`, then `native` | Completed text and native tool execution; native.txt appears in the workspace |
| Create Goal `goal-native-fixture` | Automatic continuation completes in two Turns and produces goal.txt |
| Delete the completed Goal session in the sidebar and refresh | The session remains absent from the list; the file remains and Core archives rather than permanently erasing history |
| Create Goal `task-channel-fixture` in a new conversation | Independent plan work follows the asynchronous question; answering B in the sidebar Inbox resumes the same Run |
| Create headless background task `task-workers-fixture` | An independent worker creates task-worker.txt; the coordinator verifies it across Turns and publishes completion |
| Create background task `task-channel-fixture` | Pause, reload the page and answer B from the independent Inbox; it stays paused until explicitly resumed |
| Schedule `goal-native-fixture` in a new conversation | A future local timestamp triggers two-Turn completion; repeating schedules can be paused, resumed and cancelled before firing |
| Fill an Inbox answer, then refresh the Inbox | The draft remains; a new connection can still answer after the original page disconnects |

Also inspect narrow-screen navigation, desktop layout and browser errors. Record protocol fixtures, DOM substitutes and real browser validation separately; none substitutes for the other layers.

The bundle exposes `bin/areal`. `libexec/areal/areal-runtime` and `libexec/areal/areal-runtime-fs` are isolated execution components and do not belong on PATH. Move the complete bundle: launch and shared-service identity checks resolve components relative to it. Copying areal alone omits required Runtime components.
