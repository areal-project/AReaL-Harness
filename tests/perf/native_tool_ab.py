#!/usr/bin/env python3
"""在 macOS 原生 Harness 上比较工具改动；定向小样本不代表完整 benchmark。"""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import shlex
import shutil
import subprocess
import sys
import time
import tomllib
from collections import Counter
from result_view_report import usage_counter

ROOT = Path(__file__).resolve().parents[2]
CASES = (
    "pricing",
    "output-tail",
    "failure-context",
    "batch-edit",
    "search-groups",
    "repeat-log",
    "snapshot",
)
FACTORS = dict(
    zip(
        ("mm", "cm", "m", "km", "inch", "foot", "yard", "mile", "us", "ms", "minute", "hour"),
        (0.001, 0.01, 1, 1000, 0.0254, 0.3048, 0.9144, 1609.344, 0.000001, 0.001, 60, 3600),
    )
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fixtures(case, pytest):
    command = f"{shlex.quote(str(pytest))} -vv --tb=long --color=no -p no:cacheprovider"
    common = " Work only in this workspace. Do not delegate. Do not modify tests. Finish with a concise account of the change and checks."
    if case == "pricing":
        base = ROOT / "tests/perf/cases/python-fix-001"
        files = {
            str(p.relative_to(base / "workspace")): p.read_text()
            for p in (base / "workspace").rglob("*.py")
        }
        return files, (base / "prompt.md").read_text() + common
    if case == "search-groups":
        path = "configuration/deployment/region_north/service_inventory/production/settings.txt"
        lines = [f"setting_{i:03d} = inactive:default" for i in range(65)]
        lines[32] = "setting_032 = active:violet-cedar-731"
        return {path: "\n".join(lines) + "\n"}, (
            "Use search_files with pattern '^setting_' and limit 100 to inspect the configuration. "
            'Write answer.json containing only {"active": "<the active setting value after active:>"}. '
            "There is one active setting among the matches. Preserve the configuration." + common
        )
    if case == "repeat-log":
        return (
            {
                "scale.py": "def scale(value):\n    return value * 3\n",
                "test_scale.py": "from scale import scale\ndef test_scale():\n    for _ in range(110): print('unchanged dependency check: OK')\n    print('diagnostic: multiplier must be seven')\n    for _ in range(110): print('unchanged dependency check: OK')\n    assert scale(2) == 14\n",
            },
            f"First run `{shlex.quote(str(pytest))} -s -q --tb=short --color=no -p no:cacheprovider` unchanged without redirection, inspect the diagnostics, then fix scale.py and run the same test again."
            + common,
        )
    if case == "snapshot":
        return {}, (
            "Call mcp__inventory__snapshot exactly once to obtain the immutable inventory. Find the entry whose state is active. "
            'Write answer.json containing only {"active":"<that entry\'s value>"}. '
            "If the result is paged, use its advertised retrieval tool and cursors. Do not rerun the snapshot or inspect the tool implementation."
            + common
        )
    if case == "output-tail":
        files = {
            "ledger.py": "def balance(amounts, opening=0):\n    return sum(amounts) - opening\n"
        }
        tests = "import pytest\nfrom ledger import balance\n\n"
        tests += "@pytest.mark.parametrize('value', range(120), ids=lambda x: f'ordinary_account_balance_validation_with_zero_opening_{x:03d}')\ndef test_regular(value):\n    assert balance([value, -value]) == 0\n\n"
        tests += "def test_opening_balance():\n    assert balance([5, -2], opening=11) == 14\n"
        files["test_ledger.py"] = tests
        prompt = f"Fix ledger.balance to pass its suite without changing its public signature. First run `{command}` unchanged, drain its output through the final summary, then diagnose and fix the source. Run the same suite after the edit. Do not pipe, truncate or redirect this diagnostic run."
    elif case == "failure-context":
        files = {
            "events.py": "def normalize_event(row):\n    return {'label': row['label'], 'enabled': row['enabled'], 'tags': row['tags']}\n"
        }
        files["test_events.py"] = """import pytest
from events import normalize_event

@pytest.mark.parametrize('i', range(35))
def test_valid_rows(i):
    row = {'label': f'item-{i}', 'enabled': True, 'tags': ['alpha']}
    assert normalize_event(row) == row

def test_normalize():
    row = {'label': '  launch  ', 'enabled': 'false', 'tags': [' Beta ', 'alpha', 'BETA']}
    snapshot = {'label': '  launch  ', 'enabled': 'false', 'tags': [' Beta ', 'alpha', 'BETA']}
    assert normalize_event(row) == {'label': 'launch', 'enabled': False, 'tags': ['alpha', 'beta']}
    assert row == snapshot
"""
        prompt = f"Fix events.normalize_event. Labels are stripped, enabled accepts booleans or strings 'true'/'false', tags are trimmed, lowercase, deduplicated and sorted, and input must not be mutated. First run `{command}` unchanged and inspect the full failure before editing. Run it again after the fix. Do not pipe, truncate or redirect the diagnostic output."
    else:
        files = {
            "units.py": "\n\n".join(
                f"def convert_{name}(value):\n    return value * {factor + 0.5!r}"
                for name, factor in FACTORS.items()
            )
            + "\n"
        }
        files["test_units.py"] = (
            "import unittest\nimport units\n\nclass UnitsTests(unittest.TestCase):\n"
            + "".join(
                f"    def test_{name}(self):\n        self.assertAlmostEqual(units.convert_{name}(2), {2 * factor!r})\n"
                for name, factor in FACTORS.items()
            )
        )
        prompt = (
            "Correct each conversion multiplier in units.py using this specification: "
            + json.dumps(FACTORS)
            + ". Preserve all function signatures. Read the source first and use focused file-tool replacements; do not overwrite the whole file or edit via shell commands. Run `python3 -m unittest discover -v` afterwards."
        )
    return files, prompt + common


def grade(case, workspace, files):
    # 验收代码在 Agent 结束后从宿主执行，不作为题面或工作区文件提供。
    checks = {
        "pricing": "from pricing import total_price as f\nassert f([2,3],7)==12\nassert f([],3)==3\ntry: f([], -1)\nexcept ValueError: pass\nelse: raise AssertionError('negative shipping')",
        "output-tail": "from ledger import balance as f\nassert f([2,-3],5)==4\nassert f([],9)==9\nassert f([7],-4)==3",
        "failure-context": "from events import normalize_event as f\na={'label':' x ', 'enabled':'true','tags':[' Z','z','a']}\nb=f(a)\nassert b=={'label':'x','enabled':True,'tags':['a','z']}\nassert a=={'label':' x ', 'enabled':'true','tags':[' Z','z','a']}\nassert f({'label':'y','enabled':False,'tags':[]})['enabled'] is False",
        "batch-edit": "import units,math\n"
        + "\n".join(
            f"assert math.isclose(units.convert_{name}(3.7), {3.7 * factor!r}, rel_tol=1e-9)"
            for name, factor in FACTORS.items()
        ),
        "search-groups": "import json\nassert json.load(open('answer.json')) == {'active':'violet-cedar-731'}",
        "repeat-log": "from scale import scale\nassert scale(3)==21\nassert scale(-4)==-28",
        "snapshot": "import json\nassert json.load(open('answer.json')) == {'active':'quartz-river-846'}",
    }
    unchanged = all(
        (workspace / name).read_text() == content
        for name, content in files.items()
        if "test" in name or case == "search-groups"
    )
    r = subprocess.run(
        [sys.executable, "-c", checks[case]],
        cwd=workspace,
        capture_output=True,
        text=True,
        timeout=15,
    )
    return {
        "correct": unchanged and r.returncode == 0,
        "tests_unchanged": unchanged,
        "exit_code": r.returncode,
        "stderr": r.stderr[-2000:],
    }


def trial(args, label, binary, case, repeat):
    trial_id = f"{case}-{repeat}-{label}"
    target = args.output / trial_id
    target.mkdir()
    workspace = target / "workspace"
    workspace.mkdir()
    files, prompt = fixtures(case, args.pytest)
    for name, content in files.items():
        p = workspace / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    (target / "prompt.txt").write_text(prompt)
    selected = tomllib.loads(args.model_config.read_text())["model"]
    provider = selected.get("provider", "default")
    conf = "schema_version=1\n[model]\n"
    for key, value in selected.items():
        if key != "providers":
            conf += f"{key}={json.dumps(value)}\n"
    conf += f"[model.providers.{provider}]\n"
    conf += "".join(
        f"{key}={json.dumps(value)}\n" for key, value in selected["providers"][provider].items()
    )
    conf += "[limits]\nstream_idle_timeout_seconds=60\nmax_tool_calls=80\n"
    extensions = {}
    if label in args.view_modes:
        extensions["policy"] = {"resultViews": {"mode": args.view_modes[label]}}
    if case == "snapshot":
        # 数据源是部署侧工具夹具，不放入模型工作区；隐藏验收只检查结果文件。
        script = target / "inventory.py"
        shutil.copy2(ROOT / "tests/fixtures/inventory-mcp.py", script)
        extensions["mcpServers"] = {
            "inventory": {
                "transport": {"type": "stdio", "command": sys.executable, "args": [str(script)]}
            }
        }
    if extensions:
        tools_path = target / "tools.json"
        tools_path.write_text(json.dumps(extensions))
        conf += f"[tools]\nextensions_file={json.dumps(str(tools_path))}\n"
    (target / "config.toml").write_text(conf)
    env = os.environ.copy()
    for key in list(env):
        if key.lower().endswith("proxy") and key.lower() != "no_proxy" and args.direct:
            env.pop(key)
        if key.startswith("AREAL_"):
            env.pop(key)
    # 私有 home 只影响子进程，避免用户全局 skills/服务历史污染配对。
    env["HOME"] = str(target / "user")
    env["AREAL_HARNESS_HOME"] = str(target / "home")
    command = [
        sys.executable,
        str(binary / "launch.py"),
        "--bin-dir",
        str(binary),
        "--tui",
        "--workspace",
        str(workspace),
        "--data-dir",
        str(target / "data"),
        "--config",
        str(target / "config.toml"),
        "--no-deployment-mcp",
        "--prompt",
        prompt,
    ]
    if case == "snapshot":
        command.remove("--no-deployment-mcp")
        command.extend(
            ["--sandbox-profile", "native", "--allow-write", "--allow-concurrent-writes"]
        )
    start = time.monotonic()
    timed_out = False
    with (target / "stdout.log").open("w") as out, (target / "stderr.log").open("w") as err:
        process = subprocess.Popen(command, stdout=out, stderr=err, env=env)
        try:
            code = process.wait(timeout=args.timeout + 45)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.terminate()
            try:
                code = process.wait(timeout=35)
            except subprocess.TimeoutExpired:
                process.kill()
                code = process.wait()
    elapsed = time.monotonic() - start
    threads = [
        json.loads(p.read_text())["thread"]
        for p in (target / "data").glob("*.json")
        if "thread" in json.loads(p.read_text())
    ]
    turns = [turn for thread in threads for turn in thread["turns"]]
    tools = [item for turn in turns for item in turn["items"] if item["type"] == "dynamicToolCall"]
    audits = [json.loads(p.read_text()) for p in (target / "data/model-requests").glob("*.json")]
    outputs = [part.get("text", "") for item in tools for part in (item.get("contentItems") or [])]
    parsed = []
    for text in outputs:
        try:
            parsed.append(json.loads(text))
        except ValueError:
            pass
    usage = {
        key: sum(usage_counter(a, key) for a in audits)
        if audits and all(isinstance(usage_counter(a, key), int) for a in audits)
        else None
        for key in ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"]
    }
    result = dict(
        trial_id=trial_id,
        variant=label,
        case=case,
        repeat=repeat,
        elapsed_s=round(elapsed, 3),
        exit_code=code,
        timed_out=timed_out,
        completed=bool(turns) and all(t["status"] == "completed" for t in turns),
        grade=grade(case, workspace, files),
        usage=usage,
        observed_partial_usage={
            key: sum(
                usage_counter(a, key) for a in audits if isinstance(usage_counter(a, key), int)
            )
            for key in ("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens")
        },
        unknown_usage_requests=sum(not a.get("usageObserved") for a in audits),
        model_requests=len(audits),
        model_ms=sum(a.get("durationMs", 0) for a in audits),
        tool_calls=len(tools),
        tool_counts=dict(Counter(t["tool"] for t in tools)),
        tool_errors=sum(t.get("success") is False for t in tools),
        result_bytes=sum(len(t.encode()) for t in outputs),
        output_views=sum(bool(v.get("outputViewActive")) for v in parsed),
        request_bytes=sum(a.get("bodyBytes", 0) for a in audits),
        usage_complete=bool(audits)
        and all(a.get("usageObserved") and a.get("outcome") == "completed" for a in audits),
        fixture_sha256=digest(json.dumps(files, sort_keys=True).encode()),
        prompt_sha256=digest(prompt.encode()),
    )
    if case == "snapshot":
        result["grade"]["answer_correct"] = result["grade"]["correct"]
        protocol_correct = (
            result["tool_counts"].get("mcp__inventory__snapshot") == 1
            and result["tool_counts"].get("read_tool_result", 0) > 0
        )
        result["grade"]["retrieval_protocol_correct"] = protocol_correct
        result["grade"]["correct"] &= protocol_correct
    (target / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--variant",
        action="append",
        required=True,
        help="NAME=directory containing areal, Runtime binaries, tools and launch.py (legacy four-binary bundles also supported)",
    )
    parser.add_argument("--model-config", type=Path, required=True)
    parser.add_argument("--pytest", type=Path, default=Path(shutil.which("pytest") or "pytest"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--seed", type=int, default=163)
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--direct", action="store_true")
    parser.add_argument("--case", action="append", choices=CASES, dest="cases")
    parser.add_argument(
        "--view-mode",
        action="append",
        default=[],
        help="NAME=off|observe|on; omitted variants keep their own default",
    )
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    variants = {k: Path(v).resolve() for k, v in (s.split("=", 1) for s in args.variant)}
    args.view_modes = dict(s.split("=", 1) for s in args.view_mode)
    if any(
        k not in variants or v not in {"off", "observe", "on"} for k, v in args.view_modes.items()
    ):
        parser.error("view-mode requires a configured variant and off|observe|on")
    cases = args.cases or list(CASES)
    pairs = [(case, repeat) for case in cases for repeat in range(args.repeat)]
    rng = random.Random(args.seed)
    rng.shuffle(pairs)
    plan = []
    for case, repeat in pairs:
        labels = list(variants)
        rng.shuffle(labels)
        plan.extend((label, str(variants[label]), case, repeat) for label in labels)
    selected_model = tomllib.loads(args.model_config.read_text())["model"]
    # 只记录白名单参数；不能把 endpoint、密钥或任意 provider 扩展写入报告。
    model_settings = {
        key: selected_model[key]
        for key in (
            "name",
            "provider",
            "temperature",
            "top_p",
            "max_output_tokens",
            "reasoning_effort",
        )
        if key in selected_model
    }
    model_settings["protocol"] = selected_model["providers"][selected_model["provider"]]["protocol"]
    metadata = {
        "suite": "native-tool-mechanism-probes-v2",
        "view_modes": args.view_modes,
        "seed": args.seed,
        "repeat": args.repeat,
        "jobs": args.jobs,
        "timeout": args.timeout,
        "direct": args.direct,
        "model": tomllib.loads(args.model_config.read_text())["model"]["name"],
        "model_settings": model_settings,
        "model_settings_sha256": digest(json.dumps(model_settings, sort_keys=True).encode()),
        "runner_sha256": digest(Path(__file__).read_bytes()),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "pytest": subprocess.check_output([str(args.pytest), "--version"], text=True).strip(),
        "schedule": plan,
        "binaries": {
            label: {
                name: digest((binary / name).read_bytes())
                for name in [
                    "areal",
                    "areal-server",
                    "areal-tui",
                    "areal-runtime",
                    "areal-runtime-fs",
                    "areal-runtime-reaper",
                    "launch.py",
                ]
                if (binary / name).is_file()
            }
            for label, binary in variants.items()
        },
        "fixtures": {
            case: digest(json.dumps(fixtures(case, args.pytest)[0], sort_keys=True).encode())
            for case in cases
        },
        "mcp_fixture_sha256": digest((ROOT / "tests/fixtures/inventory-mcp.py").read_bytes()),
    }
    (args.output / "plan.json").write_text(json.dumps(metadata, indent=2) + "\n")
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {
            pool.submit(trial, args, label, Path(binary), case, repeat): (label, case, repeat)
            for label, binary, case, repeat in plan
        }
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                label, case, repeat = futures[future]
                results.append(
                    {
                        "variant": label,
                        "case": case,
                        "repeat": repeat,
                        "infrastructure_error": repr(e),
                    }
                )
            (args.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
