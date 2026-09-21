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

`AREAL_SOAK_ROUNDS` sets rounds (default 12), `AREAL_SOAK_REPORT` selects a JSON report, and `AREAL_PACKAGE_PROFILE=release` tests prebuilt release artifacts. Reports record actual source, platform, resource curves and cleanup.

## Explicit deployment Profile

`--desktop-config /absolute/deployment.json`:

```json
{"profiles":[{"id":"example","revision":"v1","displayName":"Example","instructions":"Complete the task and verify the result.","skills":[{"id":"example","revision":"v1"}],"readOnly":false}],"skills":[{"id":"example","revision":"v1","root":"skills/example"}]}
```

root resolves against the manifest directory and must contain SKILL.md. Renderer supplies ID/revision references rather than registering arbitrary host paths. Manifests register references and metadata; Profiles do not freeze file content, and subsequent reads of the same reference use current disk files. Use [automatic Skill discovery](../guides/skills.en.md) when explicit manifests are unnecessary. See the [Workgroup guide](../guides/workgroups.en.md) for staged workflows and policy.

Real GUIs, external-consumer task lifecycles, signing/notarization and other platforms require independent checks. Passing fixtures does not establish these integrations. The three contracts are [desktop API](../api/desktop.en.md), [Native Host](../api/native-host.en.md) and [CLI](../api/claude-cli.en.md).
