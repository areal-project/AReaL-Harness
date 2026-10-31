[中文](plugins.md) | **English**

# Plugin package compatibility

Shared Core owns plugin installation and selection; GUI and CLI read the same state. Current scope covers local/Git marketplaces, pinned Git/npm packages, Skills/onboarding, trusted MCP connections and desktop Apps. GitHub is the first real Connector service. See [upstream pins](../../upstream/pins.json) and the [implementation/acceptance plan](../development/codex-plugins-plan.en.md).

## Read component support

Open a plugin detail to read its installed component report. A changed catalog snapshot has a separate candidate report. Installation compares the source and digests automatically. Review the source, components, and execution behavior. A report can show supported Skills, Markdown Commands, and Agent templates beside unsupported execution semantics or UI declarations. This means partial package compatibility, not that all declared capabilities are usable.

Expand the declaration list to read the parser contract, reasons, and activation requirements. Current MCP connection and authentication status and Hook definition trust remain in their existing panels. The target conversation's Profile controls actual admission. Listing reports does not start setup, package code, connections, authentication, or model requests.

CLI reads the same Core report with `areal plugin --workspace /path/to/project read <plugin-id>`. Use `mcp-list` and `hooks-list` under the same command and workspace for current connection and trust facts. Match `pluginId` and `installedDigest`; a candidate digest is not the installed version. Provider, platform, and signed distribution acceptance remain unverified in a static report.

Portable authors can require static component kinds with `extensions.org.areal.componentRequirements` set to `{"version":1,"requiredKinds":["skills"]}`. Every declared row of each required kind must be supported. An incompatible required kind leaves the package installed for inspection but excludes it from effective activation. Optional unsupported declarations do not disable supported Skills. These semantics apply only to the recognized portable 1.0.0 manifest. See the [API contract](../api/desktop.en.md#component-support-reports) for strict fields and limits. Limited component import from `.zcode-plugin` is supported. See the format and host limitations below.

Historical Skills retain the static compatibility requirements of their own package digest. Installing a compatible replacement does not unlock a blocked old reference. Compatible old references remain usable until the current package becomes blocked, disabled, or uninstalled.

## Claude Code and ZCode compatibility

Core keeps one Store, immutable original-package cache, and management receipts. Import does not rewrite an upstream package into an AReaL manifest. Portable Agent Plugins 1.0.0 takes precedence, followed by Codex, Claude, Cursor, and ZCode manifests. Unknown portable schemas do not fall back. An inline OpenAI extension still replaces the entire compatibility overlay.

A Claude marketplace entry can define a plugin without a separate manifest. For example, `source: "./"` and `skills: ["./skills/review"]` select that entry's Skill without loading sibling entries' Skills from the same root. `strict` defaults to true and appends entry component paths when a manifest exists. `strict:false` conflicts with a manifest plus entry component declarations and is rejected. For a Claude manifest-backed package, only entry commands, agents, skills, hooks, outputStyles, and themes participate in merging and strict conflicts. Entry MCP, LSP, userConfig, channels, apps, and UI fields do not replace the manifest. Explicit Claude skills paths add to the default skills directory. Claude MCP configurations merge the default file first and explicit documents afterward, with the last definition of a server name winning. Manifestless explicit lists remain entry-scoped. ZCode adds its default skills directory to explicit paths. Markdown Commands expand through ordinary message submission. Agent templates use existing Profiles. Unsupported frontmatter, UI, host-specific SDKs, and hook semantics remain component diagnostics.

Relative directory sources and the `directory` type stay within the marketplace root. A `github` source normalizes to the existing pinned Git path and uses explicit resolution and review. HTTP JSON marketplaces, marketplace archive sources, command sources, and pip are outside this release. Manual ZIP import is a separate path and does not prove marketplace archive-source support. Source fields are interpreted by their format; a Git URL is not guessed to be a JSON catalog.

Project-scope choices are isolated by the actual execution workspace path. A choice for the original workspace does not automatically enable the plugin in another worktree. Check the plugin scope for each new execution directory separately.

`sourceDigest` always describes the candidate's original package bytes. Candidates that consume marketplace definitions also expose `admissionDigest`. Installation uses `admissionDigest ?? sourceDigest` as `expectedDigest`; GUI and CLI select it automatically. `installedDigest` identifies the effective installed snapshot, while `installedSourceDigest` identifies its original package bytes. Changing only an entry's component selection, source, or execution prerequisites requires renewed review. Installed reads, restart, and historical references use the fixed definition rather than the mutable marketplace. Existing packages without catalog context keep their old digests and receipts. An older client that submits only a raw package digest cannot install a candidate requiring the new review identity.

A maintained portable package can set `extensions.org.areal.hostRequirements` to `{"version":1,"tools":["browser_v1"]}`. Requirements restrict eligibility; they do not register, enable, or authorize tools. Desktop checks the current deployment before preparing a trial draft. Core checks actual conversation and Turn tools and Profile limits. When computer control is off or uses another provider, a Skill requiring `computer_v1` does not switch input channels automatically. Tool presence does not certify OS permission. Existing owners still enforce approvals, system permissions, Stop, and UNKNOWN. AReaL does not infer a complete dependency graph from arbitrary Skill prose without structured declarations; behavioral compatibility remains unverified.

The repository's [local marketplace example](../../examples/plugin-marketplace/README.md) contains AReaL browser and computer adapter Skills using existing tools, plus a pinned official Heptabase source. The browser and computer packages do not claim unchanged ZCode JavaScript SDK execution. Skill creation keeps the existing **Create Skill** flow and pinned official Creator. Discovery, artifact creation, and publication remain separate operations.

To install official Heptabase, select **Heptabase** in the example marketplace, or add `https://github.com/heptameta/heptabase-agent-plugins.git` as a Git marketplace at ref `7cae4b5988bb4a2875e7ba9ea3f9eec12c644826`. Resolve the source, preview it, review the digest, and install it into the selected project. The example catalog pins the original `plugins/heptabase` package at version `0.2.0`. It retains the portable manifest, MCP, Skills, license, and Codex overlay with its `.app.json` registration. Verification covers importing and installing the original package. The Heptabase App ID currently has no AReaL Connector mapping, and its MCP declaration does not explicitly declare OAuth. Account connections and real tool calls are not yet supported by this integration.

## Plugins, Skills, and MCP

The global **Plugins** entry opens the marketplace. Public and Personal list registered sources. Skills and installed plugins share this workspace navigation. A plugin or Skill opens a content page with a return path. The Skills installed overview initially shows six items and expands with Show more. Personal and project tabs below show installed Skills from each source and retain separate expansion state. Search shows all matching results. Management uses the previously selected project. Select or open a project when none is selected. Browsing does not create a task directory.

**Settings → Plugins** manages installed plugins, MCP servers, Skills, and marketplace sources. Skills and MCP include standalone resources and installed package components, with their sources shown. Resources with the same name retain separate owner identities and configurations.

Packages follow the OpenAI plugin layout. Portable packages use root `plugin.json`, `skills/`, and `mcp.json`, with OpenAI-specific settings under `extensions.com.openai`. Compatibility manifests use their documented dialect-specific subset. AReaL keeps installation, selection, authentication, and connections with their existing owners, without rewriting package declarations.

When you add a standalone MCP server at user scope, disconnected projects do not block saving. The configuration persists immediately and synchronizes to ready projects. Projects that are not ready synchronize when you explicitly start them or connect an MCP server. Pending operations still require reconciliation. Before editing an existing user MCP, restore all started project connections and disconnect that MCP's active connections.

Standalone Skills have content pages and scoped enable controls. **Create Skill** checks the selected project’s current deployment, then opens that project’s ordinary draft with the product’s pinned official Skill Creator selected. Existing tasks keep their original profiles. Under the bundled deployment, a saved base profile uses the current resource version. Custom restricted profiles receive no additional permissions. After the user sends a request, the Agent follows Creator to create and validate the Skill in that project’s `.agents/skills/<skill-name>/` directory. The resource retains its upstream revision, license, and content digest. It does not read another agent application’s local configuration. Standalone MCP servers retain configuration and connection controls. The scope selector filters only standalone resources. Package components show current-project choices. Manage in a detail page opens settings for that plugin and retains package scope, digest trust, authentication, and submission recovery. Each Skill and MCP server has a project switch. Off choices survive updates and clear on uninstall. Package declarations and the conversation Profile still restrict effective access. Package components cannot be modified through standalone resource commands. Listing a resource does not expand a chat's allowed skills or tools.

The official Creator initialization and validation scripts require Python 3 and PyYAML. Selecting a Skill does not expand Runtime filesystem permissions. Restricted tasks read script pages with `skill_read`, then use Runtime tools to materialize the returned original bytes in authorized workspace scratch before execution. They do not execute files directly from Desktop's private cache. `clients/gui/scripts/plugin-concepts-smoke.mjs --creator-only` verifies resource reads, project-local creation, and official validation in an empty project's first ordinary turn. Set `AREAL_TEST_PYTHON` to select an interpreter that can import `yaml` with an isolated HOME and user site-packages disabled.

Interactive apps and hooks remain in package details or existing workspace entrypoints. Users manage GitHub as a plugin. Connector remains an internal service mapping and credential binding.

The detail page uses the installed version's actual description, examples, and declared components. Source review shows the candidate separately. Empty Skills/MCP sections are hidden. Website and legal URLs can be copied. Skills-only packages need no account. Skills in mixed packages do not wait for MCP authentication. Installation does not connect services. Browser authorization, key configuration, Connector mapping, and connection keep their explicit per-service steps.

Type `@` in an ordinary conversation or a new draft to select an installed, enabled plugin that is available in the current context. Selection inserts a plugin chip without sending. The same menu retains MCP resource search. Before send, the Composer checks the installed digest, captured exact Skill references, and enabled services, then supplies readable plugin intent and permitted Skill content to the model. Disabling, updating, or uninstalling after selection blocks submission and preserves the draft. Removing a plugin chip removes only its implicit Skills; independently selected Skill tags remain. Side chips are labeled Reference only and supply intent under the existing read-only policy.

Disabling a Skill denies discovery, retained-version reads, and setup immediately. Changing any MCP switch revokes all of that plugin's connection generations and removes automatic reconnect trust. Enabled sibling services also require explicit reconnect. Enabling does not authorize or connect. When cleanup is UNKNOWN, the off choice is already saved but process exit is unconfirmed. Inspect the original receipt instead of repeating an unknown write.

## Discovery and installation

Declare a local package in project/personal `.agents/plugins/marketplace.json`:

```json
{
  "name": "team-tools",
  "plugins": [{
    "name": "review-helper",
    "source": {"source": "local", "path": "./plugins/review-helper"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
    "category": "Productivity"
  }]
}
```

Paths resolve against the marketplace root, not the catalog directory. Use **Add → Add marketplace** in the marketplace to add a local root or Git source, inspect components, and install. Installation binds the selected source and digest; changes after preview require refresh and renewed selection. Installation runs no scripts, MCP, hooks or setup.

Use **Add → Upload plugin package** to select a local ZIP. Review its digest before installation. The ZIP may contain the package root or one enclosing directory. Both compressed and expanded content are limited to 64 MiB, with at most 4096 entries. Links, path escapes, duplicate paths, encryption, split archives, and ZIP64 are rejected. Import does not execute the plugin.

CLI commands connect to an already running Core with its configuration:

```sh
areal service ensure --workspace /absolute/workspace --json
areal plugin --workspace /absolute/workspace list --json
areal plugin --workspace /absolute/workspace marketplace-add /absolute/marketplace
areal plugin --workspace /absolute/workspace marketplace-add-git https://github.com/TEAM/catalog.git --ref-name main
areal plugin --workspace /absolute/workspace resolve review-helper@team-tools
areal plugin --workspace /absolute/workspace read review-helper@team-tools
areal plugin --workspace /absolute/workspace install review-helper@team-tools --scope project
areal plugin --workspace /absolute/workspace setup review-helper@team-tools
areal plugin --workspace /absolute/workspace connect review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST
areal plugin --workspace /absolute/workspace mcp-list
areal plugin --workspace /absolute/workspace disconnect review-helper@team-tools
areal plugin --workspace /absolute/workspace disable review-helper@team-tools --scope project
```

An explicit project selection overrides the user default; neither represents an enforced requirement. The product-generated ordinary standard Profile explicitly enables `allowPluginSkills` and can select Skills from enabled plugins. Other explicit Profiles do not inherit plugin Skills unless they declare that permission. MCP connections require explicit trust in the installed digest; Connectors require an original-ID mapping and account credentials. Unsupported hook handlers, authentication mechanisms, and commands remain diagnostic. Unsupported package dependencies or userConfig semantics block effective activation. Installed does not mean connected.

## Skills and setup

Ordinary chats can select enabled package skills. Skills that prohibit implicit invocation remain available for explicit selection. Resources use paginated lazy reads. Shared package resources resolve relative to the skill while remaining within its pinned package root. Standalone skills retain live-file and traversal contracts.

Rust embedders enable plugins through `Engine::install_plugin_store`. Pure Engine sessions without a default Profile or plugin Store retain their lightweight state; the presence of plugin code alone does not inject desktop instructions or change context budgets.

Run Setup selects the packaged onboarding skill in an ordinary chat, with results and approvals accessible there. It uses ordinary Core inference and submission receipts, not privileged installation scripts. Side and restricted Profiles cannot expand their boundary through setup. Configure a usable model before running setup.

## Versions, disabling and recovery

Installed copies retain content identity; source edits do not change installed resources. Active Turns pin skill revisions; subsequent Turns use available versions. Disabling/uninstalling revokes subsequent reads while retaining historical packages and writable data. Explicit connection starts MCP. Active Turns retain their admitted generation; disable/uninstall revoke subsequent calls and reads. Unconfirmed process cleanup blocks reconnection. Hooks require separate current-definition trust; see the P2 section below.

Applying standalone skill configuration to a new chat can restart Core. The desktop restores previously connected standalone MCP servers and trusted plugin MCP connections. Plugin restoration still requires the original installed digest. Failures do not replay tool calls. After creating a chat, an interactive app reads the current connection for the same plugin version before its first open request.

For ordinary conversations, Core saves the message and submission receipt before automatically reconnecting trusted plugins for the first model request. Accepted messages remain visible while plugin authentication or initialization waits. The model request starts after preparation. Cancelling the Turn retains shared connection cleanup; pending preparation remains an unsettled lifecycle resource. Reconnection uses only trusted plugin digests allowed when the Turn was admitted and does not expand restricted Profile permissions.

Mutations require `requestId` and applicable `expectedRevision`; RPC installation additionally requires selected `source` and `expectedDigest`. Identical requests recover their prior result; reused keys with different parameters reject. Check Plugin Submission queries receipts after an unknown outcome without replay:

```sh
areal plugin --workspace /absolute/workspace submission REQUEST_ID
```

Successful marketplace add, remove, update, and plugin uninstall return `{"revision":N,"catalogRefreshRequired":true}` when the complete catalog receipt exceeds 256 KiB. The mutation has completed at revision N. Read `areal/plugin/list` for the complete current catalog. On this marker, CLI reads the current catalog once and prints it to stdout. Its stderr notice identifies the request ID, original receipt revision, and current catalog. If that read fails, CLI still reports the successful mutation and its request ID. Do not replay the mutation. `submission` preserves the original historical receipt without replacing it with a current catalog read.

Core enforces permissions; observers and Thread-scoped identities cannot perform global plugin management. State lives under the Core configuration home's `plugins/`, without modifying Codex caches/configuration.

## Current limits

Git/npm sources, modern MRTR, native stdio resource snapshots, portable auth, App subscriptions and explicit GitHub mapping are implemented. Full compatibility is not accepted: P2 hooks, private OpenAI catalog/sharing, cross-platform, real provider OAuth and signed/notarized package evidence remain open. Some local subprocess checks receive unexplained SIGKILL. Source completion and partial passes do not close full acceptance. Hosted service methods return explicit capability errors. See the [acceptance matrix](../development/codex-plugins-p1-p3-acceptance.en.md).

## Git/npm and MCP

Add a Git marketplace in the GUI. Entries accept `git-subdir` with `url/ref/path` and `npm` with `package/version/registry`. Resolve and preview before installation, reviewing the pinned commit, concrete npm version, integrity and content digest. Git refs and npm ranges become immutable candidates; installation runs no lifecycle scripts. Candidate and installed digests remain separate. Explicitly trust the installed digest before connection, and review upgrades again.

GUI Git marketplace add and marketplace update requests wait up to 120 seconds within the outer 150-second service deadline. A timeout or disconnect can leave an unknown result. Check the original submission receipt without automatic resubmission.

Portable and legacy adapters normalize fields privately. Auth supports provided/DCR/CIMD preference, declared endpoint/resource/OIDC/scope overrides and API-key bearer/basic/custom headers. CIMD preference without a trusted host metadata URL falls back to DCR; it never impersonates an OpenAI client. Main stores client secrets and signing keys securely; Core stores references. ON_INSTALL exposes pending authentication and gates declared auth services; ON_USE requests auth when needed, allowing mixed public access anonymously. OAuth uses PKCE and private storage. Empty scope overrides remain exact through refresh. Challenge-driven upgrades retain proven grants across cancelled retries in the same binding; pending requests are not grants and new configurations/accounts do not inherit them. Private challenges reject the exact sent token without deleting concurrent refreshed tokens or replaying MCP operations.

Cached credential recovery discovers authorization metadata without probing the original MCP resource endpoint. Standard well-known locations or explicitly configured endpoints support silent recovery. A service that exposes metadata only through a custom authentication challenge requires explicit authentication after a cold start to recover that discovery path. Challenges and scopes from real requests remain intact, and authentication never replays the rejected MCP operation.

Codex marketplace/add accepts top-level sparsePaths. Nonempty paths use Git cone directory selection, retained across updates. Callers include the catalog and required package paths; selection is never silently widened. Missing/empty paths retain full checkout; local directory sources reject nonempty sparse selection.

Git marketplace snapshots allow at most 20,000 files and 20,000 filesystem entries. Individual plugin snapshots retain their limits of 4,096 files and 8,192 filesystem entries. Both snapshot types allow at most 64 MiB per file and in total, excluding `.git`.

## Desktop Apps and GitHub

Opening an app for the first time from package details or another global entrypoint uses the selected existing conversation, preserving its execution workspace, project plugin choices, and connection trust without sending its draft. Before invoking the initial tool, the app opens that conversation so any ordinary tool approval is visible. From a new draft without a conversation, select an existing conversation in the sidebar before opening the app. Global entrypoints do not create or choose another conversation automatically. Selecting an already open app returns to its original conversation while that owner remains available. Composer conversation entrypoints and file entrypoints can still create a conversation for a new draft through ordinary admission. An app's explicit request for a new conversation also uses ordinary admission; a new execution workspace does not inherit the source workspace's project plugin choices or connection trust.

Interactive apps in package details and global/thread/file entrypoints use the official MCP Apps AppBridge. A package detail shows only its own apps and app settings. Pages run under isolated origins in sandbox frames with no Node, product bridge or credentials. Calls bind project, Thread, package digest and connection generation, stay on the originating server, and use ordinary Core execution, approval and journal paths. Apps become stale after Core restart and must be reopened. Within a window, tab switches, panel hiding, conversation and project navigation, settings, and scheduled tasks retain the same live page and bridge, including unsaved text, selection, scroll position, subscriptions, and in-flight requests. Explicit close, conversation archive, or source revocation releases the page. Each window allows eight live or opening pages. At capacity, new pages are refused until a page closes. Background `send:true` messages stay with their original conversation. Background requests to create a conversation or edit the composer return `app_hidden` and leave the selected view unchanged.

Newly completed MCP tool records in ordinary conversations can offer “Open interactive result” when their original source is verifiable. Opening uses that call’s saved arguments and result, including page-only `_meta`; the model projection still strips private metadata. Opening, repeated clicks, and explicit reopening after close never repeat the original business tool. Repeated clicks focus the same page; hiding or switching views preserves edits, selection, and scroll. Older history without source proof stays readable and never mounts automatically.

Result resources accept `text/html` and `text/html;profile=mcp-app`, with a 2 MiB UTF-8 limit and existing CSP and sandbox restrictions. Failed, cancelled, UNKNOWN, corrupt, changed/disabled/uninstalled, disconnected, or previous Core-process sources cannot open. Resource or bridge initialization failure, or failure to become ready within 10 seconds, closes the page and falls back to the original record; this does not identify every possible CSP failure. When opening or closing remains uncertain, another click reconciles the same intent without automatically creating a new request.

A pinned page can declare the experimental `areal/page-tools` capability during SDK initialize, with only `getSelection` and `applyPatch` guarded by `expectedDocumentRevision`. Trusted Main registers after initialization. The Agent uses ordinary Core ToolCalls to access that page's unsaved selection or text, subject to approval and cancellation. A stale revision returns a conflict. Ambiguous results remain UNKNOWN and never replay automatically. Hidden pages remain callable. Losing an original connection retains page content but revokes tools until an explicit new instance opens. This extension does not establish support for every third-party editor. See the [finite page-tool contract](../api/desktop.en.md#finite-page-tools).

`ui/message` adds typed text/resources to drafts while preserving unfinished human input; only `send:true` submits. Titles and `_meta` stay in UI/history; recursive `_meta` removal precedes model projection. Context is grouped by instance and can be updated/removed. Settings, mentions and form previews use advertised tools/resources, without guessed methods or endpoints.

GitHub preserves the original `.app.json` Connector ID. Enter that ID and a GitHub token in plugin details, save through system secure storage, then explicitly connect. Core maps that configured ID to `https://api.githubcopilot.com/mcp/`; opaque IDs never imply a provider. Missing mapping, missing credentials and unsupported declarations are distinct. `scripts/plugin-github-smoke.mjs` uses a pinned official GitHub package and real MCP to read the public `openai/plugins` marketplace file. The model is a local deterministic service. GitHub HTTP, desktop user paths, and real model providers have separate acceptance evidence.

File entrypoints expose opaque URIs. Core validates saved grants and reuses Runtime descriptor traversal for actual I/O; Main owns windows/watchers. Reads are capped at 2 MiB, atomic writes at 64 KiB with `too-large` responses. ETag/CAS and durable request receipts ensure same-key retries return prior results without overwriting later edits.

Modern MCP 2026-07-28 supports MRTR forms; direct older connections retain legacy elicitation. Each round preserves original arguments and Core ownership, rechecks authority and never replays UNKNOWN. Resource updates target subscribed App/URI owners; the final owner releases the shared wire subscription.

Native form selection imports immutable local file/directory snapshots: 16 MiB per file, 256 files/64 MiB per logical call and depth16. Grants bind form, field and server generation, and clear on cancellation, close, revocation or settlement. Only same-host stdio receives these snapshots. HTTP without a publicly defined upload channel returns explicit unsupported behavior while server-provided resources remain selectable.

## Hooks (P2 candidate)

Package, user and project hooks share the Core execution owner. User sources are `hooks.json` in the selected home and `[hooks]` in the selected TOML; project sources are `.codex/hooks.json` and `[hooks]` in `.codex/config.toml`. JSON precedes TOML cumulatively within each layer; package declarations retain their original format and overlay rules. Project files supply only hooks and cannot replace models, credentials or the user feature gate. Codex `hooks.state` trust claims are not imported.

In Settings → Plugins, review the current package/source digest, definition digest, events, matchers, command/MCP inputs and full definitions before checking the explicit consent box. User/project sources require separate review. Installation, activation and MCP connection do not authorize hooks; changed definitions require a new review. CLI commands use the same Core state:

```sh
areal plugin --workspace /absolute/workspace hooks-list
areal plugin --workspace /absolute/workspace hooks-trust review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST --definition-digest REVIEWED_DEFINITION_DIGEST
areal plugin --workspace /absolute/workspace hooks-revoke review-helper@team-tools
```

Wired events are SessionStart/SessionEnd, UserPromptSubmit, PreToolUse/PermissionRequest/PostToolUse, PreCompact/PostCompact, SubagentStart/SubagentStop, Stop/Interrupt. Commands use existing Runtime scopes; MCP handlers call only already-connected, still-authorized package tools without recursive model-tool approvals. MCP active execution time pauses during real human form waits while cancellation and revocation remain live. Denial, input rewriting and feedback after actual tool completion are independent; Stop may continue within one Turn, and automatic continuation does not synthesize user submissions. Package commands receive package/data environment variables; configuration commands receive neither package environment nor additional path authority. Provider secrets do not propagate to hook descendants.

Core retains admission records in `desktop.hookRuns`. UNKNOWN blocks further execution; after inspecting actual effects/resources, `areal/hook/acknowledge` stores a bounded explanation while retaining UNKNOWN and never replaying. Archive and close cancel and join admitted tasks before SessionEnd; closing Sessions reject new Turns. Background results project only at safe points or the next user Turn, without starting an idle Turn.

Trusted command hooks now use bounded Runtime task write groups: same-task hook/tool overlap is admitted within a fixed window; ordinary/ordinary and cross-task conflicts remain exclusive. The window cannot be extended, and operations after sealing may queue behind foreign tasks. P2 remains open: Side, research and restricted Profiles remain excluded; ordinary read-only children require separate command consent. Windows shell, the full configuration stack and pinned Codex binary comparisons are unaccepted. See the [P2 matrix](../development/codex-plugins-p2-acceptance.en.md).

Ordinary read-only child command hooks require a separate consent box after reviewing the current definitions. CLI adds `--allow-read-only-commands` to `hooks-trust`; leaving it out removes this extra consent. The workspace/package remain read-only, private child scratch and own plugin data are writable, and network/provider-secret inheritance is denied. Redirected data directories reject execution. Side, research, nativeTaskAgent, restricted Profiles and read-only root Sessions remain excluded; MCP handlers are excluded from this consent.

## Offline snapshots and diagnostics

`areal plugin snapshot --json` and `areal plugin doctor --json` read the plugin Store directly, including an uninitialized configuration home. Reads do not start Core or contact plugin services. Use `--config-home /absolute/home` to select the configuration home and `--workspace /absolute/project` for project overrides. Omitting workspace selects user scope. Snapshots retain candidate and installed digests and include the observation time and revision. Doctor reports static facts. `runtimeObserved: false` means live connection state has not been observed.


## Commands, Agents, and user configuration

Commands read Markdown from the selected overlay's `commands` paths and format-specific default directory. Each command retains its plugin namespace and installed digest. Bodies support `$ARGUMENTS`; without a placeholder, the original arguments are appended. Substitution happens once, so shell expressions inside arguments remain literal text. Expansion checks the final size before allocating it and rejects output beyond the ordinary 1 MiB input text budget. Supported frontmatter consists of `description` and `argument-hint`. Positional arguments, shell substitution, model or tool permission overrides, and unknown fields produce an unsupported component.

Agents read immutable templates from selected `agents` paths. Supported fields are `name`, `description`, `model`, and comma-separated `tools`. Models and tools must map exactly to the current Core catalog. `permissionMode`, memory, hooks, unknown fields, and other host-specific semantics are rejected explicitly. Templates execute through existing Profiles and child tasks, retaining the parent's tool, read-only, and approval restrictions.

`userConfig` supports explicit `string`, `boolean`, and `number` types with `title`, `description`, `required`, `sensitive`, and non-sensitive `default`. Sensitive fields must be strings, store credential references, and cannot declare defaults. Public reads return field definitions, non-sensitive values, configured flags, and missing required keys. Secrets and private references do not enter public details or model input.

Only MCP `${user_config.KEY}` references are supported. Ordinary values can enter env, headers, args, and URLs. Sensitive values are restricted to env and headers. Other syntax and consumer positions are rejected. Configuration uses the existing CAS and receipts and participates in connection identity. Changed configuration requires new connections to use the new values. Package updates and uninstall retain the last configuration revision. Values do not carry across package digests, and package updates cannot restore eligibility to retired connection generations.

```sh
areal plugin --workspace /absolute/workspace configure sample@local --values-file /absolute/values.json
areal plugin --workspace /absolute/workspace configure sample@local --values-file /absolute/values.json --clear optional_key
```

The value file maps field names to typed values, for example `{"device":{"kind":"string","value":"iPhone 16"}}`. Trusted CLI callers can provide `secretRef`; sensitive plaintext is rejected. Only submitted fields are updated. `--clear` removes named fields explicitly.

## Local development snapshots

`areal plugin dev-link ID --expected-digest INSTALLED_DIGEST` links an installed local package to its original directory. `dev-unlink ID` stops automatic updates. Both require the selected workspace Core. Links persist across restarts. Source changes publish a new immutable snapshot through the existing installation path. Active Turns retain the old version; later Turns use the replacement. Refresh preserves user and project enable choices. One invalid source does not block other links, and failures retain the last successful snapshot. A new digest does not inherit MCP or Hook execution trust.

Offline doctor's `state` and `nextAction` describe statically observable actions. `staticReady` means supported static components are present; session Profile admission still applies. Missing required values produce `configurationRequired`. Development source errors and pending refresh have separate states. `candidateAvailable: false` means the candidate cannot be read. Its fallback digest is historical display data and cannot authorize installation.
