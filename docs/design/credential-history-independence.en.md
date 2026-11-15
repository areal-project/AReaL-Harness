[中文](credential-history-independence.md) | **English**

# Credential upgrade reliability and independent history reads

Status: proposal, not implemented. This document separates source findings from an unconfirmed user installation failure.

## Intent and decisions

Existing messages must remain readable after provider configurations or credentials disappear. Investigate credential failures after replacing the application, compare other implementations, and provide actionable recovery UI.

Recommended design: retain Host-owned system credential storage and separate Store access from execution preparation inside the existing Core. Do not add a second history database, a history process, or direct client database access. This proposal does not change the Core Store format, migration contract, or data directories, and does not add credential synchronization. Host authentication, device authorization, and project read permissions remain mandatory; provider authentication is a different concern.

## Findings

`credentialsRequired: missing credential environment AREAL_CREDENTIAL_...` originates in `core/host/src/launch.rs::prepare`. Host restores per-project launch inputs, resolves configuration, and rejects missing credential names outside the current model credential set. `server.rs::ensure_inner` appends current shared model references and reduces certain storage failures to absent values.

A statically supported failure path is: an old launch reference survives provider removal, no longer belongs to the current model catalog, has no available value, and blocks project startup as an unrelated credential. History then becomes unavailable. The screenshot alone does not establish this path or prove deletion of a stored secret.

Upgrade-related possibilities:

1. **Access identity changes.** `credential_io.rs` accesses Keychain through a child of the current Core executable. The old signing script did not explicitly set a stable Core identifier. Commit `c5da41135b1e2e5a2aa5898e50f6b950953a7390` adds stable identifiers, including `org.areal.harness.core`, and isolates development Hosts. Build-derived identity changes are a concrete access-continuity risk, but the affected old/new packages, designated requirements, TeamIdentifier, Identifier, and OSStatus must establish the user's cause. A new stable identifier does not automatically repair old item permissions.
2. **Namespace changes.** Keychain service names use `org.areal.host.v1.<canonical Host home digest>`. Slots also depend on sourceId, reference, and entryId. Application paths are not directly part of this service name; changing Host home/Space or source metadata can select different records. Replacing only the application should preserve access when these identities remain unchanged. Space isolation is intentional; do not search other Spaces automatically.
3. **Incomplete legacy import.** Electron safeStorage ciphertext is decrypted by the original GUI and imported into Host Vault. Source identity, slots, and receipts must agree. Authorization denial or interrupted import must remain recoverable rather than appearing unconfigured.
4. **Collapsed diagnostics.** `credential_io.rs` maps item-not-found to no value and other OSStatus values to `storageLocked`. Host reduces `storageLocked/storageMissing` to absent credentials. Workbench preserves locked/pending projections but does not expose missing entries equally distinctly. The final startup error loses the reason.

Retain the useful existing foundations: system storage, one Host owner, revisioned slots, write/read-back verification, and operation receipts. Confirmed design gaps are insufficient error classification, coupling of reads to execution assembly, and treating historical launch references as current prerequisites. No evidence here establishes that replacement installation actively deletes secrets.

### Evidence still needed

Obtain the affected old/new versions, installation channels, and packages. Collect only sanitized metadata: signature identifiers and designated requirements, Host home identity digest, sourceId, reference, slot revision, registered-entry status, OSStatus, migration phase, and original receipts. Never output secret values, tokens, complete environments, or unfiltered configuration.

Use an isolated home and synthetic secret for a real old-package write → replacement upgrade → noninteractive read. If it fails, explicitly authorize an interactive read to distinguish access restrictions. Separately cover stale references, missing source records, and interrupted imports. Do not delete/rewrite entries or replay unresolved writes to hide the failure. Real user data remains read-only; unlock requires an explicit user action.

## Comparison with other projects

These are static observations of pinned source, not runtime acceptance or whole-project security assessments.

| Project | Observed implementation | Decision |
| --- | --- | --- |
| VS Code | EncryptionMainService uses Electron safeStorage; SecretStorage separates encryption from persistence and sequences operations per key. The inspected `get` implementation removes the encrypted record after a read/decryption exception. | Borrow interface separation, not delete-on-failure behavior. Do not move ownership back into Electron: Headless Host must continue to work. |
| Zed | Release channels use KeychainCredentialsProvider; development defaults to separate development credentials. ThreadStore loads directly through ThreadsDatabase. | Borrow release/development isolation and independent history loading, not development plaintext storage. |
| OpenCode | Credentials have independent IDs, selection, and updates. Session Store depends on Database; credentials live in a separate module. | Borrow separation of selection, credentials, and persisted sessions. This does not prove every UI path is provider-independent or justify changing encryption. |

Pinned sources:

- [VS Code encryption](https://github.com/microsoft/vscode/blob/a389cd7c5195662c3e3998d4ba10604ff5cdaa70/src/vs/platform/encryption/electron-main/encryptionMainService.ts), [secret storage](https://github.com/microsoft/vscode/blob/a389cd7c5195662c3e3998d4ba10604ff5cdaa70/src/vs/platform/secrets/common/secrets.ts).
- [Zed credentials](https://github.com/zed-industries/zed/blob/703b5ac3f4ffe1e87a073123ae56e22f72f095c4/crates/zed_credentials_provider/src/zed_credentials_provider.rs), [thread store](https://github.com/zed-industries/zed/blob/703b5ac3f4ffe1e87a073123ae56e22f72f095c4/crates/agent/src/thread_store.rs).
- [OpenCode credentials](https://github.com/anomalyco/opencode/blob/38bd73789a43bf043599d6196af96583228035d7/packages/core/src/credential.ts), [session store](https://github.com/anomalyco/opencode/blob/38bd73789a43bf043599d6196af96583228035d7/packages/core/src/session/store.ts).

## Dependency boundary

```text
Client → Host identity/authorization/project routing → Core Store, history, receipts
                                                    → execution admission → config → credentials → Runtime/provider
```

History requires project/storage identity, read authorization, supported storage format, and resource bounds. It must not require a provider, a resolvable default model, Keychain availability, model connectivity, or valid MCP/tool deployments. Existing `load_management_config` still validates configuration structure; another missing-key exception is insufficient.

Keep one Core process and writer. Base startup opens Store and exposes history, receipts, and configuration diagnostics; execution assembly produces separate readiness. Split storage identity and read limits from execution fields. Reads must not parse provider sections or fail on invalid provider TOML. Use registered project identity and safe fixed/default read limits or independently controlled arguments, not an arbitrary fallback for the entire invalid execution configuration. Report configuration failures and continue rejecting execution.

Owners:

- Host `launch.rs/server.rs`: base startup does not enumerate/read all credentials or snapshot execution deployment. Persisted credential_names is not history admission. Resolve actual dependencies at execution preparation, using current or already frozen configuration.
- Core server/config/engine: separate Store assembly from execution preparation. History, receipts, and stored artifacts do not instantiate model clients or load plugins. Cancel/stop for admitted tasks stays available without re-resolving removed providers. Never report execution-ready after suppressing errors.
- Workbench model configuration, history observation, and connection modules: catalog, diagnostics, and credential status may fail independently; history waits only for base service readiness, not global provider initialization.
- Protocol and clients: extend existing project status/error envelopes with independent read capability and execution readiness as needed. Generate Rust/TypeScript together; do not label the entire project unavailable when only execution is blocked. Exact schema names are implementation decisions.

Persisted provider/model identifiers are historical facts, not foreign keys requiring current catalog entries. Render stored names/IDs; when unavailable, show the existing ID or “Original provider removed.” Do not guess missing names, rewrite old records, or retain fake providers. Missing artifact bytes are a separate error.

Read readiness must not start queues, Goals, or schedules. New sends, continuations, and scheduled work use execution admission. Admitted tasks retain frozen configuration and identity; missing credentials block execution without silently switching providers. On recovery reconcile original receipts and follow existing continuation semantics. UNKNOWN never authorizes automatic resubmission with a new request ID.

## Credentials and upgrade behavior

Distinguish available, notConfigured, missingEntry, interactionRequired, accessDenied, migrationPending, referenceUnresolved, and storageError internally, reusing current codes and adding structured detail where needed. Classify OSStatus from documented meanings; unknown errors remain storageError. Clients receive status, provider/reference association, and permitted recovery actions, never secrets.

Keep the existing Keychain backend and service namespace in this scope. Preserve Space isolation and source/slot identity; application versions/build hashes must not determine lookup identity. Retain stable Core signing identifiers and validate actual old/new designated requirements. For previously unstable identities, expose explicit system authorization; successful access restores the same slot rather than deleting it or inventing a replacement reference.

Background reads remain noninteractive. “Unlock credentials” explicitly enables interaction. Missing entries can be re-entered for the correct provider; unresolved references require selecting a valid provider for future execution. Read failures never delete ciphertext/slots or persist empty cache values as user clearing. Keep existing migration transactions and receipts; add upgrade acceptance rather than another migration mechanism.

## Interaction

Render old messages first. If current execution configuration is unusable, show “Current model unavailable; history remains readable” near the Composer, disable affected sends, and offer the relevant recovery action. A removed provider referenced only by old messages does not require a persistent warning when current sending works. Technical details retain diagnostic codes; normal UI does not display internal environment variable names.

| State | Action |
| --- | --- |
| System authorization required | Unlock credentials, then refresh readiness |
| Current key unconfigured/entry missing | Open the corresponding provider settings and save a key |
| Current provider removed/reference unresolved | Select a valid provider/model without altering history |
| Legacy import pending | Inspect import status and continue the original operation |
| Unknown storage failure | Show sanitized diagnostics for support |

Desktop, web, and mobile consume the same Host history/status contract. Devices without credential-management permission show “Resolve on the host,” never request or display secrets. Recovery retries safe reads; execution follows original receipts. Users should not manually create random AREAL_CREDENTIAL variables, delete projects, or clear application data.

## Acceptance and order

Establish failing isolated behavior tests before changing shared boundaries:

1. Persist multiple pages of messages and artifact references, remove all providers/credentials, restart, and read identical history with zero model network calls.
2. Invalid provider syntax, deleted defaults, stale references, locked/missing Keychain entries, and missing plugin execution credentials preserve history/receipt reads. Actual Store damage and read authorization failures still fail correctly.
3. Valid configuration restores explicit new sending; invalid configuration rejects sending. Reading does not start schedules, replay unresolved submissions, or mutate frozen running-task configuration.
4. Real signed old/new packages with synthetic credentials prove replacement-upgrade continuity; explicit authorization recovers older incompatible access identities where supported. Denial preserves stored credentials. Headless history remains readable.
5. Shared desktop/web/mobile journeys assert both visible messages and authoritative results; local/remote permissions, reconnect, and cancellation remain correct.

Implement diagnostics and upgrade evidence first, then base startup/history separation, then readiness UI and recovery actions. Independently fix the demonstrated history dependency without claiming every upgrade credential failure is solved.

## Evidence limits

Current source, signing changes, and three external implementations were inspected. `node --test clients/gui/scripts/macos-signing-paths.test.mjs services/workbench/test/shared-credentials.test.cjs` passed all 11 tests. These cover existing signing arguments and credential projection logic, not replacement installation or the affected user's failure. No real secrets or user data were modified. Old/new package acceptance and the proposed product implementation remain outstanding.
