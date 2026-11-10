[中文](codex-plugins-p1-p3-acceptance.md) | **English**

# Codex plugin P1/P3 acceptance

This pass implements public MRTR, file/directory selection, portable auth, authentication timing, App subscription cleanup and sparse marketplaces. **Source review passes; complete P1/P3 and full Codex acceptance remain open.** Partial passes do not replace process, external-service or distribution evidence.

## Baseline and candidate

- Codex0.162.1 revision092d3acd6bec3e3a14bdc7e7a2810ab628ab759d; Agent Plugins1.0.0; OpenAI extensions revision0d606217705e0e71eb21fff009619b67b80611dc. See [pins](../../upstream/pins.json).
- rmcp3.3.0, modern MCP2026-07-28 and direct legacy2025-11-25; official Apps AppBridge.
- Base commit5e7def7737f3aeeab93aa4652b0a28d3ab11a216, implementation commit961c5ce827463b26b1066bcf55aff00960acb555, branch codex/codex-plugins-p1-p3, followed by the scope-upgrade repair. No push, PR or release.
- Initial native/service Core SHA256: 2ee44d3fac1b82290263ff4fcd58452c297a6f28e30bb929cc403aae51f40b71; final scope-repair Core SHA256: cf4acd0aba51cb8e3c15b54fdde0a842421daecf632e17272f3d38524038cba3. Final build/MCP/Engine and repeated native auth bind the latter. Ignored .scratch/codex-plugins/evidence/p1-p3-gap-final/manifest.json records file fingerprints, environments and raw outcomes without browser profiles or credential vaults.

## Implemented contracts

| Capability | Owner and behavior |
|---|---|
| MRTR | core/mcp modern discovery, tool/resource rounds; fixed arguments, private requestState, Core authorization/cancellation on every round; no UNKNOWN replay |
| Legacy forms | Standard simple elicitation and openai/elicitation/create remain; resource extensions do not masquerade as standard simple schema |
| Selection | Main native picker, Core field/form/caller/generation grants, Runtime NOFOLLOW immutable snapshots; only opaque URIs reach Renderer |
| Lifetime/budgets | 16 MiB/file, 256 files/64 MiB/logical operation, depth16; cancel/close/revoke/settle cleanup; stage UUID/payload bound to existing receipts |
| UNKNOWN | Query only original unknown stage; definite pre-dispatch rejection or another request conflict permits a fresh selection |
| Configuration | Main vault for client secrets/PEM/API keys; Core refs/revisions only, disconnected current digest required; transient auth and durable configure are separate |
| OAuth | Provided/public/confidential, DCR and CIMD preference, with DCR fallback absent trusted host metadata; declared endpoint/resource/OIDC/scopes and empty overrides persist through refresh; challenge upgrades and cancelled retries retain proven grants in the same binding, never pending requested scopes |
| Credentials | client_secret_basic/post, private_key_jwt (RS256/ES256), API-key bearer/basic/custom header; RSA fixtures are disposable public test keys, not provider credentials |
| Challenges | HTTP401/403 and tool mcp/www_authenticate remain private; reject exact sent RequestId/token, preserve concurrent refresh, never replay POST |
| Timing | ON_INSTALL pending auth and mixed gating; ON_USE requests auth when needed, allowing anonymous mixed public access; installation/listing never starts OAuth |
| App subscriptions | URI/generation/instance owner sets, first subscribe/last unsubscribe; close preserves other owners; gated close/dispatch and no stale delivery |
| Sparse | Top-level Codex marketplace/add sparsePaths, Git cone directories retained on updates; callers include catalog/package paths, no silent full fallback |
| GUI recovery | Preserve auth form/request owner across same-project reconnect; refresh after gate clears; project switches reset and late settlements never mutate the new project |

Same-host stdio can read accepted snapshots. No published HTTP upload channel is implemented: remote selection reports RESOURCE_UPLOAD_UNSUPPORTED while server-provided resources remain selectable. No multipart/download-auth protocol is invented. Apps still reopen after Core restart.

## Final evidence

| Check | Actual outcome |
|---|---|
| Workspace build | Pass |
| Package/source | 28pass, including sparse/update/restart/filter/rejection |
| MCP | Final candidate40pass/0fail/2explicit ignored; real GitHub accepted separately |
| Engine | Final candidate32pass/0fail; three missing TaskControl test literals permanently repaired |
| Runtime import | 1pass across files/directories/links/budgets |
| Core CLI / Codex wire | 8 / 7pass; real sparse snapshot and malformed input rejection |
| Real GitHub | 5pass, single read-only get_me through ordinary Core journal; no writes |
| Native Electron/Core | Initial Apps8/extensions5/API-key6/legacy uploads8/modern MRTR uploads9 =36pass; final Core passes the repeated6 auth checks after scope repair, with separate candidate hashes |
| GUI/docs | Typecheck, public verify, renderer build and paired links pass |
| Independent review | SHIP for full source risk, GUI recovery and final scope-upgrade review; not package/provider acceptance |

Chooser and directory-confirmation responses are scripted. Real Main/Core/Runtime, sandbox pages, system encryption and MCP reads execute; physical OS picker and signed-package acceptance do not. Modern uploads use two human form rounds, no snapshot read until final confirmation, fixed arguments and fresh request IDs.

RED/GREEN preserves definite-rejection UNKNOWN, scope/challenge handoff, same-scope rejected-token recovery, GUI reconnect-owner failures and lost grants after HTTP403. The last real HTTP fixture checks read → read write, cancelled retry, binding isolation and no POST replay; all8 portable-auth checks pass. Two fixture contract errors are retained: internal stored nulls sent as desktop params and resource extensions sent as standard legacy schema. Fixtures were corrected without loosening production validation.

## Supplemental real GitHub acceptance

The isolated `codex/plugins-acceptance` worktree continues from retained `ef0f8edf`; the primary checkout's later plugin-integration reverts remain intact. Core SHA256 in the fixed slot `/Users/sailfish/CodeProject/AReaL-Harness/.local/dev-bin/plugins-acceptance` is `7d046b1c31bf5d7eb01bd427432fd178b64ba33a6bcd5cf7cc3b5467fe0fbe4b`, with deployment receipt `/private/tmp/plugin-acceptance-deployment-candidate.json` and no replacement during execution.

`/private/tmp/areal-plugin-github-L8ywBV/manifest.json` records9 passes: inert installation, retained original Connector id requiring explicit mapping, real remote initialization, one read-only `get_me` through an ordinary Core Turn, disconnect revocation, a new generation on reconnect, disable revocation/reconnect denial, mapping/credential-reference recovery after confirmed Core restart, and confirmed cleanup with no credential in storage or model input. The existing `gh` credential is read only in memory and passed through the controlled child environment; no GitHub writes occur. The model is a deterministic local fixture; GitHub HTTP and the tool call are real. The initial same-source five-check baseline remains in `/private/tmp/areal-plugin-github-CidiVn/manifest.json`.

This accepts this host's specified GitHub Connector with bearer credentials; it does not establish browser-based GitHub OAuth, other hosted Connectors, remote user-file uploads or complete P1/P3 conformance. Standard `make desktop-schemas` passes in this batch without overwriting historical failures; see the [P2 matrix](codex-plugins-p2-acceptance.en.md) for hook follow-up evidence. Human observation of security-prompt reuse at the fixed path was not obtained and cannot be inferred from functional success; signing and protection settings were not changed.

## Historical failures and unaccepted boundaries

- Initial Engine restart and OAuth subprocesses explicitly received SIGKILL9 with empty output; proxy failures did not capture their signals. All four pass on the final candidate using the original build environment and standard tests. Historical failures remain recorded, with cause UNKNOWN; their recovery cannot be attributed to the scope repair.
- make desktop-schemas remains failed. Its initial Core-generator command received killed9/137; final Core generation succeeds and matches the committed schema, but the local-service generator command receives killed9/137. Its truncated file is restored from the unchanged committed snapshot. Native-host generation exposes pre-existing search snapshot drift, retained only as evidence; this task did not change that contract. Partial generation does not pass Make.
- Binaries inspected during failure diagnosis verify signatures. OS scans/provenance show no attributable kill decision. Final passing results bind new source/binaries and preserve earlier failures. Missing libLLVM.dylib explains separate rust-objcopy SIGABRT warnings, not SIGKILL. Cause UNKNOWN, with no proven EDR/Gatekeeper/memory/source attribution or security bypass.
- Legacy SSE remains explicitly unsupported, matching pinned Codex; no complete Agent Plugins transport claim.
- P2 hooks, private OpenAI catalog/sharing/registered services, cross-platform, real provider OAuth/models, physical picker, native writable-file/CAS races and signed/notarized distribution remain unaccepted. GitHub does not close them.

## Reproduction

Use one workspace build for Core/runtime paths and isolated state. Native scripts run serially; GitHub reads existing authorized credentials only in memory.

```sh
cargo build --locked --workspace
cargo test --locked -p areal-plugins --tests
cargo test --locked -p areal-mcp --tests
cargo test --locked -p areal-engine --test plugin_mcp_runtime --test plugin_mcp_subscriptions --test codex_plugins --test admission_guards
cargo test --locked -p areal-engine --test plugin_mcp_runtime connectors_resolve_from_marketplace
cargo test --locked -p areal-runtime-fs --test import
make desktop-schemas
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui run verify
pnpm --dir clients/gui build
node scripts/plugin-wire-smoke.mjs
node scripts/plugin-cli-p1-smoke.mjs
node clients/gui/scripts/plugin-p1-auth-smoke.mjs
node clients/gui/scripts/plugin-p3-uploads-smoke.mjs
AREAL_MCP_FORM_PROTOCOL=modern node clients/gui/scripts/plugin-p3-uploads-smoke.mjs
node clients/gui/scripts/plugin-p1-p3-smoke.mjs
node clients/gui/scripts/plugin-p3-extensions-smoke.mjs
python3 scripts/check-docs.py
```

These include the still-failed schema Make check. Full compatibility requires closing remaining contracts and actual environment evidence.
