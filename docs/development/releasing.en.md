[中文](releasing.md) | **English**

# Publishing release bundles

Validated standalone channels are complete macOS arm64 and Linux x86_64 glibc bundles with the Python installer; macOS may also ship a Homebrew formula. Unlike the [official Codex CLI installation matrix](https://learn.chatgpt.com/docs/codex/cli#getting-started), this project has no complete npm or native Windows distribution yet. `cargo install areal-cli` also lacks the Runtime and bundled tools. See [installation](../guides/installation.en.md) for platform scope.

## Candidate builds

The `Release bundles` workflow builds candidates on relevant pull requests or workflow_dispatch. These triggers upload CI artifacts without creating Git tags or Releases. It uses the pinned Rust toolchain and Cargo.lock, building natively on macOS 15 arm64 and Ubuntu 22.04 x86_64.

The workflow runs `make release`, creates complete bundles with file manifests, tar.gz archives and checksums, then extracts them into relocated paths containing spaces. A local HTTP model fixture verifies real command writes and file reads. Linux additionally installs through the installer and verifies its entry point and native tools. macOS installs the same local archive through a temporary Homebrew tap, runs `brew test` and real read/write checks, then runs the release-profile bundle lifecycle soak.

`release-artifacts.py` rejects dirty-tree or non-release-profile manifests. Candidate outputs include platform archives, manifests and SHA256 sidecars. The macOS job also generates `areal.rb` using the final download URL and actual archive checksum. Never use placeholder SHA256 values or describe unapproved candidates as released versions.

## Publication steps

1. Merge preparation changes. Confirm Verify and Release bundles pass for the selected commit; inspect version, licenses and migration notes.
2. Review both platform candidates, Homebrew checks and Linux installation logs; confirm scope and version.
3. Create tag `v0.1.4` on the selected commit. It must match `areal --version`. Tag builds reconstruct and verify both packages, then create a **draft** Release only after all checks pass; they do not publish it.
4. Download draft assets and verify SHA256SUMS and manifest sourceRevision, profile and platform. Complete release notes covering default permissions, dependencies, retired timeout settings, compaction defaults and known caching limitations. macOS has no Developer ID signing/notarization and must not be labeled notarized.
5. Publish the draft after explicit approval. Create/update `Formula/areal.rb` in `areal-project/homebrew-tap` from that Release asset. Confirm public download availability before testing `brew install areal-project/tap/areal`.
6. Install through the public URL on clean Linux and run read/write validation. Record artifact digests and results. Repeat for future versions without replacing published archives.

Tagging, publishing and tap creation/updates are external publication operations performed after artifact review. The draft job does not overwrite existing Releases; inspect remote state before retrying failures. This workflow does not publish Linux container images.

## Local commands

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

The formula installs `bin`, `libexec`, LICENSE and the manifest, preserving Core's relative helper discovery. Linux installs versions into separate directories and atomically switches only the entry symlink. Configuration and history remain outside installer ownership. Validation failure must not switch the entry point.

## GUI releases

GUI versions are declared by `clients/gui/package.json` and `clients/gui/app/package.json`, independently of Cargo/CLI. Publish to `areal-project/AReaL-Harness` using `gui-v<version>` tags; CLI tags remain `v<version>`. GUI releases are not GitHub Latest, preserving the CLI installer's Latest semantics.

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

Create `gui-v<version>` at the fixed commit, upload ZIP, DMG, `latest-mac.yml`, sanitized `release.json`, and `SHA256SUMS` to a draft, verify downloaded hashes, then publish with `--latest=false`. Verify version assets are downloadable before updating the `gui-update-channel` manifest; create that channel as a prerelease initially. Check full bytes, HTTP Range, manifest size, and SHA-512 after publication. Never overwrite version assets; advance the channel only to verified versions. This workflow does not publish CLI bundles or update the Homebrew tap.

GUI updates support macOS arm64. Electron owns checks and downloads; Core shuts down for installation only after background work becomes idle and native validation finishes. Public download and package smoke checks do not prove replacement of an existing installation; that upgrade requires separate acceptance. Clients configured for other repositories or older test channels need manual installation of the first production GUI package.

`pnpm --dir clients/gui run test:update` uses real Electron preload/IPC to verify visible download errors and retry progress. Set `AREAL_GUI_EXECUTABLE` to a candidate package executable and `AREAL_GUI_UPDATE_BASELINE` to an older signed GUI executable to additionally verify the candidate's native configuration, public ZIP download and SHA-512 verification, Squirrel native staging, and safe Core shutdown. The script launches only an isolated baseline copy, borrowing candidate configuration without changing signed resources. It intercepts the final installation call, exits, and checks the version of the copy automatically replaced by Squirrel, leaving the original baseline and user installation untouched. The script prints its evidence directory.
