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

`AREAL_CORE_BIN` selects an absolute trusted Core path; development defaults to `target/debug/areal`. Development data is isolated under `AReaL Harness GUI Dev/<checkout digest>`; installed builds use `AReaL Harness GUI`. Existing desktop installations and data are not imported or replaced. `AREAL_GUI_USER_DATA`, `AREAL_CORE_HOME`, `AREAL_HARNESS_HOME`, and `AREAL_CORE_CONFIG` explicitly select isolated directories/configuration.

Both development and installed macOS builds require a working `/usr/bin/python3` to launch Runtime and trusted tool helpers; install Xcode Command Line Tools with `xcode-select --install`. The interpreter is not bundled. Shared-service startup checks availability and returns an actionable error.

## Composer

New drafts and existing chats share the grouped action/Skills catalog and search through `+` and `/`. Arrow keys select, Enter confirms, and Esc closes it. Skills attach to the current message; Core reads their content before sending, and failures preserve the draft and tags. The model control opens effort first, then the actual model catalog. Effort values come from Core adapter capabilities; remote provider support needs separate verification.

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

The registry defaults to `~/.areal/gui/<GUI data directory digest>` to keep macOS Unix socket paths short. CLI clients must explicitly use the GUI's `AREAL_HARNESS_HOME` and instance descriptor to reach the same instance; default CLI and GUI data locations are separate. Authentication descriptors never enter the renderer. See [shared local services](../../docs/api/local-service.en.md).

## Local installation and acceptance

```sh
make gui-package
make gui-smoke
```

Packaging defaults to the already-built debug Core. Run `make release` and set `AREAL_CORE_PROFILE=release` to package release Core. `clients/gui/dist/local-*/` contains a copy-installable `.app`, ZIP, dependency inventory, and Core integrity manifest. `AREAL_GUI_PACKAGE_DIR` selects a fresh output directory. This local acceptance target is macOS arm64; packaging performs no Developer ID signing, notarization, or publishing. The app and Core executables use local ad-hoc signatures without private signing materials. Local packages do not configure automatic updates. For production GUI releases and the update channel, see the [release guide](../../docs/development/releasing.en.md#gui-releases).

`make gui-smoke` runs real Electron/Core/Runtime against a deterministic local HTTP model with native sandboxing enabled. The project picker is injected with an isolated temporary workspace. Screenshots and `manifest.json` remain in the printed temporary directory. Set `AREAL_GUI_EXECUTABLE` to the absolute installed app executable for package testing; that mode uses bundled Core instead of an external binary. Real account login, paid models, other operating systems, and signed distribution require separate acceptance.

`pnpm --dir clients/gui run test:connection` covers real Core disconnect recovery, concurrent operations, retired connection messages and explicit shutdown. `pnpm --dir clients/gui run test:architecture` uses real Electron IPC to cover contract rejection, error-code forwarding and native preview eviction, crash reconstruction and owner release. Both isolate data and produce evidence; they do not replace package acceptance.

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md). Runtime icons retain the source repository's versions; capture archives, development Skills/AGENTS, and source Git history are excluded.
