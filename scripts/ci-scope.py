"""每个 PR 运行稳定门禁；只对适用路径执行昂贵矩阵。"""

import fnmatch
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SCOPES = {
    "gui": [
        "design/**",
        "services/remote-relay/**",
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
        "relay-build",
        "relay",
        "gui-build",
        "core-contracts",
        "smoke",
        "mobile",
    },
    "verify": {"early", "verify", "native", "container", "audit"},
}
JOB_GROUPS = {
    "gui": {
        "scope": None,
        "gui-health": {"gui-health"},
        "gui-portable": {"gui-portable"},
        "relay-contracts": {"relay-build", "relay"},
        "gui": {"gui-build"},
        "core-contracts": {"core-contracts"},
        "smoke": {"smoke"},
        "mobile": {"mobile"},
    },
    "verify": {
        "plan": None,
        "host": {"early", "verify", "native"},
        "container": {"container"},
        "dependencies": {"audit"},
    },
}
CI_PLATFORMS = {
    group: ("darwin" if group in {"native", "gui-build", "core-contracts", "smoke"} else "linux")
    for group in set().union(*WORKFLOW_GROUPS.values())
}


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
        if not (path.endswith(".md") or path.startswith("docs/"))
        or path.startswith("clients/gui/packages/ui/")
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
                "scripts/",
                ".github/",
                ".githooks/",
                "clients/web/",
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
    return {"shared": shared, "gui": gui, "relay": gui, "unknown": unknown, "code": code}


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
        base or pr.get("base", {}).get("sha") or event.get("inputs", {}).get("comparison_base")
    )
    revision = git(root, "rev-parse", "HEAD").decode().strip()
    fallback = False
    try:
        comparison = git(root, "merge-base", comparison or "HEAD", "HEAD").decode().strip()
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
            "plan-contracts",
            [
                "python3",
                "-m",
                "unittest",
                "scripts.tests.test_ci_contracts",
                "scripts.tests.test_check_changed",
                "scripts.tests.test_git_hooks",
            ],
            "early",
            phase="commit",
        )
        add("docs", ["python3", "scripts/check-docs.py"], "early", phase="commit")
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
    if affected["gui"]:
        add(
            "gui-health",
            ["make", "ci-gui-health", "CI_BASE=" + source["baseRevision"]],
            "gui-health",
            phase="commit",
        )
        add(
            "manifest",
            ["node", "--test", "clients/gui/scripts/test-manifest.test.mjs"],
            "gui-portable",
            phase="commit",
        )
        desktop, ui, renderer = gui_builds("portable:", "gui-portable", phase="commit")
        for name, command in (
            ("gui-check", "check"),
            ("gui-design-contracts", "verify:design"),
            ("gui-types", "typecheck"),
            ("gui-public", "verify"),
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
        mobile = next(entry for entry in manifest if entry["script"] == "test:mobile-browser")
        add(
            "mobile-types",
            ["pnpm", "--dir", "clients/gui", "mobile:typecheck"],
            "mobile",
            requires=("node-24.22.1",),
            phase="commit",
            platforms=tuple(mobile["platforms"]),
        )
        add(
            "mobile-relay-install",
            ["npm", "ci", "--ignore-scripts", "--prefix", "services/remote-relay"],
            "mobile",
            requires=("node-24.2.0",),
            platforms=tuple(mobile["platforms"]),
        )
        add(
            "mobile-browser",
            ["pnpm", "--dir", "clients/gui", mobile["script"]],
            "mobile",
            ("mobile-relay-install",),
            tuple(mobile["requires"]),
            platforms=tuple(mobile["platforms"]),
        )
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
        for name, target in (
            ("rust-types", "check"),
            ("rust-lint", "lint"),
            ("sdk", "sdk-test"),
            ("scripts", "script-test"),
            ("cordis", "cordis-pin"),
        ):
            add(
                name,
                ["make", target],
                "verify",
                phase="commit" if name in {"rust-types", "rust-lint"} else "full",
            )
        add("verify-core-build", ["make", "build"], "verify")
        for name, target in (
            ("rust-behavior", "test"),
            ("launcher", "launcher-test"),
            ("core-smoke", "smoke"),
        ):
            add(name, ["make", target], "verify", ("verify-core-build",))
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
                "native-integration",
                [
                    "make",
                    "-k",
                    "-j4",
                    "launcher-test",
                    "runtime-smoke",
                    "harness-smoke",
                    "examples-desktop-api",
                    "workgroup-smoke",
                ],
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
        add(
            "computer-helper",
            ["node", "clients/gui/scripts/build-computer-helper.mjs"],
            "gui-build",
            requires=("node-24.22.1", "macos-tools", "xcode"),
            platforms=("darwin",),
        )
        for entry in manifest:
            if (
                entry["layer"] != "e2e"
                and "macos-tools" in entry["requires"]
                and "core-binary" not in entry["requires"]
            ):
                add(
                    "native-contract:" + entry["script"],
                    ["pnpm", "--dir", "clients/gui", "run", entry["script"]],
                    "gui-build",
                    (desktop, renderer),
                    tuple(sorted(set(entry["requires"]) - {"gui-build"})),
                    platforms=("darwin",),
                )
        add("gui-core-build", ["make", "build"], "gui-build", platforms=("darwin",))
        add(
            "gui-design-build",
            ["pnpm", "--dir", "clients/gui", "design:build"],
            "gui-build",
            (desktop, ui),
            platforms=("darwin",),
        )
        for name, command in (
            (
                "rpc-routes",
                [
                    "cargo",
                    "test",
                    "--locked",
                    "-p",
                    "areal-app-server",
                    "--lib",
                    "desktop_registered_methods_have_dispatch_routes",
                ],
            ),
            ("macos-process", ["pnpm", "--dir", "clients/gui", "test:core-process"]),
            ("macos-browser", ["pnpm", "--dir", "clients/gui", "test:browser-contracts"]),
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
                "gui-build",
                ("gui-design-build", "gui-core-build", renderer),
                platforms=("darwin",),
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
        add(
            "core-contracts",
            ["node", "clients/gui/scripts/run-portable-tests.mjs", "--core-contracts"],
            "core-contracts",
            ("gui-core-build", renderer),
            ("node-24.22.1", "native-runtime"),
            platforms=("darwin",),
            expected=core_tests,
        )
        for entry in manifest:
            if entry.get("ciSmoke"):
                add(
                    "smoke:" + entry["script"],
                    ["pnpm", "--dir", "clients/gui", "run", entry["script"]],
                    "smoke",
                    ("gui-core-build", renderer, "gui-design-build"),
                    tuple(sorted(set(entry["requires"]) - {"core-binary", "gui-build"}))
                    + ("node-24.22.1",),
                    platforms=("darwin",),
                )
    production_tasks = {
        "macos:desktop": "desktop-build",
        "macos:ui": "ui-build",
        "macos:renderer": "build-suite",
        "computer-helper": "computer-helper-build",
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
        "items": items,
    }
    plan["planHash"] = hashlib.sha256(
        json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return plan


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
    matrix = {
        "include": [
            {"scenario": entry["ciSmoke"], "script": entry["script"]}
            for entry in manifest
            if entry.get("ciSmoke")
        ]
    }
    host = [
        {
            "os": "ubuntu-24.04",
            "name": "Linux portable checks",
            "target": "early,verify",
            "setup": "setup",
            "log": "verify",
        }
    ]
    if "native" in groups:
        host.append(
            {
                "os": "macos-15",
                "name": "macOS native Harness",
                "target": "native",
                "setup": "setup-node",
                "log": "verify-native",
            }
        )
    outputs = {
        name.replace("-", "_"): str(name in groups).lower()
        for name in set().union(*WORKFLOW_GROUPS.values())
    }
    outputs.update(
        gui=str(bool(groups & WORKFLOW_GROUPS["gui"])).lower(),
        release=str(applicable("release", plan["paths"])).lower(),
        smoke_matrix=json.dumps(matrix, separators=(",", ":")),
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
