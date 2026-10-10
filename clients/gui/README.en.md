[中文](README.md) | **English**

# AReaL Harness GUI

The complete desktop client contains a React renderer, Electron native adapter, and public dependencies. It is a peer of CLI/TUI/Web in the Clients layer. Core owns sessions, history, model loops, and scheduled tasks; Runtime executes tools. Mobile source migration is deferred; desktop pairing remains available.

## Development

Run from the repository root with Node.js 22.19+, pnpm 11.7.0 and the repository Rust toolchain:

```sh
make build
make gui-install
make gui
```

`make gui-build` builds only the renderer. `pnpm --dir clients/gui typecheck` checks renderer and shared desktop contract JSDoc types (not all Electron CJS implementations); `pnpm --dir clients/gui run verify` checks the public source boundary. This module has its own pnpm lockfile; existing SDKs retain npm. Dependencies use the public npm registry; initial Electron/Core tool installation needs network access.

After installing locked dependencies, `make gui-install` explicitly runs the official Electron installer to download the pinned native runtime.

`AREAL_CORE_BIN` selects an absolute trusted Core path; development defaults to `target/debug/areal`. Development data is isolated under `AReaL Harness GUI Dev/<checkout digest>`; installed builds use `AReaL Harness GUI`. Existing desktop installations and data are not imported or replaced. `AREAL_GUI_USER_DATA`, `AREAL_CORE_HOME`, and `AREAL_HARNESS_SERVICE_HOME` explicitly select isolated directories. Model configuration defaults to the CLI's `~/.areal/config.toml`; Core owns parsing, validation, and saving. `AREAL_HARNESS_HOME` changes the Core configuration home, and `AREAL_CORE_CONFIG` explicitly selects another file. Reads do not create configuration; Core creates the default file on first save. Configuration in old GUI isolated directories is not merged automatically.

Both development and installed macOS builds require a working `/usr/bin/python3` to launch Runtime and trusted tool helpers; install Xcode Command Line Tools with `xcode-select --install`. The interpreter is not bundled. Shared-service startup checks availability and returns an actionable error.

## Composer

Model settings separately show saved enablement, Core credential source (environment, securely stored, or no authentication), readiness, and pending/applied configuration, with a separate indication for unsaved changes. Saving leaves running projects unchanged; applying refreshes Composer's model catalog. See the [configuration guide](../../docs/guides/configuration.en.md#shared-gui-and-cli-model-catalog) for states and the shared interface.

New drafts and existing chats share the grouped action/Skills catalog and search through `+` and `/`. Arrow keys select, Enter confirms, and Esc closes it. Skills attach to the current message; Core reads their content before sending, and failures preserve the draft and tags. An available selected model opens effort first, then the actual catalog; a missing or unavailable selection opens the catalog directly. Core supplies effort values and availability. Models with missing credentials retain their names and show “Missing API Key” as disabled options. “Configure models” opens model settings; the empty catalog's configuration control is also clickable. `pnpm --dir clients/gui run test:model-selection` uses isolated Electron/Core instances to verify the catalog, settings entry, credential save and apply, and model execution. Remote provider support needs separate verification.

While an IME composition is active, candidate text stays in the editor; the final draft synchronizes after commit or cancellation. Enter used to confirm a candidate does not send a message. The text caret uses the foreground color.

A new send or steer clears the previous operation's UI error. A failed attempt still reports its cause and preserves the draft; messages with unknown acceptance are never resent automatically.

Images show thumbnails. “Show in text box” appends UTF-8 text attachments to the body. Pasting more than 200 characters or at least five lines creates a text card; expansion is limited to 1 MiB. Removing files or skills preserves the body. Goal mode uses the same editor; goal creation consumes only the objective and leaves other attachments unsent. `pnpm --dir clients/gui run test:composer` verifies these paths with isolated Electron/Core/Runtime instances.

## Conversation resources

The conversation header's “Task resources” opens a compact popover below the header icon with workspace changes, direct Core child agents, managed background processes, and user attachments and verified file-read sources. Git workspaces retain a review entry when the change count is zero; other empty resource groups are omitted. Changes and processes open the existing review and process panels.

Child-agent creation records in the conversation and entries in the resource list open a right-side child conversation. It reads real history through the same message and tool components. Avatars are generated locally from the authoritative Core Thread ID without an external image service. Child tabs support switching and closing; closing a reading view does not stop the task, and reopening restores from Core. The main conversation and input draft keep their existing owner. Ordinary child conversations and isolated Workgroup writers retain their respective existing entry points.

## Lifecycle

The renderer accesses the desktop adapter through narrow preload IPC. The independent adapter connects through `areal service ensure/restart/stop --json`, without managing Core PIDs. GUI exit disconnects the interface and settles GUI-owned terminals; Core Turn/Goal and configured scheduled tasks continue. Reopening restores authoritative snapshots without replaying submissions. Stopping the background service is explicit; safe stop rejects busy instances.

When a Core observation connection closes unexpectedly, its project owner retries with backoff from 500ms to 30s, discovers a compatible running instance through `service status --instance`, and restores Thread/Task snapshots, subscriptions and notification baselines. `thread/resume` also restores tool-host binding. Recovery does not submit tasks again, synchronize Provider/MCP configuration or execute configuration revision barriers. Retired connections lose permission to update projections through messages or asynchronous results. Explicit stop, adapter shutdown, a stopping Core or an incompatible deployment fingerprint blocks automatic recovery; reconnection requires an explicit action.

`@areal/workbench/desktop-contract` shares desktop command names, scopes, boundary input shapes and error fields. Thread configuration has concrete parameter types; other commands still rely on runtime scope validation. Main retains IPC sender validation. Core owns nested configuration and execution rules. String or numeric `code`, `submissionUnknown` and `requestId` pass through the adapter and Main so the UI can reconcile unknown outcomes.

Main owns native previews by project/Thread and caches at most 8 pages, evicting the least recently accessed non-current page first. Hiding a panel retains its page; archiving a thread, hiding a project and exiting the window release the corresponding WebContents. Late show requests cannot recreate invalid owners. Eviction rebuilds from the URL retained by the UI; crash recovery rebuilds from the page URL. Navigation history, page memory and pre-eviction Session state are not guaranteed to survive. The limit bounds native pages, not total Electron memory or Session object counts. Previews retain independent temporary Sessions without preload, Node or the product bridge.

The adapter retains credential encryption, subscription forwarding, and mobile pairing, without another Agent loop. The subscription transport's local capability and fixed loopback port persist in a mode-0600 file under a private directory; upstream account/API credentials use OS secure storage. Adapter exit interrupts active forwarded HTTP responses. Stable transport identity supports subsequent requests, not uninterrupted streams through crashes. Normal GUI exit retains the adapter.

The registry defaults to `~/.areal/gui/<GUI data directory digest>` to keep macOS Unix socket paths short. The GUI isolates registration through `AREAL_HARNESS_SERVICE_HOME`, preserving Core's default configuration location. CLI clients must explicitly use the GUI's `AREAL_HARNESS_SERVICE_HOME` and instance descriptor to reach the same instance; shared configuration does not imply shared runtime data. Authentication descriptors never enter the renderer. See [shared local services](../../docs/api/local-service.en.md).

## Candidate builds and package acceptance

```sh
make release
AREAL_CORE_PROFILE=release AREAL_GUI_PACKAGE_DIR=/absolute/new-package make gui-package
pnpm --dir clients/gui run sign:mac --app "/absolute/new-package/package/mac-arm64/AReaL Harness GUI.app" \
  --output /absolute/new-signed-directory --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile areal-harness
```

`gui-package` only stages a macOS arm64 candidate, defaulting to the already-built debug Core; installation packages use release Core as shown above. Candidate outputs include an `.app`, ad-hoc ZIP, dependency inventory and Core integrity manifest, and do not establish package acceptance. `sign:mac` uses an independent copy for Developer ID signing, app/DMG Apple notarization, stapling, Gatekeeper, and general desktop plus model-selection acceptance. Deliver its final ZIP/DMG after those checks pass. Use fresh output directories and bind the bundled Core revision to the final fix commit. Candidates have no automatic-update configuration; signing and notarization do not publish. See the [release guide](../../docs/development/releasing.en.md#gui-releases) for production publication and the update channel.

`make gui-smoke` runs real Electron/Core/Runtime against a deterministic local HTTP model with native sandboxing enabled. The project picker is injected with an isolated temporary workspace. Screenshots and `manifest.json` remain in the printed temporary directory. Set `AREAL_GUI_EXECUTABLE` to the absolute installed app executable for package testing; that mode uses bundled Core instead of an external binary. Real account login, paid models, other operating systems, and signed distribution require separate acceptance.

Finish Core builds before starting desktop smoke tests that use that binary, and do not relink it during acceptance. Model-selection smoke waits for saving and the Core model-selection state before the next action; GUI CI runs it and uploads logs, screenshots and manifests. On Core model-configuration child-process failure, the background service log preserves the operation, exit code, signal and timeout classification without recording secrets or the full environment.

`pnpm --dir clients/gui run test:connection` covers real Core disconnect recovery, concurrent operations, retired connection messages and explicit shutdown. `pnpm --dir clients/gui run test:architecture` uses real Electron IPC to cover contract rejection, error-code forwarding and native preview eviction, crash reconstruction and owner release. Both isolate data and produce evidence; they do not replace package acceptance.

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md). Runtime icons retain the source repository's versions; capture archives, development Skills/AGENTS, and source Git history are excluded.
