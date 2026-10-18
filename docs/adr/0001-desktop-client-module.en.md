[中文](0001-desktop-client-module.md) | **English**

# Place the complete desktop client in the Clients layer

This client ownership design is accepted and implemented. The complete desktop client belongs in `clients/gui`, alongside CLI, TUI and future mobile clients in the Clients layer, using public Core capabilities. Core/Runtime retain authority over sessions, history and execution. Peer clients need not have identical features.

The migration includes the interface, Electron host, Core connection, native capabilities and dependencies required to build and package the application. Moving interface source alone cannot produce a runnable desktop application; keeping the complete desktop client in an external repository would not establish unified client source ownership. This migration covers GUI first; mobile follows separately.

The target GUI excludes legacy DSH GUI features and entry points. Cleanup in the source repository follows acceptance of the new GUI; this decision does not remove other existing DSH adapters from the target repository.

The target repository is intended for open-source publication. Import only reviewed file snapshots, without merging the source repository's Git history, to avoid importing non-public material removed from current files. Select publishable files according to runtime, build and verification needs, retaining required licenses and third-party attribution. Do not directly copy development capture materials, Skills or AGENTS documents. Any required content from those sources needs a separate suitability review; credentials, personal information and internal materials must not be imported. Exclude signing and notarization certificates, private keys, accounts, private configuration and operation records. Public build flows retain only generic external configuration interfaces, without actual signing or notarization information.

## Behavior and acceptance boundaries

Existing modern GUI features and interactions form the regression baseline, including desktop-side mobile pairing. Deferring mobile source migration does not remove desktop compatibility. Replace internal dependencies or report explicit blockers instead of silently deleting features to complete the migration. Retain the source repository's runtime interface icons, provider icons and application icon without replacement during migration; associated capture archives remain excluded.

GUI follows the target repository's shared Core service lifecycle: closing a window or exiting GUI does not terminate Core tasks; stopping the service is an explicit action. Reopening GUI must restore task state. This migration does not add desktop notifications or mobile control after GUI has fully exited; existing mobile pairing remains available while GUI runs.

This migration validates a fresh installation first, preserving existing installations and data without taking them over automatically. Importing old data, replacing applications and connecting automatic updates are subsequent steps.

Acceptance requires the target repository to install public dependencies independently, build, start and produce a desktop package for local installation checks, with repeatable end-to-end evidence for key user workflows. This migration validates macOS Apple Silicon. Existing cross-platform code remains, without claiming validation on Windows, Linux or Intel Mac. Signing, notarization and public release are outside the execution scope. See the [GUI guide](../../clients/gui/README.en.md) for running and verification commands.

See the current [architecture](../design/architecture.en.md) and [product vocabulary](../../GLOSSARY.en.md).
