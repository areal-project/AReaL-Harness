[中文](ios-development.md) | **English**

# Develop and verify the iOS app

The mobile shell uses Capacitor 8.5.3 and Swift Package Manager. `clients/mobile/ios/` is the tracked Xcode project, with an iOS 17.4 deployment target. iOS 17.5 passes the real WKWebView gate. iOS 17.4 still requires verification on that runtime. The mobile entry provides QR scanning or pasted Relay pairing links, a desktop confirmation waiting page, connection status, and device clearing. A local Swift plugin persists the device identity in iOS Keychain. Project cards, 30-row conversation pages, and the shared Messages read-only session view use the Remote API. Creation, sending, queueing during a turn, stopping, and model configuration use the shared command recovery state. Approvals, questions, and App push remain later slices. The real iOS 17.0 WKWebView gate fails during Noise because a production dependency calls the unavailable `Promise.withResolvers`. The minimum version is iOS 17.4, which provides this standard API.

## Prepare the environment

Install Xcode 26 or later, an iOS Simulator runtime, and the Node and pnpm versions required by `clients/gui/package.json`. See the [official environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup). Testing a newer runtime does not qualify the minimum OS version.

GUI builds follow the GUI Node engines, while the Relay CLI requires Node 24.2.0. When these differ, set `AREAL_RELAY_NODE` to the Relay Node executable. The main runner and pnpm keep using the supported GUI Node. This test variable does not bypass the Relay version check; evidence records both versions.

Run installation from the repository root. The mobile package belongs to the GUI workspace and shares `clients/gui/pnpm-lock.yaml`.

```sh
pnpm --dir clients/gui install --frozen-lockfile
pnpm --dir clients/gui mobile:sync
pnpm --dir clients/gui --filter @areal/mobile open
```

`mobile:sync` builds `clients/gui/renderer/mobile/index.html`, then runs `cap sync ios`. The generated SPM library declares iOS 17. The App deployment minimum is iOS 17.4. The library minimum does not expand the OS versions on which the App can install. The build writes only to `clients/gui/dist/mobile/`, which is Capacitor's `webDir`. Desktop and Web Remote builds have separate entries. After changing Web sources, rerun sync, then launch through Xcode or `pnpm --dir clients/gui --filter @areal/mobile exec cap run ios`. This sequence follows the [official development workflow](https://capacitorjs.com/docs/basics/workflow).

The default Bundle ID is the development placeholder `com.example.arealharness`. The gate accepts `AREAL_MOBILE_BUNDLE_ID` and passes it to Xcode as `AREAL_MOBILE_BUNDLE_ID`. Before device signing, choose a Bundle ID you own in both the Xcode project and Capacitor configuration, then configure your development team.

## Daily development loop

Use a Node version supported by the GUI engines; Relay fixtures still require a separate Node 24.2.0 executable. Mobile commands build the shared UI package first, including in a fresh worktree.

```sh
pnpm --dir clients/gui mobile:dev
# In a second terminal, target your own simulator rather than a physical device.
pnpm --dir clients/gui mobile:ios:live --target <simulator-udid>
```

The development server binds to `127.0.0.1:5174` and fails if the port is occupied, preventing accidental attachment to another worktree. Open its URL in a browser to edit mobile pages. CSS updates in place; script changes reload the page to recreate connection and subscription owners. Leaving the page closes the connection and stops reconnect attempts. Native mode continues to use Keychain. The browser development substitute holds identity only in page memory, loses it on reload, and uses pasted links instead of scanning. It does not establish native storage, permission, or background behavior acceptance.

`mobile:ios:live` verifies that the server belongs to this worktree, syncs local assets, temporarily sets the generated configuration's development URL, then uses MobileBuildMCP to build and launch a dedicated Debug app. It restores the generated configuration on completion or failure; the development server keeps serving updates. This avoids native-run's dependency on the old Simulator.app path. Run `mobile:sync` before protocol gates, archive, or release validation to use bundled local assets. Live Reload targets local simulator page development. Relay connections must still satisfy HTTPS origin allowlists, certificate trust, and WSS contracts. The browser gate exercises this through an ephemeral HTTPS fixture; an ordinary HTTP development URL is not thereby authorized by a production Relay.

The following commands exercise the production mobile React UI in Chromium and WebKit: unpaired state, invalid links, actual Noise pairing with fixture approval, successful connection, reload after a script update, and light/dark screenshots. Storage uses the browser memory substitute and the Host uses the existing fixture. The gate also checks that release assets exclude the browser substitute and development CSP. It does not start Rust Core or replace native gates.

```sh
npm --prefix services/remote-relay ci --ignore-scripts
pnpm --dir clients/gui/app exec playwright-core install chromium webkit
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node pnpm --dir clients/gui test:mobile-browser
```

Each attempt writes `.scratch/ios-development/browser/<attempt>/` with source SHA, dirty paths, runtime versions, screenshots and hashes, timings, outcomes, and cleanup errors. Browser contexts ignore certificate errors only inside the isolated TLS fixture; production connection code and Relay origin checks retain their existing contracts.

This workflow draws on t3code's mobile lifecycle, reproducible scenes, and device evidence organization: script updates must handle connection ownership, native changes require rebuilding, and screenshots need device and scene attribution. Its Expo/React Native, Effect runtime, and device pool are not dependencies here. Vite page reloads and existing Remote gates serve those responsibilities.

For relevant GUI, mobile, and Relay changes, the `Linux mobile browser contracts` job in `GUI checks` runs mobile type checks, both browser paths, and production asset checks. It executes the shared `mobile` group, uploads reports and evidence, and contributes required results to `GUI gate`. Native builds and OS-version gates use the local entry points above; this CI does not establish native iOS or physical-device acceptance. The browser gate uses an independent Vite cache and removes it afterward to avoid sharing optimized dependencies with a daily development server.

## Agent simulator tools

`mobile:tools` pins MobileBuildMCP 2.7.1 and reads `.mobilebuildmcp/config.yaml` from the repository root. The configuration enables simulator, UI automation, and debugging tools and supplies the project and scheme. Callers select their simulator ID to avoid another task's device.

```sh
pnpm --dir clients/gui mobile:sync
pnpm --dir clients/gui mobile:tools simulator list --output json
pnpm --dir clients/gui mobile:tools simulator build-and-run --simulator-id <simulator-udid>
pnpm --dir clients/gui mobile:tools simulator snapshot-ui --simulator-id <simulator-udid>
pnpm --dir clients/gui mobile:tools ui-automation type-text --help
pnpm --dir clients/gui mobile:tools daemon stop
```

CLI and MCP share tool implementations, so agents can use the CLI without changing global assistant configuration. For MCP, start `pnpm dlx mobilebuildmcp@2.7.1 mcp` from the repository root. Consult the pinned version's `--help` for arguments. Record build success, screenshot capture, and WebView control interaction separately. Existing `xcodebuild`/`simctl` gates continue to verify deterministic protocol and recovery behavior.

## Run the WKWebView handshake gate

Check installed runtimes with `xcrun simctl list runtimes`. The default is iOS 17.5. Select another installed version as needed.

```sh
pnpm --dir clients/gui test:mobile-handshake
AREAL_IOS_RUNTIME=17.4 pnpm --dir clients/gui test:mobile-handshake
```

The script creates an isolated iPhone simulator, trusts an ephemeral fixture CA, and builds and installs a Debug App. The real `capacitor://localhost` WKWebView imports production `channel.mjs` and `wire.mjs`. It exercises strict WSS, Relay, the Noise Host pin, the existing `hello`, fixture Observer approval, inner `ready`, and `project.list`. It also checks rejection of a wrong Host pin, a wrong certificate hostname, and an untrusted CA. Cleanup stops fixtures and removes only the simulator created by this run.

Evidence defaults to `.scratch/ios-remote-v1/mobile-gate/`. Each OS version has JSON results, a build log, and screenshots. Set `AREAL_MOBILE_EVIDENCE` to choose another evidence directory. Set `AREAL_MOBILE_CASES=handshake` to run only the positive path. Missing randomness, `crypto.subtle`, `AbortSignal.timeout`, or `Promise.withResolvers` fails the compatibility gate. The handshake still attempts the existing implementation to distinguish protocol failure from missing runtime capabilities. The script injects no replacement crypto or compatibility polyfill.

The Debug native bridge injects ephemeral pairing parameters only when the launch environment contains `AREAL_MOBILE_PROBE`. Pairing parameters and device private keys stay in process memory. The bridge writes public Peer IDs and sanitized results to the App container, which the runner reads to approve the fixture device. Release builds exclude this bridge. Fixture approval does not qualify desktop human pairing.

This gate qualifies only the tested OS, shell, and current protocol path. It does not qualify real providers, Rust Core execution, device key storage, background recovery, physical installation, or TestFlight.

## Verify pairing and device storage

The app uses official `@capacitor/app` 8.1.2 for lifecycle events and official `@capacitor/barcode-scanner` 3.1.3 for QR scanning. The native `Info.plist` contains the camera permission explanation. Scanning requires an actual iPhone test; simulator paste tests cannot replace it.

The local `ArealKeychain` plugin stores one computer's device identity, Host pin, Relay origin, room, grant revision, and unresolved command locators. The single Keychain item uses `AfterFirstUnlockThisDeviceOnly` with synchronization disabled. Updates use atomic `SecItemUpdate`; first writes use `SecItemAdd`. A failed save reports that the current connection works but pairing is required next time. Invitation secrets and input drafts stay in memory. Capacitor `loggingBehavior` is set to `none` so native plugin responses cannot place identity records in debug logs.

Backgrounding closes the connection and releases subscriptions. Foregrounding reloads Keychain and reconnects with the same Host pin. Clearing the device disconnects before deleting the Keychain item; the user must also revoke the previous grant on the computer. Revocation and incompatible protocols stop automatic reconnects.

```sh
node --test clients/gui/scripts/mobile-device-store.test.mjs
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node node clients/gui/scripts/mobile-pairing-smoke.mjs
```

The pairing runner uses an isolated simulator, a local Relay with strict TLS, and production RemoteControl. Its DEBUG driver operates actual DOM inputs and buttons through real protocol authorization and native Keychain. It checks pairing, restore after process termination, backgrounding through Settings and returning to the app, desktop revocation, explicit clearing, the unpaired state after another restart, and the dark appearance. Observations contain only state, Keychain presence, grant revision, and the public device fingerprint. Evidence is saved in `.scratch/ios-remote-v1/mobile-pairing/`; `AREAL_MOBILE_EVIDENCE` overrides the location. The native driver entry exists only in DEBUG builds.

These gates are development checks. Physical QR scanning, iOS 17.4, real desktop confirmation, recovery from denied camera permission, VoiceOver, and TestFlight each require separate acceptance. Compare each UI state with the five-screen reference. The connection header uses the localized “Computer” because the Host contract does not return a computer display name. Screenshots do not replace VoiceOver, physical-keyboard, or minimum-OS checks.

## Verify projects and read-only conversations

`MobileWorkspace` owns project navigation, conversation lists, and one foreground session. Online project summaries read the first `work.list` page. Conversation lists use 30-row pages with refresh and earlier-page controls. Polling refreshes the first page while retaining expanded rows. Task rows use `task.read` for execution details.

Sessions reuse `Messages`, the atomic `session.open` baseline, and `acceptSessionMessage` for live updates. A new observation clears stale pagination state. Messages leaving the live window enter bounded history pages; three history pages retain content, with reloadable placeholders for evicted ranges. History cursors describe Core-accessible history, not complete archived history. `SessionBodyReader` supplies the shared body reader and identity checks. Leaving the session releases its subscription.

```sh
node --test clients/gui/scripts/mobile-workspace.test.mjs
AREAL_CORE_BIN=/path/to/locked-slot/areal \
AREAL_RUNTIME_BIN=/path/to/locked-slot/areal-runtime \
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node \
node clients/gui/scripts/mobile-workspace-smoke.mjs
```

Run the real Core gate inside `slot_lock` from `scripts/verification.py`, holding the lock for the runner's entire lifetime. First deploy matching artifacts, including private shells, as described in the [testing guide](testing.en.md). The runner uses strict TLS Relay, real Core/Runtime, a deterministic local model, and native WKWebView. It creates two projects and history beyond the initial display budget, then checks the baseline, older history, a new desktop message, preservation of the old boundary, and subscription release on navigation. The DEBUG driver only clicks production DOM and scrolls the message view. Automatic older-history loading uses a synthetic `PointerEvent(pointerType: touch)` and actual scrolling; physical touch gestures still require device checks. Evidence in `.scratch/ios-remote-v1/mobile-workspace/` includes source revision, dirty paths, Core/Runtime hashes, and cleanup results. It does not qualify real providers.

## Validate conversation commands

New conversations read the desktop catalog through `project.models` and initially display “Computer default”. Unspecified permissions display “Computer permissions” and inherit the computer configuration. Model, reasoning, and permission selections remain an in-memory intent. The first send creates the session, reads its `session.open` baseline, applies the selection against its actual configuration revision, and sends the message. Unavailable or rejected configuration preserves the draft and the created session. Sending during a turn uses `enqueue` and the exact Turn ID; stopping targets the current Turn. Task sessions require their dedicated controls.

The mobile UI reuses `ConversationComposer`, `ComposerQueue`, and the shared Dialog. The composer toolbar shows permissions on the left and the model and reasoning effort on the right. Each opens its own bottom sheet. Done applies the selection; dismissing the sheet discards unconfirmed edits. The model sheet offers quick effort selection from the catalog and advanced rows for choosing the model and reasoning level. The permission sheet shares the GUI’s Ask for approval, Review for me, and Full access semantics, icons, and descriptions. Existing read-only, custom, and other states reflect the actual configuration and remain constrained by desktop capabilities and locked read-only profiles. Settings remain view-only while a turn runs. Drafts stay in memory. Before a write, the same device identity must be saved successfully to Keychain, followed by the shared `ClientState` locator. Locators contain no message body or model selection. Lost replies, disconnection, and restart recover only through `command.read` for the original commandId. Recovering an accepted creation does not automatically send. An unknown stop retains its exact record while allowing a new message once Core confirms the session is idle.

```sh
node --test clients/gui/scripts/mobile-commands.test.mjs
AREAL_CORE_BIN=/path/to/locked-slot/areal \
AREAL_RUNTIME_BIN=/path/to/locked-slot/areal-runtime \
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node \
node clients/gui/scripts/mobile-command-smoke.mjs
```

Hold `slot_lock` for the entire command gate. The runner uses real Core, two deterministic local models, DOM input, and native Keychain to check first send with a non-default model, queueing during a turn, stopping, loss of an admitted reply, and reconciliation after restart. Each attempt has a separate evidence directory under `.scratch/ios-remote-v1/mobile-commands/`, including measured CSS hit targets for visible buttons. `AREAL_MOBILE_DERIVED` can select a shared DerivedData cache; evidence does not overwrite previous attempts. DOM input checks do not replace physical keyboard or touch acceptance.

Project and conversation lists use content-sized cards without shadows. Project names, conversation names, and navigation titles stay on one line within the available width, with an ellipsis on overflow. Full values remain in the DOM and `title` attribute. Refreshes update accessibility state and existing controls without inserting a loading row that shifts content. Message bodies remain complete.

The touch Composer uses the existing 16px font token to avoid iOS focus zoom. Message copy, statistics, and execution disclosure controls use a 44pt minimum target. This build does not include approvals, synchronous or Task question replies, Task pause, edge-swipe navigation, or push. Task details remain read-only.

## Choose later verification tools

Start with native `xcodebuild`, `simctl`, and structured gate results. Evaluate community [MobileBuildMCP](https://github.com/getsentry/MobileBuildMCP) if agents need a common build, launch, and log interface. This project does not depend on it.

Once product screens exist, use [Appium XCUITest hybrid contexts](https://appium.github.io/appium-xcuitest-driver/latest/guides/hybrid/) to test switching between the native shell and Web DOM. Debug builds enable `WKWebView.isInspectable`. Before adopting Maestro, check its [known WebView accessibility limitations](https://docs.maestro.dev/extra-materials/troubleshooting/known-issues).

## Prepare a Release archive and TestFlight

After syncing Web assets, configure an owned Bundle ID, version, and development team in Xcode. Select a physical iOS destination and choose Product → Archive. The equivalent project entry point is below; the release owner supplies signing settings.

```sh
xcodebuild -project clients/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath .scratch/ios-remote-v1/AReaL.xcarchive archive
```

For manual signing, pass `AREAL_MOBILE_BUNDLE_ID`, `DEVELOPMENT_TEAM`, `CODE_SIGN_STYLE=Manual`, `CODE_SIGN_IDENTITY`, and `AREAL_MOBILE_PROVISIONING_PROFILE` to this command. The provisioning profile setting applies only to the App target. Keep certificates, profiles, and private keys outside Git. The iOS App icon reuses the desktop artwork composited onto an opaque black background; the launch screen uses the system background.

In Archives organizer, select the archive and choose Distribute App → App Store Connect → Upload. Review the signing certificate, provisioning profile, and entitlements before uploading. Follow [Apple's upload instructions](https://help.apple.com/xcode/mac/current/en.lproj/dev442d7f2ca.html) for TestFlight distribution. Uploading requires explicit release authorization and credentials. For an internal-only beta, export using `method=app-store-connect`, `testFlightInternalTestingOnly=true`, and the owned signing profile. Verify processing and assignment to the intended internal group in App Store Connect. The bundled Noise implementation uses standard cryptography outside Apple OS APIs; answer the export-compliance questions accordingly.

For structural checks, add `CODE_SIGNING_ALLOWED=NO` to produce an unsigned archive. It is not an installable or uploadable release package. Release must exclude the DEBUG pairing diagnostics bridge. Local gates have not qualified physical QR scanning, lock-screen push, or TestFlight.
