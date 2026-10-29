#!/usr/bin/env python3
"""隔离夹具准备与进程观测，保留所有样本、失败和构建身份。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

REPO = Path(__file__).resolve().parent.parent
MODES = ["memory", "sqlite", "memory-lazy", "sqlite-lazy"]
CASES = {
    "small": dict(count=100, body=16384, metadata=0, case="ordinary"),
    "many": dict(count=20000, body=0, metadata=0, case="ordinary"),
    "history": dict(count=2000, body=65536, metadata=0, case="ordinary"),
    "heavy": dict(count=200, body=524288, metadata=0, case="ordinary"),
    "metadata": dict(count=2000, body=1024, metadata=4096, case="ordinary"),
    "archiveGap": dict(count=2000, body=0, metadata=0, case="archiveGap"),
    "cli": dict(count=2000, body=1024, metadata=0, case="cli"),
    "mixed": dict(count=1000, body=16384, metadata=0, case="mixed"),
    "holdout": dict(count=1200, body=8192, metadata=8192, case="mixed"),
    "confirmation": dict(count=1500, body=12288, metadata=6144, case="mixed"),
}
parser = argparse.ArgumentParser(
    description="macOS 上独立子进程比较四种会话目录与历史加载模式。先单独构建 release app-server --lib。"
)
parser.add_argument("executable", type=Path)
parser.add_argument("--output", type=Path, default=REPO / "target" / "catalog-loading-comparison")
parser.add_argument("--phase", default="matrix")
parser.add_argument("--cases", default="small,many,history,heavy,metadata,archiveGap,cli,mixed")
parser.add_argument("--rounds", type=int, default=5)
parser.add_argument("--all-open", action="store_true")
parser.add_argument("--execution", action="store_true")
args = parser.parse_args()
if os.uname().sysname != "Darwin":
    parser.error("该测量入口目前仅验证 macOS 的 time -l / ps RSS 口径。")
if not 1 <= args.rounds <= 100:
    parser.error("--rounds must be between 1 and 100")
if any(name not in CASES for name in args.cases.split(",")):
    parser.error("unknown case name")
OUT = args.output.resolve() / args.phase
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.mkdir()
EXE = OUT / "candidate-tests"
shutil.copy2(args.executable.resolve(), EXE)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


identity = {
    "executableSha256": sha(EXE),
    "sourceSha256": {
        str(p.relative_to(REPO)): sha(p)
        for folder in [
            "core/engine/src",
            "core/config/src",
            "core/protocol/src",
            "core/app-server/src",
            "core/server/src",
        ]
        for p in (REPO / folder).rglob("*.rs")
    },
    "cargoLockSha256": sha(REPO / "Cargo.lock"),
    "cases": {name: CASES[name] for name in args.cases.split(",")},
    "rounds": args.rounds,
    "modes": MODES,
    "policy": "sequential processes; same final exe; OS cache not evicted; fixture preparation outside measured process; cold metadata cache rebuild, reusable cache, and single-fact change separately measured; rotating mode order",
}
(OUT / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
records = []


def run(name, mode, root, operation, round_, label):
    cfg = CASES[name]
    env = dict(os.environ)
    env.pop("AREAL_TEST_SESSION_CATALOG", None)
    env.update(
        AREAL_CATALOG_TEST_BACKEND=mode,
        AREAL_LAZY_PERF_ROOT=str(root),
        AREAL_LAZY_PERF_OPERATION=operation,
        AREAL_LAZY_PERF_CASE=cfg["case"],
        AREAL_LAZY_PERF_COUNT=str(cfg["count"]),
        AREAL_LAZY_PERF_BODY=str(cfg["body"]),
        AREAL_LAZY_PERF_METADATA=str(cfg["metadata"]),
    )
    cmd = [
        "/usr/bin/time",
        "-l",
        "/usr/bin/python3",
        "-I",
        "-S",
        "-c",
        "import subprocess,sys;sys.exit(subprocess.call(sys.argv[1:]))",
        str(EXE),
        "catalog_lazy_tests::lazy_catalog_process_comparison",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]
    path = OUT / f"{name}-{mode}-{round_}-{label}.log"
    start = time.monotonic()
    with path.open("w") as stream:
        try:
            code = subprocess.run(
                cmd, cwd=REPO, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=600
            ).returncode
        except subprocess.TimeoutExpired:
            code = "timeout"
    raw = path.read_text()
    observations = [
        json.loads(line.split("LAZY_CATALOG_PERF ", 1)[1])
        for line in raw.splitlines()
        if "LAZY_CATALOG_PERF " in line
    ]
    peak = re.search(r"(\d+)\s+maximum resident set size", raw)
    record = dict(
        case=name,
        mode=mode,
        round=round_,
        phase=label,
        operation=operation,
        exitCode=code,
        elapsedSeconds=time.monotonic() - start,
        peakResidentBytes=int(peak.group(1)) if peak else None,
        cacheBytes=sum(p.stat().st_size for p in (root / "catalog").rglob("*") if p.is_file())
        if (root / "catalog").exists()
        else 0,
        log=str(path.relative_to(REPO)),
        measurements=observations,
    )
    records.append(record)
    (OUT / "raw.json").write_text(
        json.dumps(dict(identity=identity, attempts=records), ensure_ascii=False, indent=2) + "\n"
    )
    print(
        json.dumps({k: v for k, v in record.items() if k != "measurements"})
        + f" observations={len(observations)}",
        flush=True,
    )
    if code != 0 or not observations:
        raise RuntimeError(raw[-10000:])
    return record


def facts(root):
    return {p.name: sha(p) for p in root.glob("*.json")}


def clone_facts(seed, root):
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(seed, root)


for name in args.cases.split(","):
    seed = OUT / f"fixture-{name}"
    if seed.exists():
        raise RuntimeError(f"fixture already exists: {seed}; use a new phase name")
    seed.mkdir()
    run(name, "memory", seed, "prepare", 0, "prepare")
    expected = facts(seed)
    roots = {}
    for mode in MODES:
        root = OUT / f"fixture-{name}-{mode}"
        clone_facts(seed, root)
        roots[mode] = root
    for round_ in range(1, args.rounds + 1):
        shift = (round_ - 1) % 4
        order = MODES[shift:] + MODES[:shift]
        if round_ % 2 == 0:
            order.reverse()
        for mode in order:
            root = roots[mode]
            if (root / "catalog").exists():
                shutil.rmtree(root / "catalog")
            run(name, mode, root, "startup", round_, "build")
            run(
                name,
                mode,
                root,
                "all"
                if args.all_open and name in ["history", "heavy", "holdout", "confirmation"]
                else "directory",
                round_,
                "reuse",
            )
            if facts(root) != expected:
                raise RuntimeError(f"pure read changed facts: {name} {mode}")
            fact = root / "00000000-0000-0000-0000-000000000001.json"
            before = fact.read_bytes()
            after = before.replace(b'"name":"Session 1"', b'"name":"Session 9"', 1)
            assert before != after and len(before) == len(after)
            fact.write_bytes(after)
            run(name, mode, root, "startup", round_, "incremental")
            assert fact.read_bytes() == after
            fact.write_bytes(before)
            if args.execution and name in [
                "small",
                "history",
                "heavy",
                "mixed",
                "holdout",
                "confirmation",
            ]:
                execution_root = OUT / f"execute-{name}-{mode}"
                clone_facts(seed, execution_root)
                run(name, mode, execution_root, "startup", round_, "execution-cache")
                run(name, mode, execution_root, "execution", round_, "execution")
                shutil.rmtree(execution_root)
    (OUT / f"facts-{name}.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(f"COMPLETE case={name}", flush=True)
print("COMPLETE matrix", flush=True)
