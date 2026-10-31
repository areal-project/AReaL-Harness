[中文](releasing.md) | **English**

# Publishing release bundles

Validated standalone channels are complete macOS arm64 and Linux x86_64 glibc bundles with the Python installer; both platforms share a Homebrew formula. Unlike the [official Codex CLI installation matrix](https://learn.chatgpt.com/docs/codex/cli#getting-started), this project has no complete npm or native Windows distribution yet. `cargo install areal-cli` also lacks the Runtime and bundled tools. See [installation](../guides/installation.en.md) for platform scope.

Package staging loads the Cloud backend modules in a separate process and exercises the local read-state route to verify that public package entrypoints resolve inside the distribution. This check runs before signing and notarization.

## Channels and source gate

Formal and preview CLI releases both ship complete bundles. macOS retains and strictly verifies input ad-hoc signatures without Developer ID distribution signing or Apple notarization. Formal GUI releases retain Developer ID signing, notarization, DMG installation and ZIP updates. GUI previews retain default ad-hoc signing, are installed manually, contain no formal update configuration, and do not advance the formal feed or promise automatic migration to formal releases. Previews are prereleases and never Latest; only a formal CLI release may become Latest.

Before formal export, run `git fetch origin main`, then `python3 scripts/release-source.py --revision "$(git rev-parse HEAD)"`. This requires a clean checkout's full HEAD SHA to belong to fetched main; an old offline ref cannot replace fetching before release. CLI tag builds and formal GUI asset export enforce this gate, while PR candidates may validate unmerged source. GUI export must match the candidate Core source commit and records the verified main commit. Retain version, commit, platform and checksums with every artifact. Published version assets must never be replaced. Candidates and previews do not automatically change the formal channel.

## Candidate builds

Build, validate and publish CLI/GUI packages locally from a clean selected commit. PRs run release contract tests through the stable `Release gate`; they do not build bundles, run package installation/upgrade qualification, upload release candidates or publish. Tag pushes do not start packaging. The existing `Release bundles` manual workflow remains available only through explicit `workflow_dispatch`; ordinary releases use the local commands below. Use the pinned Rust toolchain and Cargo.lock, building natively on macOS 15 arm64 and Ubuntu 22.04 x86_64.

Local release qualification runs `make release`, creates complete bundles with file manifests, tar.gz archives and checksums, then extracts them into relocated paths containing spaces. A local HTTP model fixture verifies real command writes and file reads. Linux additionally installs through the installer and verifies its entry point and native tools. Both platforms verify stable and beta installation and upgrade in isolated Homebrew prefixes, with `brew test` and real read/write checks. macOS also runs the release-profile bundle lifecycle soak.

macOS packaging preserves the build artifacts' signatures and original bytes and runs `codesign --verify --strict`. Missing or invalid signatures stop packaging and must be fixed in the build artifacts. Packaging does not force a new signature onto binaries; manifest checksums describe the files actually copied.

`release-artifacts.py` rejects dirty-tree or non-release-profile manifests. Candidate outputs include platform archives, manifests and SHA256 sidecars. The draft assembly generates a dual-platform formula using final download URLs and actual archive checksums. Never use placeholder SHA256 values or describe unapproved candidates as released versions.

Complete macOS bundles also contain a separate Bash executable under `libexec/areal/shells`; its version and source hashes are pinned in `runtime/host-tools/bash.lock.json`. `scripts/prepare-runtime-shell.py` builds it. Packaging verifies the lock, builder, binary and source archive hashes and rejects missing or inconsistent assets. The same distribution includes `COPYING`, full `corresponding-source.tar.gz` (original archive, every patch, lock and builder) and `build.json`, recorded in manifest `thirdPartyComponents`. Never distribute only its binary or replace this standalone GPL-3.0-or-later component’s license with the project Apache license. The source archive supports offline rebuilding. Linux gains no such component.

The lock file pins private shell `minimumMacOSVersion` to 15.0, passed explicitly as `MACOSX_DEPLOYMENT_TARGET`; packaging checks the build metadata against that lock. Native qualification also checks Mach-O `LC_BUILD_VERSION` with `otool -l` so a newer local SDK cannot silently raise this component above the supported product minimum.

## Publication steps

1. Merge preparation changes. Confirm PR checks and local release qualification pass for the selected commit; inspect version, licenses and migration notes.
2. Review both platform candidates, Homebrew checks and Linux installation logs; confirm scope and version.
3. Create an unused `v<version>` tag on the selected commit (`vX.Y.Z-beta.N` for previews). It must match `areal --version`; never replace an existing tag. Build and validate both packages locally before creating a **draft** Release and uploading the validated assets from the local machine. Creating a tag does not trigger packaging or publication.
4. Verify local assets and the uploaded draft copies against SHA256SUMS and manifest sourceRevision, profile and platform. Complete concise Chinese and English release notes covering this release’s user-visible changes, important fixes and necessary upgrade notes. macOS has no Developer ID signing/notarization and must not be labeled notarized.
5. Publish the draft under existing authorization, then synchronize its channel through the public tap procedure below: stable updates only `Formula/areal.rb`, and beta updates only `Formula/areal-beta.rb`. Confirm public access to the repository, corresponding formula and archives before providing installation commands; failed synchronization does not establish Homebrew availability.
6. In isolated macOS arm64 and Linux x86_64 environments, verify public Homebrew first installation, older-version upgrade, actual-source routing, channel isolation and complete Runtime behavior; retain standalone installer regressions. Record artifact digests and results. Repeat for future versions without replacing published archives.

Tagging, publishing and tap creation/updates are external publication operations performed after artifact review. The draft job does not overwrite existing Releases; inspect remote state before retrying failures. This workflow does not publish Linux container images.

## Local commands

The bundle manifest takes `apiVersion` from generated `schemas/areal-core-v1.json` and `stateVersion` from the Core Store version constant. Missing or ambiguous metadata refuses packaging before copying or signing. When reusing built binaries, verify their actual protocol/state versions against that source; the manifest does not replace binary acceptance.

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

The formula installs `bin`, `libexec`, LICENSE and the manifest, preserving Core's relative helper discovery. Linux installs versions into separate directories and atomically switches only the entry symlink. Configuration and history remain outside installer ownership. Validation failure must not switch the entry point.

## Optional platform adapter package

External platforms consume standard native release bundles through the [CLI contract](../api/claude-cli.en.md). The legacy EnvArena Python zipapp and dedicated packaging workflow are no longer distributed.

Do not require the optional adapter job in regular pull-request branch protection. Remove any existing required `Arena package` check in repository settings separately; workflow files do not change that setting.

## GUI releases

For local validation without new signatures, use `AREAL_GUI_UNSIGNED_LOCAL=1 AREAL_GUI_PACKAGE_DIR=/absolute/new-directory pnpm --dir clients/gui package`, or `python3 scripts/package.py --unsigned-local --profile debug --output /absolute/new-directory` for a CLI bundle. This explicit mode skips signing Core copies and the app while builder retains `identity: null`. It preserves input bytes and existing signatures, records actual bundle signature verification, and neither removes signatures nor changes system policy. It is incompatible with `AREAL_GUI_RELEASE=1`; the default flow still creates local ad-hoc signatures. A generated ZIP does not prove launchability: extract into a new isolated directory and validate, preserving the first system rejection and stopping that launch path if denied.

Default local ad-hoc packaging produces an `.app`, `AReaL-Harness-GUI-mac-arm64.zip`, and a matching `.dmg`. For DMG only, use `AREAL_GUI_RELEASE=0 AREAL_GUI_UNSIGNED_LOCAL=0 pnpm --dir clients/gui package --dmg-only`; it retains the signed `.app` intermediate and skips ZIP creation. This option cannot be combined with production or unsigned-local mode. `package-evidence.json` records the DMG path, compressed size, SHA-256, and verified framework hardlink counts. `AREAL_GUI_UNSIGNED_LOCAL=1` and the `AREAL_GUI_RELEASE=1` staging step still export only ZIP.

To export a preview DMG from an already signed app, use a destination that does not exist:

```sh
node clients/gui/scripts/macos-dmg.mjs --app "/absolute/AReaL Harness GUI.app" \
  --output /absolute/new-preview.dmg --volume-name "AReaL Harness Preview"
```

Preview and production DMGs use the same exporter. It preserves the source app and proves equivalent payloads, layout, and signing policies for both Electron frameworks in a private copy before hardlinking corresponding regular files. For differently signed code, it removes signatures only from disposable file copies and compares all remaining bytes. Unsupported differences fail the export. The main app and background service retain independent helpers, metadata, and local framework directories. The exporter does not sign code. After the final app signature, it creates an HFS+ UDZO DMG and publishes only after a read-only mount passes signature, layout, and shared-inode checks. The production flow then signs, notarizes, and staples the DMG. The ZIP format and update path are unchanged, with no promised ZIP size reduction. An ad-hoc preview does not establish Apple distribution trust.

GUI versions are declared by `clients/gui/package.json` and `clients/gui/app/package.json`, independently of Cargo/CLI. Publish to `areal-project/AReaL-Harness` using `gui-v<version>` tags; CLI tags remain `v<version>`. GUI releases are not GitHub Latest, preserving the CLI installer's Latest semantics.

Production GUI packages contain `areal-update.json` with the fixed feed `https://github.com/areal-project/AReaL-Harness/releases/download/gui-update-channel/`. The `gui-update-channel` prerelease carries only the current `latest-mac.yml`; that manifest points to the immutable ZIP in `gui-v<version>` and includes size and SHA-512. Only same-repository, same-version assets are accepted. Local ad-hoc packages have no update configuration.

The macOS `dir` target does not automatically generate native update configuration. Production packaging writes `app-update.yml` before signing, using the same product feed and a fixed download cache name, and verifies the packaged configuration. Automatic builder uploads remain disabled. Discovering an update does not prove download works. The sidebar update button shows download progress, displays failures directly, and allows retries. On update reopen, reconcile the original receipt and confirm the previous backend has exited before resuming initialization. Unknown or unfinished operations retain their recovery references. An explicit backend stop still requires manual reconnection.

Installation checks idle state, safely stops the backend, and checks package users before native Squirrel preparation. Only crash reporters matched to the current session by UID, real executable path, stable process identity, and the corresponding database are excluded. Other profiles, independent CLI processes, and unknown package users still block installation. Download or digest failures preserve the backend. Native preparation failures occur after safe shutdown and require reopening to check the installed version rather than automatic installation retries.

Run from a clean, merged commit:

```sh
make release
AREAL_GUI_RELEASE=1 AREAL_GUI_PACKAGE_DIR=/absolute/new-package make gui-package
pnpm --dir clients/gui run sign:mac --app "/absolute/new-package/package/mac-arm64/AReaL Harness GUI.app" \
  --output /absolute/new-signed-directory --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile areal-harness
node clients/gui/scripts/release-assets.mjs /absolute/new-signed-directory /absolute/new-assets
```

The signing script signs Core executables and updates integrity hashes before signing Electron. Shared resources linked from the background service are identified by physical file identity so outer signing does not re-sign Core. Core hashes are checked again after outer signing and before any Apple upload. Completion requires Apple Accepted receipts, stapler, Gatekeeper, an isolated signed-package GUI/Core/Runtime smoke, model-configuration and Composer acceptance, and signature validation inside a read-only DMG mount. `notarization.json` and sanitized `release.json` record `packagedModelSelection: "passed"`; export rejects older candidates without this acceptance, requiring a new candidate built with the current signing script. Exit 2 means Apple is still processing; resume with the same script and `--resume --output`. Never modify a signed app.

Before signing, `history-copy-smoke.mjs` reads installed GUI history from `~/Library/Application Support/AReaL Harness GUI/areal-core` by default; `--history-source /absolute/areal-core` selects another source. It copies the project index, sessions, history archives, and attachments into a private isolated directory and fills fixture workspace placeholders only in copies. Private history copies retain their original bytes and workspace paths for Core ownership validation; they are observed without executing tasks. Credentials, locks, and deployment configuration are excluded; original history is never written. Only idle histories without queued work or unsettled execution state are accepted; other inputs block signing. Completed child-conversation execution references are accepted only when their terminal target turn exists in the same project copy; unresolved references, workgroups, and managed process/workflow state still block signing. The candidate must connect to Core and open every session, with byte-identical copies during observation, unchanged source files throughout, and no model requests. Queue revision changes caused by stopping copied services are handled separately. Failure precedes signing-identity checks and Apple requests. Successful evidence is bound to the candidate Core hash and recorded in `notarization.json.historyPreflight`. Older signing runs without this record cannot bypass acceptance through `--resume`; start a new run.

A registered project whose Core has not started may have no state directory, and a connected project can have no sessions. Preflight retains these projects, connects their copies, and confirms that observation creates no sessions. Source state-directory presence and entries must remain unchanged throughout the check. Existing state paths must still be regular directories rather than symlinks, and existing sessions retain every idle-state and ownership requirement.

GUI CI runs `pnpm --dir clients/gui run test:history-compat` against the hand-authored sanitized samples in `clients/gui/scripts/fixtures/history-compat/`, including empty projects, `hookRuns`, `allowPluginSkills`, and `pluginSkills`. These files contain no user history, real paths, or credentials. Locally run `node clients/gui/scripts/history-copy-smoke.mjs --source /absolute/areal-core --executable "/absolute/candidate.app/Contents/MacOS/AReaL Harness GUI"`; omitting `--executable` uses development Electron and the built Core. A builder without installed history can explicitly point `--history-source` at the controlled fixture directory; this proves fixture compatibility only. Private copies and failure evidence remain in the reported `/private/tmp/ahc-*` directory and must not be published as release assets.

Create `gui-v<version>` at the fixed commit, upload ZIP, DMG, `latest-mac.yml`, sanitized `release.json`, and `SHA256SUMS` to a draft, verify downloaded hashes, then publish with `--latest=false`. Verify version assets are downloadable before updating the `gui-update-channel` manifest; create that channel as a prerelease initially. Check full bytes, HTTP Range, manifest size, and SHA-512 after publication. Never overwrite version assets; advance the channel only to verified versions. This workflow does not publish CLI bundles or update the Homebrew tap.

GUI updates support macOS arm64. Electron owns checks and downloads; Core shuts down for installation only after background work becomes idle and native validation finishes. Public download and package smoke checks do not prove replacement of an existing installation; that upgrade requires separate acceptance. Clients configured for other repositories or older test channels need manual installation of the first production GUI package.

`pnpm --dir clients/gui run test:update` uses real Electron preload/IPC to verify visible download errors and retry progress. Set `AREAL_GUI_EXECUTABLE` to a candidate package executable and `AREAL_GUI_UPDATE_BASELINE` to an older signed GUI executable to additionally verify the candidate's native configuration, public ZIP download and SHA-512 verification, Squirrel native staging, and safe Core shutdown. The script launches only an isolated baseline copy, borrowing candidate configuration without changing signed resources. It intercepts the final installation call, exits, and checks the version of the copy automatically replaced by Squirrel, leaving the original baseline and user installation untouched. The script prints its evidence directory.

## Build identity and GUI compatibility

`areal build-info` exposes the Core revision, dirty state, Rust/Cargo/schema input hash, and compiled API/Store versions. Packaging verifies the input hash and revision first, so an old binary cannot acquire a new checkout identity. Manifest format 2 stores coreBuild and actual component byte hashes; sourceRevision refers to Core, without independently asserting the compile source of each Runtime binary. GUI accepts legacy format 1; format 2 also requires matching API, Store version and revision between coreBuild and manifest. GUI requires areal.core.v1, a matching platform and a supported persistent version; Core still reads the Store. Rebuild after source input changes before packaging. `make desktop-schema-check` temporarily generates and compares all three normalized schemas; `make desktop-schemas` replaces them atomically after all generators succeed.

`python3 scripts/install-smoke.py --bundle /absolute/complete-bundle --evidence /absolute/install.json` validates the direct installer with a real isolated shared service: entry updates keep the real service PID, generation and old complete bundle unchanged. Run this check during local release qualification. Ordinary script regressions use synthetic executable bundles to check failure invariants without starting user services.

## Public tap and channel synchronization

`release-artifacts.py formula` accepts two `--archive` arguments for the same version and emits conditional macOS arm64/Linux x86_64 definitions using each archive's SHA256. Stable emits `areal.rb`; beta emits keg-only `areal-beta.rb`, leaving the stable entry intact. Linux requires host glibc ≥ 2.35 and system `/usr/bin/bwrap`; macOS restrictions belong only in its platform branch.

Publishing a CLI Release does not automatically synchronize the tap. Use the local command below; the retained `Sync public Homebrew tap` workflow requires explicit workflow_dispatch for an exact public tag. It retains `contents: read` and requires a previously approved `HOMEBREW_TAP_TOKEN` for cross-repository access. Missing authorization fails explicitly without creating credentials or treating release publication as successful tap synchronization. Missing organization repositories, write access or valid checksums block synchronization without replacing or withdrawing published assets. An authorized maintainer can resolve the repository/access blocker and retry the same tag without broadening token or workflow permissions.

A maintainer with existing tap write access can also synchronize manually. The script accepts only public releases with matching channel state, downloads and verifies both platform archives, and refuses formula downgrades:

```sh
git clone https://github.com/areal-project/homebrew-tap.git /absolute/new-tap
python3 scripts/sync-homebrew.py --tag vX.Y.Z --tap-checkout /absolute/new-tap --push
# For beta, select the real public vX.Y.Z-beta.N; only Formula/areal-beta.rb changes.
```

The script creates neither repositories nor credentials. Public-channel acceptance must check unauthenticated tap/formula access, both public archives and SHA256, followed by first installation, older-version upgrade, actual-source routing and stable/beta isolation in isolated native Homebrew prefixes on both platforms. `homebrew-smoke.py` runs native candidate acceptance on macOS/Linux runners; its isolated `areal-validation/channel` tap does not establish public-tap availability. Installer integrity, native Linux tools, actual running tasks and old-bundle retention remain covered. Homebrew may clean up old kegs, so finish tasks and safely stop services first; upgrades never stop backends implicitly.

Linux bundles still build natively on Ubuntu 22.04 / glibc 2.35 with installer and tool regressions. Linuxbrew downloads and validates that same archive on Ubuntu 24.04. Homebrew itself targets a newer glibc; older hosts combined with long custom prefixes can trigger extra toolchain bootstrapping. This does not change the product glibc baseline or justify skipping dependency checks. Both checks remain required local release evidence before draft publication.
