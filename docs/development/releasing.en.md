[中文](releasing.md) | **English**

# Publishing release bundles

Validated standalone channels are complete macOS arm64 and Linux x86_64 glibc bundles with the Python installer; macOS may also ship a Homebrew formula. Unlike the [official Codex CLI installation matrix](https://learn.chatgpt.com/docs/codex/cli#getting-started), this project has no complete npm or native Windows distribution yet. `cargo install areal-cli` also lacks the Runtime and bundled tools. See [installation](../guides/installation.en.md) for platform scope.

## Candidate builds

The `Release bundles` workflow builds candidates on relevant pull requests or workflow_dispatch. These triggers upload CI artifacts without creating Git tags or Releases. It uses the pinned Rust toolchain and Cargo.lock, building natively on macOS 15 arm64 and Ubuntu 22.04 x86_64.

The workflow runs `make release`, creates complete bundles with file manifests, tar.gz archives and checksums, then extracts them into relocated paths containing spaces. A local HTTP model fixture verifies real command writes and file reads. Linux additionally installs through the installer and verifies its entry point and native tools. macOS installs the same local archive through a temporary Homebrew tap, runs `brew test` and real read/write checks, then runs the release-profile bundle lifecycle soak.

macOS packaging preserves the build artifacts' signatures and original bytes and runs `codesign --verify --strict`. Missing or invalid signatures stop packaging and must be fixed in the build artifacts. Packaging does not force a new signature onto binaries; manifest checksums describe the files actually copied.

`release-artifacts.py` rejects dirty-tree or non-release-profile manifests. Candidate outputs include platform archives, manifests and SHA256 sidecars. The macOS job also generates `areal.rb` using the final download URL and actual archive checksum. Never use placeholder SHA256 values or describe unapproved candidates as released versions.

## Publication steps

The primary release uses `v<Core version>` and contains both macOS arm64 and Linux x86_64 Core/CLI/Runtime bundles, GUI ZIP/DMG, the installer, Homebrew formula, platform manifests, GUI acceptance metadata, update metadata, the complete release inventory and SHA256SUMS. GUI versions remain independently increasing: `v0.1.5` contains Core 0.1.5 and GUI 0.1.9. Never downgrade the GUI to align version numbers.

1. Merge preparation changes. Require Verify, GUI checks and Release bundles to pass on the fixed commit; check versions, licenses and compatibility notes.
2. Build, sign, notarize and validate GUI from that same clean commit as described below. Create a `gui-v<GUI version>` draft containing every exported GUI asset. This compatibility entry serves existing GUI updaters, is not the primary release, and must not become Latest. Never reuse an older GUI or relabel its source metadata.
3. Create `v0.1.5` on the same commit, matching `areal --version`. The tag workflow rebuilds and validates both Core bundles, downloads assets from the matching GUI draft, and runs `release-artifacts.py assemble`. Missing GUI assets, failed acceptance, mismatched versions/revisions, or incorrect bytes/checksums fail without creating an incomplete primary Release. Rerun the failed job after correcting the candidate.
4. Assembly exports only public assets. It verifies archive contents against file hashes and sidecar manifests, matching platform API/Store versions, GUI source revision and Core version, ZIP/DMG digests and Accepted notarization receipts. It generates `release-manifest.json` and SHA256SUMS covering every asset. Private paths, history and signing logs are excluded.
5. Download the unified draft, verify all digests and revisions, and complete bilingual release notes with component versions, dependencies and signing scope. Standalone macOS Core bundles retain build signatures; notarization of the GUI does not imply Developer ID notarization of the standalone Core archive.
6. With publication authorization and artifact review complete, publish the GUI compatibility entry with `--latest=false`, verify its ZIP download, then publish the unified Release as Latest. Advance `gui-update-channel` last, preserving the `gui-v<GUI version>` URL required by installed clients. Use the unified Release as the primary download entry.
7. When maintaining the Homebrew tap, copy the unified Release's `areal.rb` into `areal-project/homebrew-tap`; verify public URLs before installation checks. Install through the public URL on clean Linux, run read/write validation and verify artifact digests.

Never overwrite version assets. Inspect remote state before retrying failures; published archives are immutable. Only update-channel metadata advances to verified versions. This flow does not publish Linux container images, npm SDKs or unsupported platform packages.

## Local commands

The bundle manifest takes `apiVersion` from generated `schemas/areal-core-v1.json` and `stateVersion` from the Core Store version constant. Missing or ambiguous metadata refuses packaging before copying or signing. When reusing built binaries, verify their actual protocol/state versions against that source; the manifest does not replace binary acceptance.

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

Assemble Core artifacts and the exported production GUI from the same commit locally, using a new output directory:

```sh
python3 scripts/release-artifacts.py assemble \
  --core-assets /absolute/core-assets --gui-assets /absolute/gui-assets \
  --output /absolute/new-complete-release --version 0.1.5 \
  --revision "$(git rev-parse HEAD)"
```

`--core-assets` contains both archives, `.sha256` sidecars and `manifest-*.json`; `--gui-assets` is the complete output from `release-assets.mjs`. Assembly regenerates `latest-mac.yml` as JSON-compatible YAML pointing to the legacy GUI compatibility entry, preserving strict URL validation in installed clients.

The formula installs `bin`, `libexec`, LICENSE and the manifest, preserving Core's relative helper discovery. Linux installs versions into separate directories and atomically switches only the entry symlink. Configuration and history remain outside installer ownership. Validation failure must not switch the entry point.

## Optional platform adapter package

External platforms consume standard native release bundles through the [CLI contract](../api/claude-cli.en.md). The legacy EnvArena Python zipapp and dedicated packaging workflow are no longer distributed.

Do not require the optional adapter job in regular pull-request branch protection. Remove any existing required `Arena package` check in repository settings separately; workflow files do not change that setting.

## GUI releases

For local validation without new signatures, use `AREAL_GUI_UNSIGNED_LOCAL=1 AREAL_GUI_PACKAGE_DIR=/absolute/new-directory pnpm --dir clients/gui package`, or `python3 scripts/package.py --unsigned-local --profile debug --output /absolute/new-directory` for a CLI bundle. This explicit mode skips signing Core copies and the app while builder retains `identity: null`. It preserves input bytes and existing signatures, records actual bundle signature verification, and neither removes signatures nor changes system policy. It is incompatible with `AREAL_GUI_RELEASE=1`; the default flow still creates local ad-hoc signatures. A generated ZIP does not prove launchability: extract into a new isolated directory and validate, preserving the first system rejection and stopping that launch path if denied.

GUI versions are declared by `clients/gui/package.json` and `clients/gui/app/package.json`, independently of Cargo/CLI. Publish to `areal-project/AReaL-Harness` using `gui-v<version>` tags; CLI tags remain `v<version>`. GUI compatibility releases are not GitHub Latest; the primary release is the unified `v<Core version>` Release above, preserving the CLI installer's Latest semantics.

Production GUI packages contain `areal-update.json` with the fixed feed `https://github.com/areal-project/AReaL-Harness/releases/download/gui-update-channel/`. The `gui-update-channel` prerelease carries only the current `latest-mac.yml`; that manifest points to the immutable ZIP in `gui-v<version>` and includes size and SHA-512. Only same-repository, same-version assets are accepted. Local ad-hoc packages have no update configuration.

The macOS `dir` target does not automatically generate native update configuration. Production packaging writes `app-update.yml` before signing, using the same product feed and a fixed download cache name, and verifies the packaged configuration. Automatic builder uploads remain disabled. Discovering an update does not prove download works. The sidebar update button shows download progress, displays failures directly, and allows retries.

Run from a clean, merged commit:

```sh
make release
AREAL_GUI_RELEASE=1 AREAL_GUI_PACKAGE_DIR=/absolute/new-package make gui-package
pnpm --dir clients/gui run sign:mac --app "/absolute/new-package/package/mac-arm64/AReaL Harness GUI.app" \
  --output /absolute/new-signed-directory --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile areal-harness
node clients/gui/scripts/release-assets.mjs /absolute/new-signed-directory /absolute/new-assets
```

The signing script signs Core executables and updates integrity hashes before signing Electron. Completion requires Apple Accepted receipts, stapler, Gatekeeper, an isolated signed-package GUI/Core/Runtime smoke, model-configuration and Composer acceptance, and signature validation inside a read-only DMG mount. `notarization.json` and sanitized `release.json` record `packagedModelSelection: "passed"`; export rejects older candidates without this acceptance, requiring a new candidate built with the current signing script. Exit 2 means Apple is still processing; resume with the same script and `--resume --output`. Never modify a signed app.

Before signing, `history-copy-smoke.mjs` reads installed GUI history from `~/Library/Application Support/AReaL Harness GUI/areal-core` by default; `--history-source /absolute/areal-core` selects another source. It copies the project index, sessions, history archives, and attachments into a private isolated directory and fills fixture workspace placeholders only in copies. Private history copies retain their original bytes and workspace paths for Core ownership validation; they are observed without executing tasks. Credentials, locks, and deployment configuration are excluded; original history is never written. Only idle histories without queued work or unsettled execution state are accepted; other inputs block signing. Completed child-conversation execution references are accepted only when their terminal target turn exists in the same project copy; unresolved references, workgroups, and managed process/workflow state still block signing. The candidate must connect to Core and open every session, with byte-identical copies during observation, unchanged source files throughout, and no model requests. Queue revision changes caused by stopping copied services are handled separately. Failure precedes signing-identity checks and Apple requests. Successful evidence is bound to the candidate Core hash and recorded in `notarization.json.historyPreflight`. Older signing runs without this record cannot bypass acceptance through `--resume`; start a new run.

GUI CI runs `pnpm --dir clients/gui run test:history-compat` against the hand-authored sanitized samples in `clients/gui/scripts/fixtures/history-compat/`, including `hookRuns`, `allowPluginSkills`, and `pluginSkills`. These files contain no user history, real paths, or credentials. Locally run `node clients/gui/scripts/history-copy-smoke.mjs --source /absolute/areal-core --executable "/absolute/candidate.app/Contents/MacOS/AReaL Harness GUI"`; omitting `--executable` uses development Electron and the built Core. A builder without installed history can explicitly point `--history-source` at the controlled fixture directory; this proves fixture compatibility only. Private copies and failure evidence remain in the reported `/private/tmp/ahc-*` directory and must not be published as release assets.

Create `gui-v<version>` at the fixed commit, upload ZIP, DMG, `latest-mac.yml`, sanitized `release.json`, and `SHA256SUMS` to a draft, verify downloaded hashes, then publish with `--latest=false`. Verify version assets are downloadable before updating the `gui-update-channel` manifest; create that channel as a prerelease initially. Check full bytes, HTTP Range, manifest size, and SHA-512 after publication. Never overwrite version assets; advance the channel only to verified versions. This compatibility entry uses the same GUI ZIP/DMG bytes as the unified Release; Core bundles and the Homebrew formula are assembled by the unified flow above.

GUI updates support macOS arm64. Electron owns checks and downloads; Core shuts down for installation only after background work becomes idle and native validation finishes. Public download and package smoke checks do not prove replacement of an existing installation; that upgrade requires separate acceptance. Clients configured for other repositories or older test channels need manual installation of the first production GUI package.

`pnpm --dir clients/gui run test:update` uses real Electron preload/IPC to verify visible download errors and retry progress. Set `AREAL_GUI_EXECUTABLE` to a candidate package executable and `AREAL_GUI_UPDATE_BASELINE` to an older signed GUI executable to additionally verify the candidate's native configuration, public ZIP download and SHA-512 verification, Squirrel native staging, and safe Core shutdown. The script launches only an isolated baseline copy, borrowing candidate configuration without changing signed resources. It intercepts the final installation call, exits, and checks the version of the copy automatically replaced by Squirrel, leaving the original baseline and user installation untouched. The script prints its evidence directory.

## Build identity and GUI compatibility

`areal build-info` exposes the Core revision, dirty state, Rust/Cargo/schema input hash, and compiled API/Store versions. Packaging verifies the input hash and revision first, so an old binary cannot acquire a new checkout identity. Manifest format 2 stores coreBuild and actual component byte hashes; sourceRevision refers to Core, without independently asserting the compile source of each Runtime binary. GUI accepts legacy format 1; format 2 also requires matching API, Store version and revision between coreBuild and manifest. GUI requires areal.core.v1, a matching platform and a supported persistent version; Core still reads the Store. Rebuild after source input changes before packaging. `make desktop-schema-check` temporarily generates and compares all three normalized schemas; `make desktop-schemas` replaces them atomically after all generators succeed.
