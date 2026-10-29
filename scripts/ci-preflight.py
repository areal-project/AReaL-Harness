"""执行共享验收计划；独立失败一次收齐，依赖与能力不足明确阻塞。"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ci_scope", ROOT / "scripts/ci-scope.py")
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


def write_report(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def progress(plan, report):
    states = {
        name: []
        for name in (
            "passed",
            "failed",
            "blocked",
            "pending",
            "running",
            "invalidated",
            "cancelled",
        )
    }
    results = {result["id"]: result for result in report["results"]}
    required = {item["id"] for item in plan["items"]}
    if len(results) != len(report["results"]) or set(results) - required:
        raise ValueError("Progress report has duplicate or unknown checks")
    for item in plan["items"]:
        name = item["id"]
        status = (
            results[name]["status"]
            if name in results
            else "running"
            if report.get("activeItem") == name
            else "pending"
        )
        if status == "passed" and report["status"] == "invalidated":
            status = "invalidated"
        if status not in states:
            raise ValueError(f"Unknown check status: {status}")
        states[status].append(name)
    return {
        "status": next(
            (
                name
                for name in ("failed", "invalidated", "blocked", "cancelled", "running", "pending")
                if states[name] or report["status"] == name
            ),
            "passed" if required else "not-applicable",
        ),
        "total": len(required),
        "counts": {name: len(items) for name, items in states.items()},
        **states,
        "pendingFull": report["pendingRequired"],
        "remoteRequired": report["remoteRequired"],
    }


def publish_progress(plan, report, output):
    report["progress"] = progress(plan, report)
    write_report(output / "report.json", report)
    summary = {
        key: value
        for key, value in report["progress"].items()
        if key not in {"passed", "pending", "pendingFull", "remoteRequired"}
    }
    print(
        json.dumps({"report": str(output / "report.json"), "progress": summary}),
        flush=True,
    )


def matching_core(root=ROOT):
    built = root / "target/debug/areal"
    core = Path(os.environ.get("AREAL_CORE_BIN") or built)
    if not core.is_file() or not os.access(core, os.X_OK):
        raise ValueError("AREAL_CORE_BIN must name the matching executable")
    if core != built and digest(core) != digest(built):
        raise ValueError("AREAL_CORE_BIN SHA-256 differs from the fresh build")
    return core


def environment(item, root):
    env = dict(os.environ)
    relay = env.get("AREAL_RELAY_NODE_BIN") or env.get("AREAL_RELAY_NODE")
    if relay:
        env["AREAL_RELAY_NODE"] = str(Path(relay).resolve())
    if "node-24.2.0" in item["requires"] and relay:
        env["PATH"] = str(Path(relay).resolve().parent) + os.pathsep + env.get("PATH", "")
    env["AREAL_TEST_BIN_DIR"] = str(root / "target/debug")
    env["AREAL_DESIGN_BASE"] = item.get("baseRevision", "")
    env["AREAL_VERIFICATION_SOURCE_REVISION"] = item.get("sourceRevision", "")
    env["AREAL_VERIFICATION_INPUT_HASH"] = item.get("inputHash", "")
    if item["group"] == "verify":
        env.setdefault("CARGO_TEST_ARGS", "--exclude areal-runtime-exec-native")
    if item["group"] in ("core-contracts", "smoke"):
        env["AREAL_CORE_BIN"] = str(matching_core(root))
    if item["id"] == "gui-portable":
        env.pop("AREAL_CORE_BIN", None)
    return env


def capabilities(root, env):
    found = {
        name
        for name in ("git", "openssl", "cargo-audit")
        if shutil.which(name, path=env.get("PATH"))
    }

    def succeeds(command):
        try:
            return (
                subprocess.run(
                    command, cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                ).returncode
                == 0
            )
        except OSError:
            return False

    relay = env.get("AREAL_RELAY_NODE")
    if relay and succeeds(
        [relay, "-e", "process.exit(process.versions.node === '24.2.0' ? 0 : 1)"]
    ):
        found.add("relay-node-24.2.0")
    for browser in ("chromium", "webkit"):
        if succeeds(
            [
                "node",
                "-e",
                "const fs=require('node:fs'); const pw=require('./clients/gui/app/node_modules/playwright-core'); fs.accessSync(pw[process.argv[1]].executablePath(), fs.constants.X_OK)",
                browser,
            ]
        ):
            found.add("playwright-" + browser)

    if succeeds(
        [
            "python3",
            "-c",
            "import sys, inspect, tarfile, tomllib; assert sys.version_info >= (3, 11); assert 'filter' in inspect.signature(tarfile.TarFile.extractall).parameters",
        ]
    ):
        found.add("python3")
    try:
        node = (
            subprocess.check_output(["node", "--version"], cwd=root, env=env, text=True)
            .strip()
            .removeprefix("v")
        )
        found.add("node-" + node)
    except (OSError, subprocess.CalledProcessError):
        pass
    if sys.platform == "darwin" and succeeds(
        ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]
    ):
        found.add("native-runtime")
    if sys.platform == "linux" and succeeds(
        [
            "/usr/bin/bwrap",
            "--unshare-all",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--",
            "/usr/bin/true",
        ]
    ):
        found.add("native-runtime")
    for image, requirement in (
        ("areal-ci:runtime-tests", "container-runtime"),
        ("areal-ci:runtime", "container-profile"),
    ):
        try:
            info = json.loads(
                subprocess.check_output(
                    ["docker", "image", "inspect", image],
                    cwd=root,
                    env=env,
                    stderr=subprocess.DEVNULL,
                )
            )[0]
            labels = info.get("Config", {}).get("Labels") or {}
            if labels.get("org.opencontainers.image.revision") == env.get(
                "AREAL_VERIFICATION_SOURCE_REVISION"
            ) and labels.get("io.areal.verification-input") == env.get(
                "AREAL_VERIFICATION_INPUT_HASH"
            ):
                found.add(requirement)
        except (OSError, subprocess.CalledProcessError, ValueError, IndexError, KeyError):
            pass
    if sys.platform == "darwin" and all(
        shutil.which(name, path=env.get("PATH")) for name in ("codesign", "hdiutil")
    ):
        found.add("macos-tools")
    if sys.platform == "darwin" and succeeds(["xcrun", "--find", "swiftc"]):
        found.add("xcode")
    if (root / "clients/gui/renderer/dist/index.html").is_file():
        found.add("gui-build")
    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if chrome.is_file() or shutil.which("google-chrome", path=env.get("PATH")):
        found.add("browser")
    electron = root / "clients/gui/app/node_modules/electron"
    if electron.is_dir():
        found.add("electron")
    return found


def artifacts(item, root):
    files = []
    # Cargo 测试会重写可变构建目录；只有发布给其他 job 的 GUI bundle 在此冻结。
    if item["id"] == "gui-core-build":
        files = [
            root / "target/debug" / name
            for name in ("areal", "areal-runtime", "areal-runtime-fs", "areal-runtime-reaper")
        ]
    if item["id"].endswith(":renderer"):
        directory = root / "clients/gui/renderer/dist"
        files = [
            *sorted(directory.glob("*.html")),
            directory / "bundle-analysis.json",
            *sorted((directory / "assets").glob("*.js")),
            *sorted((directory / "assets").glob("*.css")),
        ]
    if item["id"] == "computer-helper":
        directory = root / "clients/gui/native/computer-helper/build/AReaL Computer Helper.app"
        files = [path for path in sorted(directory.rglob("*")) if path.is_file()]
        if not files:
            raise ValueError("computer helper build did not produce its signed app")
    return {str(path.relative_to(root)): digest(path) for path in files}


def run_plan(
    plan,
    root,
    selected,
    output,
    runner=subprocess.run,
    capability_probe=capabilities,
    input_probe=None,
    dependencies=(),
    platform=None,
    metadata=None,
):
    if (output / "report.json").exists():
        raise ValueError("refusing to overwrite an existing verification attempt")
    platform = platform or sys.platform
    input_probe = input_probe or (lambda: scope.input_key(root, plan["source"]["baseRevision"]))
    identity = {
        "planHash": plan["planHash"],
        **plan["source"],
        "ciRunId": os.environ.get("GITHUB_RUN_ID"),
        "ciAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    }
    previous = {}
    for report in dependencies:
        if report.get("status") in {"running", "invalidated", "cancelled"}:
            raise ValueError("dependency report is unfinished or invalidated")
        if report.get("identity") != identity:
            raise ValueError("dependency report has a different source, plan, run or attempt")
        for result in report["results"]:
            if result["id"] in previous:
                raise ValueError("duplicate dependency result " + result["id"])
            previous[result["id"]] = result
    results = []
    report = {
        "schemaVersion": 1,
        "kind": "verification-report",
        "identity": identity,
        "platform": platform,
        "status": "running",
        "results": results,
        "remoteRequired": [item["id"] for item in selected if platform not in item["platforms"]],
        "pendingRequired": sorted(
            {item["id"] for item in plan["items"]} - {item["id"] for item in selected}
        ),
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    started = time.monotonic()
    if metadata is not None:
        write_report(
            output / "metadata.json",
            {"source": plan["source"], "planHash": plan["planHash"], "fingerprint": metadata},
        )
    write_report(output / "plan.json", plan)
    publish_progress(plan, report, output)
    for item in selected:
        if platform not in item["platforms"]:
            continue
        began = time.monotonic()
        result = {
            "id": item["id"],
            "status": "blocked",
            "exitCode": None,
            "command": item["command"],
            "startedAt": datetime.now(timezone.utc).isoformat(),
        }
        try:
            if input_probe() != identity["inputHash"]:
                result.update(status="invalidated", reason="source/index/worktree inputs changed")
            else:
                missing = [
                    name
                    for name in item["dependsOn"]
                    if previous.get(name, {}).get("status") != "passed"
                ]
                stale = [
                    name
                    for name in item["dependsOn"]
                    if any(
                        not (root / path).is_file() or digest(root / path) != value
                        for path, value in previous.get(name, {}).get("artifacts", {}).items()
                    )
                ]
                if missing or stale:
                    result.update(blockedBy=missing, staleArtifacts=stale)
                else:
                    env = environment({**item, **plan["source"]}, root)
                    absent = (
                        sorted(set(item["requires"]) - capability_probe(root, env))
                        if item["requires"]
                        else []
                    )
                    if absent:
                        result.update(
                            missingRequirements=absent,
                            requirementHints={
                                name: scope.REQUIREMENT_HINTS.get(name, name) for name in absent
                            },
                        )
                    else:
                        command = [
                            argument.replace("{root}", str(root)) for argument in item["command"]
                        ]
                        if item["id"] == "container-unified":
                            (root / "target/ci/unified").mkdir(parents=True, exist_ok=True)
                        child = output / "children" / (item["id"].replace(":", "_") + ".json")
                        if "expectedTests" in item:
                            child.parent.mkdir(parents=True, exist_ok=True)
                            env["AREAL_PORTABLE_TEST_REPORT"] = str(child)
                            command += [
                                "--plan=" + str(output / "plan.json"),
                                "--item=" + item["id"],
                            ]
                        print(json.dumps({"check": item["id"], "command": command}), flush=True)
                        report["activeItem"] = item["id"]
                        publish_progress(plan, report, output)
                        completed = runner(command, cwd=root, env=env)
                        result.update(
                            status="passed" if completed.returncode == 0 else "failed",
                            exitCode=completed.returncode,
                        )
                        if "expectedTests" in item:
                            detail = json.loads(child.read_text())
                            if (
                                detail.get("planHash") != plan["planHash"]
                                or detail.get("itemId") != item["id"]
                                or detail.get("sourceRevision") != identity["sourceRevision"]
                                or detail.get("ciRunId") != identity["ciRunId"]
                                or detail.get("ciAttempt") != identity["ciAttempt"]
                            ):
                                raise ValueError(
                                    "runner report identity differs from its current plan/run"
                                )
                            tests = detail["results"]
                            expected = item["expectedTests"][platform]
                            if (
                                detail.get("status") != "passed"
                                or detail.get("passed") is not True
                                or len(tests) != len(expected)
                                or {test["script"] for test in tests} != set(expected)
                                or not all(
                                    test.get("passed") and test.get("status") == "passed"
                                    for test in tests
                                )
                            ):
                                result.update(
                                    status="failed",
                                    reason="runner results do not cover the required test set",
                                )
                            result["tests"] = tests
                        if result["status"] == "passed":
                            result["artifacts"] = artifacts(item, root)
            if input_probe() != identity["inputHash"]:
                result.update(status="invalidated", reason="source/index/worktree inputs changed")
        except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
            result.update(status="failed", reason=str(error))
        result["elapsedMs"] = round((time.monotonic() - began) * 1000)
        result["completedAt"] = datetime.now(timezone.utc).isoformat()
        if result["status"] != "passed" and "firstFailureAt" not in report:
            report["firstFailureAt"] = result["completedAt"]
        previous[item["id"]] = result
        results.append(result)
        report.pop("activeItem", None)
        print(json.dumps(result), flush=True)
        report["elapsedMs"] = round((time.monotonic() - started) * 1000)
        publish_progress(plan, report, output)
    invalidated = input_probe() != identity["inputHash"]
    report.update(
        status="invalidated"
        if invalidated
        else "blocked"
        if plan.get("selectionFallback")
        else "not-applicable"
        if not results
        else "passed"
        if all(result["status"] == "passed" for result in results)
        else "failed",
        overallStatus="pending-full"
        if report["pendingRequired"]
        else "pending-remote"
        if report["remoteRequired"]
        else "local-only",
        completedAt=datetime.now(timezone.utc).isoformat(),
        elapsedMs=round((time.monotonic() - started) * 1000),
    )
    publish_progress(plan, report, output)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    started = time.monotonic()
    began_at = datetime.now(timezone.utc).isoformat()
    parser.add_argument("--base")
    parser.add_argument("--groups")
    parser.add_argument("--item")
    parser.add_argument("--phase", choices=("commit", "full"), default="full")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--with-dependencies", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dependencies", type=Path, action="append", default=[])
    parser.add_argument(
        "--report", type=Path, help="Read progress from an existing report and its adjacent plan"
    )
    args = parser.parse_args()
    if args.report:
        report = json.loads(args.report.read_text())
        plan = json.loads(args.report.with_name("plan.json").read_text())
        if report["identity"]["planHash"] != plan["planHash"] or any(
            report["identity"].get(key) != value for key, value in plan["source"].items()
        ):
            raise ValueError("Progress report does not match its plan")
        print(json.dumps({"report": str(args.report), "progress": progress(plan, report)}))
        return 0
    if not args.base and not os.environ.get("GITHUB_EVENT_PATH"):
        parser.error("--base is required outside CI")
    plan = scope.repository_plan(ROOT, args.base)
    selected = [
        item
        for item in plan["items"]
        if (not args.groups or item["group"] in args.groups.split(","))
        and (not args.item or item["id"] == args.item)
        and (args.phase != "commit" or item["phase"] == "commit")
    ]
    if args.groups and not set(args.groups.split(",")) <= set().union(
        *scope.WORKFLOW_GROUPS.values()
    ):
        raise ValueError("unknown verification group")
    if args.with_dependencies:
        names = {item["id"] for item in selected}
        while True:
            expanded = names | {
                dependency
                for item in plan["items"]
                if item["id"] in names
                for dependency in item["dependsOn"]
            }
            if expanded == names:
                break
            names = expanded
        selected = [item for item in plan["items"] if item["id"] in names]
    if args.item and not selected:
        raise ValueError("requested check is absent from the required plan")
    if args.plan:
        print(
            json.dumps(
                {**plan, "selected": [item["id"] for item in selected]},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    output = (args.output or ROOT / "target/ci/preflight" / uuid.uuid4().hex).resolve()
    if args.dependencies and not os.environ.get("GITHUB_RUN_ID"):
        raise ValueError(
            "dependency reports are only accepted within the current CI workflow/attempt"
        )
    dependencies = [json.loads(path.read_text()) for path in args.dependencies]
    fingerprint = json.loads(
        subprocess.check_output([sys.executable, "scripts/ci-fingerprint.py"], cwd=ROOT)
    )
    report = run_plan(plan, ROOT, selected, output, dependencies=dependencies, metadata=fingerprint)
    report["startedAt"] = began_at
    fresh = scope.input_key(ROOT, plan["source"]["baseRevision"]) == plan["source"]["inputHash"]
    ready = fresh and all(
        any(result["id"] == name and result["status"] == "passed" for result in report["results"])
        for name in ("macos:renderer", "gui-core-build", "gui-design-build", "computer-helper")
    )
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            print("artifact_ready=" + str(ready).lower(), file=stream)
    if not fresh:
        report["status"] = "invalidated"
        report["reason"] = "inputs changed before finalization"
    report["totalElapsedMs"] = round((time.monotonic() - started) * 1000)
    publish_progress(plan, report, output)
    print(
        json.dumps(
            {
                "report": str(output / "report.json"),
                "status": report["status"],
                "remoteRequired": report["remoteRequired"],
            }
        ),
        flush=True,
    )
    return 0 if report["status"] in {"passed", "not-applicable"} else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
