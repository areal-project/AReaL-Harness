[中文](codex-plugins-plan.md) | **English**

# Codex plugin implementation and acceptance

This plan implements the approved design in vertical slices. P0 has its own accepted local evidence. P1/P3 use GitHub as the first real service; the current batch continues with P2 hooks and retains each requirement for the final compatibility claim. A phase passes only with its own evidence.

## Baseline and controls

Codex 0.162.1 (`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`), Agent Plugins 1.0.0, and OpenAI MCP Extensions `0d606217705e0e71eb21fff009619b67b80611dc`. Core owns installation and selection; existing Skill/MCP/Runtime owners execute components. Private service access remains an external prerequisite.

Do not execute package code during discovery/install, overwrite explicit Profiles, mutate an active Turn revision, replay UNKNOWN effects, or share credentials with Renderer. Preserve existing standalone Skills/MCP and Native Hosts.

## Multiple-format imports

This section implements the [import decision](../design/architecture.en.md#multiple-plugin-formats). It does not replace the P0 through P3 evidence below. Validate each stage separately. Format recognition does not establish complete host compatibility.

| Stage | Scope and owner | Completion criteria |
|---|---|---|
| I1 · MCP declarations | Consolidate existing Portable and legacy MCP interpretation. `core/plugins` selects packages, `core/mcp` owns configuration and connections, and Engine combines runtime state | Reports, previews, and execution share declarations. Equivalent formats and existing override rules pass. No package execution or secret disclosure. Static envelope checks remain separate from runtime validation |
| I2 · Commands | Route supported Markdown prompts, arguments, and namespaces through ordinary submission | Discovery, explicit invocation, and arguments pass. Reject unimplemented model, tool, and Hook semantics explicitly |
| I3 · User configuration | Configuration owners retain values and secret references. Importers interpret declarations and substitution locations | Diagnose missing values. Resolve sensitive values only at authorized boundaries, outside ordinary display and model fields |
| I4 · Plugin dependencies | Installation owners manage versions, sources, missing dependencies, cycles, and cross-marketplace rules | Review the complete dependency plan. Failure leaves no partially effective activation. Keep package dependencies distinct from Skill tool requirements |
| I5 · Agents and Hooks | Reuse Profile and Hook owners. Map models, tools, events, and permissions individually | Validate parent restrictions, separate trust, revocation, cancellation, and recovery. Format compatibility grants no authority |

I1 preserves behavior. Pin Portable and legacy server discovery, placeholders, paths, headers, invalid-server isolation, and redaction before migrating consumers. Preserve Claude default and explicit-definition overrides, source locations, and the distinction between candidate and installed definitions. Static reports continue to check only MCP envelopes. Record authentication, connectivity, and real-provider validation separately.

I1 adds no installation state, cache, connection retry, schema support, user configuration, or dependency execution. Preserve existing document errors, per-server failure boundaries, and duplicate-server handling. Run package and configuration integration checks, an actual Core/MCP path, and public documentation checks before updating this stage from its evidence.

Current status: I1 is implemented. Relevant package, MCP, and Engine integration checks and fixed-artifact Core CLI/wire acceptance pass. The [import integration tests](../../core/engine/tests/plugin_mcp_import.rs) pin behavior before implementation and observe actual stdio arguments, environment, working directory, and HTTP headers. Existing authentication-timing, CLI, and wire fixtures now use the established admission-digest contract while retaining identity and authentication assertions. Workspace Rust formatting still reports existing differences in untouched files. Targeted formatting checks pass for this task's files.

Repeat with binaries from one build and isolated home and workspace directories. Use separate `CARGO_TARGET_DIR` values when comparing source trees.

```sh
make build
cargo test --locked -p areal-plugins --test component_support --test ecosystem --test remote
cargo test --locked -p areal-mcp --test plugin --test substrate --test portable_auth
cargo test --locked -p areal-engine --test plugin_mcp_import --test plugin_mcp_runtime
AREAL_TEST_BIN_DIR=/absolute/same-build/bin node scripts/plugin-cli-p1-smoke.mjs
AREAL_TEST_BIN_DIR=/absolute/same-build/bin node scripts/plugin-wire-smoke.mjs
```

Additional compatibility work in I2 through I5 is not implemented. This slice does not close signed distribution, real OAuth, cross-platform, or full ecosystem compatibility.

## P0 · Local packages and Skills

| Task | Owner/entry | Work | Observable acceptance |
|---|---|---|---|
| P0-01 | `upstream/pins.json`, design/task docs | Pin compatibility evidence and capabilities | Pin Codex 0.162.1 / Agent Plugins 1.0.0; surface unsupported components |
| P0-02 | `core/plugins/src/package.rs` | Parse both manifests and overlay | Unchanged packages; empty inline overlay replaces legacy; no schema downgrade |
| P0-03 | `core/plugins/src/lib.rs` | Discover/add local marketplaces | Pinned path precedence; entry failures isolated; root sources work |
| P0-04 | `core/plugins` installation Store | Transactional install, digest, CAS and restart | Bind selected source/digest; no script execution; immutable cache; visible conflicts |
| P0-05 | `core/engine/src/desktop/{skills,catalog}.rs` | Integrate skills/resource reads | Ordinary selection; explicit Profile bounded; shared package resources contained |
| P0-06 | Engine Turn/queue and Store | Invocation policy, Turn versions and disabling | Explicit use of implicit-disabled skills; pinned Turns; revoke subsequent reads |
| P0-07 | Engine plugins and existing submission ledger | Explicit onboarding and receipt recovery | Setup uses normal chats; deduplicate clicks/reconnects; query UNKNOWN receipts |
| P0-08 | app-server, CLI plugins, GUI PluginsSettings | Core/CLI/GUI management acceptance | Shared installation authority; real desktop journey; auth/restart evidence |

P0 dependencies: freeze the baseline in 01; establish package/catalog boundaries in 02/03; finish installation transactions in 04; integrate Skills and lifecycle in 05/06; complete setup, clients and combined acceptance in 07/08. P1 reuses P0 immutable packages and state ownership; P2 integrates existing Engine/Runtime permissions and events; P3 adds desktop and hosted-service support after MCP, authentication and lifecycle are ready.

## Current P1/P3 batch

Deliver source acquisition, package-bound MCP connections, authentication, metadata/resources and desktop Apps through the existing Core owners. GitHub is the first real remote-service acceptance target; token-based GitHub acceptance does not prove DCR or OpenAI private-service access. Public desktop extensions remain a capability-by-capability obligation. P2 is not implicitly implemented by adding form or App handlers.

The [P1/P3 acceptance ledger](codex-plugins-p1-p3-acceptance.en.md) separates source, integration, service, native and distribution evidence. The first GitHub delivery has integrated and native evidence; complete phase acceptance remains open.

## P1 · Sources, MCP and connection lifecycle

| Task | Work | Observable acceptance |
|---|---|---|
| P1-01 | Git marketplaces and source pins | Resolve refs to commits; contain subdirectories; preserve old install |
| P1-02 | npm sources and integrity | Pin versions/integrity; never run lifecycle scripts |
| P1-03 | Portable/legacy MCP adapters | Format-specific env/cwd/header/transport normalization and diagnostics |
| P1-04 | OAuth and secure credentials | Registration/refresh/cancel/failure; no secrets in renderer/logs |
| P1-05 | Authentication and tool policies | Distinct auth timing, tool enablement and approvals |
| P1-06 | Metadata, results and revision catalogs | Preserve instructions/results/media; stable active schemas |
| P1-07 | Updates, revocation, drain and recovery | Generation ownership; visible unconfirmed cleanup; no UNKNOWN replay |
| P1-08 | Real MCP and cross-instance acceptance | Original stdio/HTTP packages; concurrent connect/update/disable/restart |

## P2 · Full public hook semantics

| Task | Work | Observable acceptance |
|---|---|---|
| P2-01 | Configuration, grants and platform shells | Discovery/override, regex/aliases, seconds timeout, Windows override |
| P2-02 | Session/Turn lifecycle events | Pinned events; no repeat on attachments; defined ordering/ownership |
| P2-03 | Tool interception and permission decisions | Distinct denial/rewrite/approval/post feedback; deployment policy remains |
| P2-04 | Background command and MCP handlers | Safe-point output; no recursion; cancellation; late-response isolation |
| P2-05 | Outputs, failures and unsupported behavior | Pinned exit2/JSON/stderr/unsupported-field behavior |
| P2-06 | Comparison, faults and recovery | Same owned fixtures on fixed hosts; no side-effect replay |

## P3 · Desktop extensions, Connectors and full acceptance

| Task | Work | Observable acceptance |
|---|---|---|
| P3-01 | MCP Apps resources and isolated host | Metadata, initialization/bridge/CSP and window ownership |
| P3-02 | OpenAI desktop extensions | Accept pinned entrypoint/settings/mention/file/context capabilities |
| P3-03 | Connector resolver and authorized services | Original IDs; distinct auth/access/support states; real services |
| P3-04 | Experimental Codex management adapter | Pinned wire types; shared handlers; honest remote service gaps |
| P3-05 | Original-package corpus, platforms and distribution | Separate package/execution/UI/service/distribution evidence |
| P3-06 | Final compatibility claim | All required capabilities/services accepted with explicit prerequisites |

## Verification and status

Before implementation, define failure assertions at the actual boundary. Prefer integration/E2E evidence; source checks, a local deterministic model, real providers, native desktop and packaged distribution are separate claims. Run only affected checks during development and relevant end-to-end acceptance at closure.

Prior accepted status: P0 source implementation and local combined acceptance pass. All 48 package/Engine integration checks, actual Core/CLI authorization and lost-response recovery, GUI types/public contracts/build, real Electron installation/setup/disable/uninstall and explicit receipt recovery pass. Independent review is SHIP. See the [P0 acceptance record](codex-plugins-p0-acceptance.en.md) for evidence and exclusions. This does not claim compatibility with the complete Codex plugin protocol.

Current status: public MRTR, native stdio uploads, portable auth, ON_INSTALL/ON_USE, App subscription cleanup and sparse checkout are implemented. Sources28 pass; final MCP40/Engine32 pass, including all four previously failed process checks, whose historical causes remain unknown. Those are historical P1/P3 candidate results. Current standard schema Make passes; the historical SIGKILL cause remains unknown. CLI8/wire7/GitHub5 and initial native36 pass; final Core repeats all6 native auth checks. The HTTP403 scope-upgrade/cancel repair retains proven grants and passes8 portable-auth checks and independent SHIP review. Three old library test literal compile gaps are fixed. Cross-platform, real OAuth, distribution and private-service evidence remain open; P1/P3 and full compatibility are not closed.

Before P3 acceptance, name the required desktop extension set, services/Connectors and supported platforms. Format parsing does not grant access to hosted services. Every unresolved requirement remains open in the final matrix.

The current P2 candidate implements parsing, independent trust, Core/Runtime execution, lifecycle events, MCP active time and GUI review. The approved bounded Runtime write group passes 56 Runtime checks plus 21 default actual Core/Runtime scenes with separately consented ordinary read-only command hooks. The limited child implementation also passes filesystem/network/private-data boundaries, stale/revoked trust and desktop independent-consent flows. Read-only MCP, custom roles, platforms and full pinned Codex comparisons remain open; new direct Rust child SIGKILL failures are listed independently. See the [P2 matrix](codex-plugins-p2-acceptance.en.md) for evidence, failures and remaining acceptance; partial passes do not close full compatibility.
