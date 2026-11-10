[中文](agent-environment.md) | **English**

# Agent environment and verification layers

What an agent (or a person) can verify in a cloud container, and what still needs a Mac. The product is in early Beta and does not support downgrades.

## Set up

```bash
make agent-setup                      # system packages, Node (see .node-version), deps, Chromium, build
AGENT_SETUP_SKIP_BUILD=1 make agent-setup   # environment only
```

`target/agent-env.json` then lists what the machine can do (`core-binary`, `gui-build`, `electron`, `browser`, `native-runtime`, `node-24`, ...). The test manifest skips entries whose `requires` are missing and lists them; a skip is not a pass.

## Did your change cause it?

```bash
make baseline-diff BASE=origin/codex/one-protocol-integration CMD='cargo test -p areal-host --lib'
make baseline-diff BASE=... CMD='pnpm --dir clients/gui exec vp test run' PREPARE='make gui-install'
```

Runs the same command on the base commit and the working tree and lists only cases whose status changed. Cases already red on the base are not regressions; only "passed on base, fails now" fails the command. The base worktree and build live under `target/baseline*` and can be deleted.

## Name consistency

`make check-refs` (part of `make check-changed`) checks that files named in package.json, the Makefile and workflows exist, that backticked paths in development docs exist, and that every script under `scripts/` and `clients/gui/scripts/` has an entry point. Existing orphans are recorded in `scripts/check-references-baseline.json` and may only shrink; after wiring or deleting one, run `python3 scripts/check-references.py --write`.

## Transitional code

`make check-transitional` (part of `make check-changed`) requires product code whose names contain legacy / compat to have a "过渡：到 <version> 删" comment within three lines; once that version is not above the current version, the check reports it as expired. Existing unmarked code is recorded per file in `scripts/check-transitional-baseline.json` and may only shrink. fallback and migration are excluded: the former is usually an ordinary default, the latter includes permanent Store migrations.

## Verification layers

| Layer | Where | Command |
| --- | --- | --- |
| Unit and contract | cloud and Mac | `make check-changed`, `pnpm --dir clients/gui run test:<name>` |
| Web journeys | cloud and Mac | `pnpm --dir clients/gui run test:web-journeys` |
| Desktop journeys | cloud (xvfb) and Mac | `pnpm --dir clients/gui run test:ux-journeys` |
| Desktop shell | Mac only | "Mac acceptance" below |

Web and desktop share one UI and one Host protocol, so business journeys that pass on the web do not need to be clicked through again on a Mac. Wrap with `xvfb-run` on Linux without a display; set `AREAL_CHROMIUM` when the browser cannot be downloaded.

## Desktop shell capabilities

`clients/gui/packages/workbench/client/desktop-contract/shell-capabilities.cjs` classifies every preload member and every command the main process handles itself:

- `shell`: system capabilities only the desktop has; the web needs no equivalent.
- `transitional`: business reads and writes still over IPC while the web already uses Host. Remove the entry and lower the limit once it moves to Host.

`clients/gui/scripts/shell-capabilities.test.cjs` (`test:health`) keeps the list in sync with preload and the command table, and `transitional` may only shrink.

## Mac acceptance

Not covered in the cloud; run before a release:

1. Signed and notarized package opens; `brew` install works.
2. Keychain: model credentials write, read, and isolated identities do not collide.
3. Auto-update: check, download, apply, recover resources after failure.
4. Real-data upgrade: upgrade a copy of local data; projects, history and Arena config survive.
5. Phone pairing: scan to pair, relay connection, push.
6. Computer control: accessibility and screen-recording permission requests, use after grant, prompt after revoke.
7. Screenshots: shortcut, permission, screenshot into a conversation.
8. Command-line tool install, deep links, notification click-through.
