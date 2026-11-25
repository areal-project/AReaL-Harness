"""每个 PR 运行稳定门禁；只对适用路径执行昂贵矩阵。"""

import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
JOURNEY_MANIFEST = ROOT / "clients/gui/scripts/journey-manifest.json"
spec = importlib.util.spec_from_file_location(
    "journey_registry", ROOT / "scripts/check-journeys.py"
)
journey_registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journey_registry)
SCOPES = {
    "gui": [
        "design/**",
        "services/remote-relay/**",
        "services/workbench/**",
        "clients/**",
        "core/**",
        "runtime/**",
        "schemas/**",
        "Cargo.*",
        "rust-toolchain.toml",
        "Makefile",
        "scripts/**",
        ".github/workflows/**",
        ".githooks/**",
    ],
    "release": [
        "design/tokens/**",
        "services/workbench/**",
        "clients/**",
        "core/**",
        "runtime/**",
        "schemas/**",
        "Cargo.*",
        "rust-toolchain.toml",
        "Makefile",
        "scripts/**",
        "examples/desktop-api/**",
        "tests/fixtures/**",
        "package*.json",
        "upstream/**",
        ".github/workflows/**",
    ],
}


WORKFLOW_GROUPS = {
    "gui": {
        "gui-health",
        "gui-portable",
        "gui-browser",
        "relay-build",
        "relay",
        "gui-build",
        "core-contracts",
        "gui-native-checks",
        "smoke",
    },
    "verify": {
        "early",
        "verify",
        "verify-build",
        "verify-tests",
        "verify-integration",
        "native",
        "container",
        "audit",
    },
}
JOB_GROUPS = {
    "gui": {
        "scope": None,
        "gui-health": {"gui-health"},
        "gui-portable": {"gui-portable"},
        "gui-browser": {"gui-browser"},
        "relay-contracts": {"relay-build", "relay"},
        "gui": {"gui-build"},
        "core-contracts": {"core-contracts", "gui-native-checks"},
        "smoke": {"smoke"},
    },
    "verify": {
        "plan": None,
        "host": {"early", "verify"},
        "linux-build": {"verify-build"},
        "rust-tests": {"verify-tests"},
        "linux-integration": {"verify-integration"},
        "native-macos": {"native"},
        "container": {"container"},
        "dependencies": {"audit"},
    },
}
CI_PLATFORMS = {
    group: (
        "darwin"
        if group in {"native", "gui-build", "core-contracts", "gui-native-checks", "smoke"}
        else "linux"
    )
    for group in set().union(*WORKFLOW_GROUPS.values())
}

# 按实测时长把 Linux workspace 行为测试拆成 3 片并行执行（覆盖除 areal-runtime-exec-native 外的全部成员）。
RUST_TEST_SHARDS = [
    {
        "shard": "engine",
        "id": "rust-tests:engine",
        "packages": ["areal-engine"],
    },
    {
        "shard": "host",
        "id": "rust-tests:host",
        "packages": ["areal-host", "areal-app-server", "areal-server", "areal-cli", "areal-tui"],
    },
    {
        "shard": "runtime",
        "id": "rust-tests:runtime",
        "packages": [
            "areal-config",
            "areal-protocol",
            "areal-plugins",
            "areal-mcp",
            "areal-trajectory",
            "areal-service-host",
            "areal-local-service",
            "areal-runtime-protocol",
            "areal-runtime-host-tools",
            "areal-runtime-client",
            "areal-runtime-supervisor",
            "areal-runtime",
            "areal-runtime-fs",
        ],
    },
]

# 跨平台 Harness / Desktop API / Workgroup 集成拆为两片在 Linux 原生 bwrap 环境并行执行。
LINUX_INTEGRATION_SHARDS = [
    {
        "shard": "core",
        "id": "linux-integration:core",
        "command": ["make", "-k", "-j2", "harness-smoke-core", "workgroup-smoke"],
    },
    {
        "shard": "extended",
        "id": "linux-integration:extended",
        "command": ["make", "-k", "-j2", "harness-smoke-extended", "examples-desktop-api"],
    },
]

# 纯 Chromium 前端验收按实测时长分两片在 Linux 并行执行，不占用 macOS 配额，也不等待 Rust 编译。
BROWSER_SHARDS = [
    {
        "shard": "reading-audit",
        "items": ["smoke:test:conversation-reading", "smoke:test:ui-audit"],
    },
    {
        "shard": "design",
        "items": ["smoke:test:design", "design-conversation", "design-popups"],
    },
]

# 参考 CI 实测（run 45552994328）用于 LPT 装桶，让 macOS smoke 与 max-parallel=4 对齐、避免排队与冷启浪费。
SMOKE_DURATION_ESTIMATES_S = {
    "smoke:test:model-selection-core": 255,
    "smoke:test:model-selection-defaults": 235,
    "smoke:test:composer-files": 218,
    "smoke:test:side-chat-parity": 216,
    "smoke:test:composer": 147,
    "smoke:test:e2e": 130,
    "smoke:test:web-journeys": 125,
    "smoke:test:connection-recovery": 114,
    "smoke:test:ux-journeys": 112,
    "smoke:test:conversation-derivation": 107,
    "smoke:test:service-reopen": 89,
    "smoke:test:stop-reopen": 85,
    "smoke:test:browser-navigation": 77,
    "smoke:test:queue": 56,
    "smoke:test:history-compat": 54,
}

# 短原生检查复用第二个合同分片的准备；结果仍按原检查 ID 独立收集。
CORE_LANES = [
    {"lane": "contracts-1", "group": "core-contracts", "item": "core-contracts", "native": False},
    {"lane": "contracts-2", "group": "core-contracts", "item": "core-contracts:2", "native": True},
]


REQUIREMENT_HINTS = {
    "python3": "Python >=3.11 with tomllib and tar extraction filtering; activate the repository .venv",
    "native-runtime": "macOS Seatbelt, or /usr/bin/bwrap with usable user namespaces on Linux",
    "container-runtime": "a running Docker daemon and current-source labeled areal-ci:runtime-tests image",
    "container-profile": "the supported areal-ci:runtime image labeled for this source and input hash",
    "macos-tools": "codesign and hdiutil on macOS",
    "xcode": "Xcode with a Swift compiler selected through xcrun",
    "node-24.22.1": "use the pinned GUI Node 24.22.1 runtime",
    "node-24.2.0": "use the pinned Relay runtime or set AREAL_RELAY_NODE_BIN to Node 24.2.0",
    "electron": "install the locked GUI Electron dependency",
    "browser": "install Google Chrome for the browser acceptance checks",
    "relay-node-24.2.0": "set AREAL_RELAY_NODE_BIN to the independent Relay Node 24.2.0 runtime",
    "playwright-chromium": "install the locked playwright-core Chromium browser",
    "playwright-webkit": "install the locked playwright-core WebKit browser",
}


def impact(paths):
    code = [
        path
        for path in paths
        # 仅明确的说明文档、仓库非运行时元数据与独立 workflow 站点可跳过；内置 SKILL.md、设计合同等仍是产品输入。
        if not (
            path.startswith(("docs/", "website/", ".github/ISSUE_TEMPLATE/"))
            or path.startswith("tests/guides/")
            and path.endswith(".md")
            or path
            in {
                ".editorconfig",
                ".gitattributes",
                ".github/PULL_REQUEST_TEMPLATE.md",
                ".gitignore",
                ".worktreeinclude",
                "AGENTS.md",
                "CHANGELOG.en.md",
                "CHANGELOG.md",
                "CONTRIBUTING.en.md",
                "CONTRIBUTING.md",
                "DESIGN.md",
                "GLOSSARY.en.md",
                "GLOSSARY.md",
                "LEGAL.md",
                "LICENSE",
                "PRODUCT.md",
                "README.en.md",
                "README.md",
                "REVIEW.md",
                "SECURITY.en.md",
                "SECURITY.md",
            }
            or path.endswith(".md")
            and path.startswith(("design/", "clients/gui/design-system/"))
        )
    ]
    unknown = [
        path
        for path in code
        if not any(
            fnmatch.fnmatchcase(path, pattern)
            for patterns in SCOPES.values()
            for pattern in patterns
        )
    ]
    shared = bool(unknown) or any(
        path.startswith(
            (
                "core/",
                "runtime/",
                "schemas/",
                "services/workbench/",
                "scripts/",
                ".github/",
                ".githooks/",
                "clients/cli/",
                "clients/tui/",
                "upstream/",
                "design/tokens/",
            )
        )
        or path.endswith((".rs", "/Cargo.toml"))
        or path
        in (
            "Cargo.toml",
            "Cargo.lock",
            "Makefile",
            "rust-toolchain.toml",
            "package.json",
            "package-lock.json",
            "uv.lock",
            "pyproject.toml",
        )
        for path in code
    )
    gui = shared or any(
        fnmatch.fnmatchcase(path, pattern) for path in code for pattern in SCOPES["gui"]
    )
    health = gui or any(
        path.endswith(".md") and path.startswith(("design/", "clients/gui/design-system/"))
        for path in paths
    )
    return {
        "shared": shared,
        "gui": gui,
        "health": health,
        "relay": gui,
        "unknown": unknown,
        "code": code,
    }


def applicable(scope, paths):
    return bool(impact(paths)["unknown"]) or any(
        fnmatch.fnmatchcase(path, pattern)
        for path in impact(paths)["code"]
        for pattern in SCOPES[scope]
    )


def git(root, *args):
    return subprocess.check_output(["git", "--no-optional-locks", *args], cwd=root)


def changed_paths(root, base):
    tracked = git(root, "diff", "--name-only", "--no-renames", "-z", base, "--")
    staged = git(root, "diff", "--cached", "--name-only", "--no-renames", "-z", base, "--")
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    return sorted(
        {os.fsdecode(path) for path in (tracked + staged + untracked).split(b"\0") if path}
    )


def input_key(root, base):
    digest = hashlib.sha256(base.encode())
    digest.update(git(root, "rev-parse", "HEAD"))
    digest.update(git(root, "diff", "--binary", "--no-ext-diff", "--no-textconv", base, "--"))
    digest.update(
        git(root, "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", base, "--")
    )
    for name in changed_paths(root, base):
        digest.update(os.fsencode(name) + b"\0")
        path = root / name
        if path.is_symlink():
            digest.update(os.fsencode(os.readlink(path)))
        elif path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


def repository_plan(root, base=None):
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    event = json.loads(Path(event_path).read_text()) if event_path else {}
    pr = event.get("pull_request") or {}
    comparison = (
        base or pr.get("base", {}).get("sha") or (event.get("inputs") or {}).get("comparison_base")
    )
    revision = git(root, "rev-parse", "HEAD").decode().strip()
    fallback = False
    try:
        # workflow_dispatch accepts a branch name for convenience, while the
        # checkout refspec may only contain the requested head. Resolve the
        # corresponding remote-tracking ref before calculating the merge base.
        candidate = comparison or "HEAD"
        try:
            git(root, "rev-parse", "--verify", f"{candidate}^{{commit}}")
        except subprocess.CalledProcessError:
            if candidate and not candidate.startswith("origin/"):
                candidate = f"origin/{candidate}"
        comparison = git(root, "merge-base", candidate, "HEAD").decode().strip()
        paths = (
            changed_paths(root, comparison)
            if base or pr
            else [os.fsdecode(path) for path in git(root, "ls-files", "-z").split(b"\0") if path]
        )
    except subprocess.CalledProcessError:
        comparison, fallback = revision, True
        paths = [os.fsdecode(path) for path in git(root, "ls-files", "-z").split(b"\0") if path]
    source = {
        "baseRevision": comparison,
        "sourceRevision": revision,
        "headRevision": pr.get("head", {}).get("sha", revision),
        "inputHash": input_key(root, comparison),
    }
    manifest = json.loads((root / "clients/gui/scripts/test-manifest.json").read_text())
    plan = build_plan(sorted(set(paths)), source, manifest)
    if fallback:
        plan["selectionFallback"] = "comparison unavailable; every tracked input selected"
        plan.pop("planHash")
        plan["planHash"] = hashlib.sha256(
            json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    return plan


def build_plan(paths, source, manifest):
    """计划不接收环境能力；缺少前提只能产生 blocked，不能删项。"""
    affected = impact(paths)
    items = []
    registry = journey_registry.load_manifest(JOURNEY_MANIFEST)
    journeys = registry["journeys"]
    affected_journeys = sorted(journey_registry.affected(paths, registry))
    journey_authorities = {
        journey["id"]: journey["authorities"]
        for journey in journeys
        if journey["id"] in affected_journeys
    }
    journey_checks = {
        journey["id"]: journey["checks"]
        for journey in journeys
        if journey["id"] in affected_journeys
    }
    required_journey_checks = {check for checks in journey_checks.values() for check in checks}
    journey_evidence = {
        journey["id"]: {
            "journeyId": journey["id"],
            "check": journey["evidenceCheck"],
            "terminalFacts": journey["terminalFacts"],
        }
        for journey in journeys
        if journey["id"] in affected_journeys and "evidenceCheck" in journey
    }

    def add(
        name,
        command,
        group,
        dependencies=(),
        requires=(),
        phase="full",
        platforms=("darwin", "linux"),
        expected=None,
    ):
        if command[0] in {"make", "python3"}:
            requires = (*requires, "python3")
        item = {
            "id": name,
            "command": command,
            "group": group,
            "dependsOn": list(dependencies),
            "requires": sorted(set(requires)),
            "phase": phase,
            "platforms": list(platforms),
            "reasons": paths,
        }
        if expected is not None:
            item["expectedTests"] = expected
        items.append(item)

    def gui_builds(prefix, group, platforms=("darwin", "linux"), phase="full"):
        desktop, ui, renderer = (prefix + suffix for suffix in ("desktop", "ui", "renderer"))
        add(
            desktop,
            ["pnpm", "--dir", "clients/gui", "build:desktop"],
            group,
            requires=("node-24.22.1",),
            phase=phase,
            platforms=platforms,
        )
        add(
            ui,
            ["pnpm", "--dir", "clients/gui", "--filter", "@areal/ui", "build"],
            group,
            requires=("node-24.22.1",),
            phase=phase,
            platforms=platforms,
        )
        add(
            renderer,
            ["pnpm", "--dir", "clients/gui", "--filter", "@areal/gui-renderer", "build"],
            group,
            (desktop, ui),
            ("node-24.22.1",),
            phase=phase,
            platforms=platforms,
        )
        add(
            prefix + "bundle",
            ["node", "clients/gui/scripts/bundle-budget.mjs", "--check"],
            group,
            (renderer,),
            phase=phase,
            platforms=platforms,
        )
        return desktop, ui, renderer

    if paths:
        add("format", ["make", "fmt-check"], "early", phase="commit")
        add("workflow", ["make", "workflow-lint"], "early", phase="commit")
        add(
            "architecture-boundary",
            ["python3", "scripts/check-architecture.py"],
            "early",
            phase="commit",
        )
        add(
            "journey-registry",
            ["python3", "scripts/check-journeys.py"],
            "early",
            phase="commit",
        )
        add(
            "plan-contracts",
            [
                "python3",
                "-m",
                "unittest",
                "scripts.tests.test_ci_contracts",
                "scripts.tests.test_check_changed",
                "scripts.tests.test_git_hooks",
                "scripts.tests.test_architecture_journeys",
            ],
            "early",
            phase="commit",
        )
        add("docs", ["python3", "scripts/check-docs.py"], "early", phase="commit")
    if affected["code"]:
        add(
            "dependency-audit",
            ["python3", "scripts/dependency-audit.py"],
            "audit",
            platforms=("linux",),
        )
    if affected["shared"]:
        add("schema", ["make", "desktop-schema-check"], "verify", phase="commit")
        add(
            "schema-rejection",
            ["python3", "scripts/desktop-schemas.py", "--counterexample"],
            "verify",
            ("schema",),
        )
    if affected["health"]:
        add(
            "gui-health",
            ["make", "ci-gui-health", "CI_BASE=" + source["baseRevision"]],
            "gui-health",
            phase="commit",
        )
    if affected["gui"]:
        add(
            "workbench-core-boundary",
            ["node", "clients/gui/scripts/workbench-boundary.mjs"],
            "gui-portable",
            phase="commit",
        )
        add(
            "manifest",
            ["node", "--test", "clients/gui/scripts/test-manifest.test.mjs"],
            "gui-portable",
            phase="commit",
        )
        desktop, ui, renderer = gui_builds("portable:", "gui-portable", phase="commit")
        portable_design = "portable:design-build"
        add(
            portable_design,
            ["pnpm", "--dir", "clients/gui", "design:build"],
            "gui-portable",
            (desktop, ui),
            ("node-24.22.1",),
            phase="full",
        )
        for name, command in (
            ("gui-check", "check"),
            ("gui-design-contracts", "verify:design"),
            ("gui-types", "typecheck"),
            ("gui-public", "verify:ci"),
            ("gui-regressions", "test:regressions"),
        ):
            add(
                name,
                ["pnpm", "--dir", "clients/gui", "run", command],
                "gui-portable",
                (desktop, ui),
                phase="commit",
            )
        portable = {
            platform: [
                entry["script"]
                for entry in manifest
                if platform in entry["platforms"]
                and entry["layer"] != "e2e"
                and "core-binary" not in entry["requires"]
                and "node-24.2.0" not in entry["requires"]
                and "macos-tools" not in entry["requires"]
            ]
            for platform in ("darwin", "linux")
        }
        add(
            "gui-portable",
            ["node", "clients/gui/scripts/run-portable-tests.mjs"],
            "gui-portable",
            (renderer,),
            ("node-24.22.1", "python3", "git"),
            expected=portable,
        )
        add("gui-audit", ["pnpm", "--dir", "clients/gui", "audit"], "gui-portable")
    if affected["relay"]:
        _, _, renderer = gui_builds("relay:", "relay-build")
        add(
            "relay-install",
            ["npm", "ci", "--prefix", "services/remote-relay"],
            "relay",
            requires=("node-24.2.0",),
        )
        add(
            "relay-contracts",
            ["pnpm", "--dir", "clients/gui", "test:remote-relay"],
            "relay",
            ("relay-install", renderer),
            ("node-24.2.0", "openssl"),
        )
    if affected["shared"]:
        # rust-lint 的 cargo clippy --workspace --all-targets 已包含全量类型检查，不再单独重复跑 cargo check。
        for name, target in (
            ("rust-lint", "lint"),
            ("sdk", "sdk-test"),
            ("scripts", "script-test"),
            ("cordis", "cordis-pin"),
        ):
            add(
                name,
                ["make", target],
                "verify",
                phase="commit" if name == "rust-lint" else "full",
            )
        add("verify-core-build", ["make", "build"], "verify-build")
        for name, target in (
            ("launcher", "launcher-test"),
            ("core-smoke", "smoke"),
        ):
            add(name, ["make", target], "verify-build", ("verify-core-build",))
        for shard in RUST_TEST_SHARDS:
            package_args = [arg for package in shard["packages"] for arg in ("-p", package)]
            add(
                shard["id"],
                ["cargo", "test", "--locked", "--no-fail-fast", *package_args],
                "verify-tests",
                ("verify-core-build",),
            )
        for shard in LINUX_INTEGRATION_SHARDS:
            add(
                shard["id"],
                shard["command"],
                "verify-integration",
                ("verify-core-build",),
                ("native-runtime",),
                platforms=("linux",),
            )
        add("native-core-build", ["make", "build"], "native", platforms=("darwin",))
        for name, command in (
            (
                "native-replay",
                [
                    "cargo",
                    "test",
                    "--locked",
                    "-p",
                    "areal-engine",
                    "--features",
                    "native-tests",
                    "--test",
                    "provider_replay",
                ],
            ),
            (
                "legacy-native-access",
                [
                    "cargo",
                    "test",
                    "--locked",
                    "-p",
                    "areal-app-server",
                    "--test",
                    "side_workspace_read",
                    "--",
                    "--ignored",
                ],
            ),
            ("native-backend", ["cargo", "test", "--locked", "-p", "areal-runtime-exec-native"]),
            (
                "native-transport",
                [
                    "cargo",
                    "test",
                    "--locked",
                    "-p",
                    "areal-runtime",
                    "--features",
                    "native-tests",
                    "--test",
                    "native_transport",
                ],
            ),
            (
                "native-macos-smoke",
                ["make", "macos-native-smoke"],
            ),
        ):
            add(
                name,
                command,
                "native",
                ("native-core-build",),
                ("native-runtime",),
                platforms=("darwin",),
            )
        security = [
            "--security-opt",
            "seccomp=unconfined",
            "--security-opt",
            "systempaths=unconfined",
            "--security-opt",
            "apparmor=unconfined",
        ]
        profile = ["docker", "run", "--rm", "--network", "none", *security]
        add(
            "container-native",
            [*profile, "areal-ci:runtime-tests"],
            "container",
            requires=("container-runtime",),
            platforms=("linux",),
        )
        add(
            "container-sandbox",
            [
                "python3",
                "-c",
                "import sys; sys.path.insert(0, 'tests/perf'); from perf import smoke_runtime_profile; raise SystemExit(smoke_runtime_profile('areal-ci:runtime'))",
            ],
            "container",
            requires=("container-profile",),
            platforms=("linux",),
        )
        add(
            "container-tools",
            [
                *profile,
                "-e",
                "IS_SANDBOX=1",
                "--mount",
                "type=bind,source={root},target=/repo,readonly",
                "-w",
                "/repo",
                "--entrypoint",
                "python3",
                "areal-ci:runtime",
                "scripts/native-tools-smoke.py",
                "--bin-dir",
                "/usr/local/bin",
                "--sandbox-profile",
                "outer-container-perf",
            ],
            "container",
            requires=("container-profile",),
            platforms=("linux",),
        )
        add(
            "container-js-dependencies",
            ["npm", "ci", "--ignore-scripts"],
            "container",
            requires=("node-24.22.1",),
            platforms=("linux",),
        )
        add(
            "container-unified",
            [
                *profile,
                "--mount",
                "type=bind,source={root},target=/repo,readonly",
                "--mount",
                "type=bind,source={root}/target/ci/unified,target=/evidence",
                "-w",
                "/repo",
                "-e",
                "AREAL_UNIFIED_BIN_DIR=/usr/local/bin",
                "-e",
                "AREAL_UNIFIED_EVIDENCE_DIR=/evidence",
                "--entrypoint",
                "node",
                "areal-ci:runtime",
                "scripts/unified-execution-smoke.mjs",
            ],
            "container",
            ("container-js-dependencies",),
            ("container-profile",),
            platforms=("linux",),
        )
        add(
            "container-ownership",
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--entrypoint",
                "python3",
                "--mount",
                "type=bind,source={root},target=/repo,readonly",
                "-w",
                "/repo",
                "areal-ci:runtime",
                "tests/perf/perf.py",
                "self-test",
            ],
            "container",
            requires=("container-profile",),
            platforms=("linux",),
        )

    if affected["gui"]:
        desktop, ui, renderer = gui_builds("macos:", "gui-build", ("darwin",))
        add("gui-core-build", ["make", "build"], "gui-build", platforms=("darwin",))
        for entry in manifest:
            if (
                entry["layer"] != "e2e"
                and "macos-tools" in entry["requires"]
                and "core-binary" not in entry["requires"]
            ):
                add(
                    "native-contract:" + entry["script"],
                    ["pnpm", "--dir", "clients/gui", "run", entry["script"]],
                    "gui-native-checks",
                    (desktop, renderer),
                    tuple(sorted(set(entry["requires"]) - {"gui-build"})),
                    platforms=("darwin",),
                )
        for name, command in (
            ("macos-process", ["pnpm", "--dir", "clients/gui", "test:core-process"]),
            ("macos-browser", ["pnpm", "--dir", "clients/gui", "test:browser-contracts"]),
        ):
            add(
                name,
                command,
                "gui-native-checks",
                ("gui-core-build", renderer, desktop),
                platforms=("darwin",),
            )
        for name, command in (
            (
                "design-conversation",
                ["pnpm", "--dir", "clients/gui", "test:design", "--", "--conversation-system"],
            ),
            (
                "design-popups",
                ["pnpm", "--dir", "clients/gui", "test:design", "--", "--popup-anchors"],
            ),
        ):
            add(
                name,
                command,
                "gui-browser",
                ("portable:renderer", "portable:design-build"),
                ("browser", "node-24.22.1"),
                platforms=("darwin", "linux"),
            )
        core_tests = {
            platform: [
                entry["script"]
                for entry in manifest
                if platform in entry["platforms"]
                and entry["layer"] != "e2e"
                and "core-binary" in entry["requires"]
            ]
            for platform in ("darwin", "linux")
        }
        for shard in range(2):
            add(
                "core-contracts" if shard == 0 else "core-contracts:2",
                ["node", "clients/gui/scripts/run-portable-tests.mjs", "--core-contracts"],
                "core-contracts",
                ("gui-core-build", renderer, desktop),
                ("node-24.22.1", "native-runtime"),
                platforms=("darwin",),
                expected={platform: scripts[shard::2] for platform, scripts in core_tests.items()},
            )
        for entry in manifest:
            if entry.get("ciSmoke") or "smoke:" + entry["script"] in required_journey_checks:
                browser_only = (
                    "browser" in entry["requires"]
                    and "electron" not in entry["requires"]
                    and "core-binary" not in entry["requires"]
                )
                if browser_only:
                    add(
                        "smoke:" + entry["script"],
                        ["pnpm", "--dir", "clients/gui", "run", entry["script"]],
                        "gui-browser",
                        ("portable:renderer", "portable:design-build"),
                        tuple(sorted(set(entry["requires"]) - {"gui-build"})) + ("node-24.22.1",),
                        platforms=tuple(p for p in entry["platforms"] if p in ("darwin", "linux")),
                    )
                else:
                    add(
                        "smoke:" + entry["script"],
                        ["pnpm", "--dir", "clients/gui", "run", entry["script"]],
                        "smoke",
                        ("gui-core-build", renderer, desktop),
                        tuple(sorted(set(entry["requires"]) - {"core-binary", "gui-build"}))
                        + ("node-24.22.1",),
                        platforms=tuple(p for p in entry["platforms"] if p == "darwin"),
                    )
    journey_registry.validate_checks(registry, items, affected_journeys)
    for contract in journey_evidence.values():
        item = next(item for item in items if item["id"] == contract["check"])
        if "journeyEvidence" in item:
            raise ValueError("a business evidence runner must belong to one journey")
        item["journeyEvidence"] = {
            "journeyId": contract["journeyId"],
            "terminalFacts": contract["terminalFacts"],
        }
    production_tasks = {
        "macos:desktop": "desktop-build",
        "macos:ui": "ui-build",
        "macos:renderer": "build-suite",
    }
    for item in items:
        if item["id"] in production_tasks:
            item["productionTask"] = production_tasks[item["id"]]
    items.sort(
        key=lambda item: 1 if item["id"] == "schema" else 0 if item["phase"] == "commit" else 2
    )
    plan = {
        "schemaVersion": 1,
        "source": source,
        "paths": paths,
        "fallbackPaths": affected["unknown"],
        "affectedJourneys": affected_journeys,
        "journeyAuthorities": journey_authorities,
        "journeyChecks": journey_checks,
        "journeyEvidence": journey_evidence,
        "items": items,
    }
    plan["planHash"] = hashlib.sha256(
        json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return plan


def smoke_matrix(plan, manifest):
    entries = {entry["script"]: entry for entry in manifest}
    return {
        "include": [
            {
                "scenario": entries[item["command"][-1]].get("ciSmoke")
                or item["command"][-1].removeprefix("test:"),
                "script": item["command"][-1],
            }
            for item in plan["items"]
            if item["group"] == "smoke"
        ]
    }


def smoke_shards(plan, manifest, buckets=4):
    """按实测时长 LPT 装桶，将 macOS Electron smoke 合并成均衡 shard，消除冷启动与队列等待。"""
    entries = {entry["script"]: entry for entry in manifest}
    smoke_items = [item for item in plan["items"] if item["group"] == "smoke"]
    if not smoke_items:
        return {"include": []}
    count = max(1, min(buckets, len(smoke_items)))
    ordered = sorted(
        smoke_items,
        key=lambda item: (-SMOKE_DURATION_ESTIMATES_S.get(item["id"], 120), item["id"]),
    )
    bins = [{"weight": 0, "items": [], "scenarios": []} for _ in range(count)]
    for item in ordered:
        target = min(bins, key=lambda bucket: (bucket["weight"], len(bucket["items"])))
        target["weight"] += SMOKE_DURATION_ESTIMATES_S.get(item["id"], 120)
        target["items"].append(item["id"])
        script = item["command"][-1]
        target["scenarios"].append(entries[script].get("ciSmoke") or script.removeprefix("test:"))
    return {
        "include": [
            {
                "shard": f"shard-{index + 1}",
                "items": ",".join(bucket["items"]),
                "scenarios": ",".join(bucket["scenarios"]),
            }
            for index, bucket in enumerate(bins)
            if bucket["items"]
        ]
    }


def browser_matrix(plan):
    planned = {item["id"] for item in plan["items"] if item["group"] == "gui-browser"}
    assigned = set()
    include = []
    for shard in BROWSER_SHARDS:
        items = [name for name in shard["items"] if name in planned]
        if items:
            assigned.update(items)
            include.append({"shard": shard["shard"], "items": ",".join(items)})
    remainder = sorted(planned - assigned)
    if remainder:
        include.append({"shard": "extra", "items": ",".join(remainder)})
    return {"include": include}


FAST_CONTAINER_FILES = frozenset(
    {
        "tests/e2e/docker/Dockerfile.ci-fast",
        "tests/e2e/docker/Dockerfile.ci-fast.dockerignore",
    }
)


def full_container_required(paths, event_name=None, fallback=False):
    if fallback or event_name in {"push", "workflow_dispatch"}:
        return True
    return any(
        path not in FAST_CONTAINER_FILES
        and path.startswith(("tests/e2e/docker/", "runtime/exec-native/"))
        for path in paths
    )


def require_result(needed, result):
    # 不适用必须由成功的路径判定明确声明，取消和意外 skip 都失败。
    return result == ("success" if needed else "skipped")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--output", type=Path, default=ROOT / "target/ci/plan.json")
    args = parser.parse_args()
    plan = repository_plan(ROOT, args.base)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n")
    groups = {item["group"] for item in plan["items"]}
    manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
    matrix = smoke_matrix(plan, manifest)
    shards = smoke_shards(plan, manifest)
    browsers = browser_matrix(plan)
    rust_test_matrix = {
        "include": [
            {"shard": shard["shard"], "item": shard["id"]}
            for shard in RUST_TEST_SHARDS
            if any(item["id"] == shard["id"] for item in plan["items"])
        ]
    }
    linux_integration_matrix = {
        "include": [
            {"shard": shard["shard"], "item": shard["id"]}
            for shard in LINUX_INTEGRATION_SHARDS
            if any(item["id"] == shard["id"] for item in plan["items"])
        ]
    }
    host = [
        {
            "os": "ubuntu-24.04",
            "name": "Linux static and lint",
            "target": "early,verify" if "verify" in groups else "early",
            "setup": "setup",
            "log": "verify",
            "rust_cache": "verify" in groups,
        }
    ]
    container_full = full_container_required(
        plan["paths"],
        os.environ.get("GITHUB_EVENT_NAME"),
        bool(plan.get("selectionFallback")),
    )
    outputs = {
        name.replace("-", "_"): str(name in groups).lower()
        for name in set().union(*WORKFLOW_GROUPS.values())
    }
    outputs.update(
        gui=str(bool(groups & WORKFLOW_GROUPS["gui"])).lower(),
        release=str(applicable("release", plan["paths"])).lower(),
        smoke_matrix=json.dumps(matrix, separators=(",", ":")),
        smoke_shards=json.dumps(shards, separators=(",", ":")),
        browser_matrix=json.dumps(browsers, separators=(",", ":")),
        rust_test_matrix=json.dumps(rust_test_matrix, separators=(",", ":")),
        linux_integration_matrix=json.dumps(linux_integration_matrix, separators=(",", ":")),
        container_full=str(container_full).lower(),
        core_matrix=json.dumps(
            {"include": CORE_LANES},
            separators=(",", ":"),
        ),
        host_matrix=json.dumps({"include": host}, separators=(",", ":")),
        plan_hash=plan["planHash"],
        input_hash=plan["source"]["inputHash"],
    )
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for name, value in outputs.items():
                print(f"{name}={value}", file=output)
    print(
        json.dumps(
            {
                "source": plan["source"],
                "required": [item["id"] for item in plan["items"]],
                "fallbackPaths": plan["fallbackPaths"],
            },
            ensure_ascii=False,
        )
    )
