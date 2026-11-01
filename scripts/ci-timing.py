"""保存 gh 原始运行数据，保守拆分排队、准备、验收和上传清理。"""

import argparse
from collections import defaultdict
import csv
from datetime import datetime
import json
from pathlib import Path
import re
import statistics
import subprocess


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def seconds(start, end):
    return max(0.0, (instant(end) - instant(start)).total_seconds()) if start and end else None


def collect(repository, limit):
    def api(endpoint):
        return json.loads(subprocess.check_output(["gh", "api", endpoint], text=True))

    runs = []
    for page in range(1, (limit + 99) // 100 + 1):
        runs += api(f"repos/{repository}/actions/runs?per_page=100&page={page}")["workflow_runs"]
    snapshot = []
    for run in runs[:limit]:
        jobs = []
        page = 1
        while True:
            batch = api(
                f"repos/{repository}/actions/runs/{run['id']}/jobs?filter=all&per_page=100&page={page}"
            )["jobs"]
            jobs += batch
            if len(batch) < 100:
                break
            page += 1
        snapshot.append({"run": run, "jobs": jobs})
    return snapshot


def phase(name):
    value = name.lower()
    if value.startswith("post ") or any(
        word in value
        for word in ("upload-artifact", "collect isolated", "archive smoke", "complete job")
    ):
        return "upload_cleanup"
    if any(
        word in value
        for word in (
            "verify host behavior",
            "shared plan",
            "required portable plan",
            "shared mobile plan",
            "relay contracts with their required runtime",
        )
    ):
        # 这些复合 step 包含构建或安装；没有子报告不能全计作测试。
        return "mixed_work"
    if re.search(
        r"setup-|checkout@|rust-cache@|actions/cache@|download-artifact@|set up job|prepare|install|build |restore|locate|retain .*runtime|select .*baseline",
        value,
    ):
        return "preparation"
    if any(
        word in value
        for word in (
            "gate",
            "require every",
            "require applicable",
            "require all",
            "require planned",
            "determine",
            "record ",
            "measured",
            "validate workflow",
        )
    ):
        return "control"
    if re.search(r"verify|smoke|test|contract|audit|check ", value):
        return "validation"
    return "unclassified"


def predecessors(job, jobs):
    name = job["name"]
    if name in ("GUI gate", "Linux checks and container Runtime", "Release gate"):
        return [entry for entry in jobs if entry["id"] != job["id"]]
    if name.startswith("macOS GUI smoke (") or name.startswith("macOS Core contracts"):
        return [entry for entry in jobs if entry["name"] == "macOS GUI build and contracts"]
    if name == "Native Linuxbrew install and upgrade":
        return [entry for entry in jobs if entry["name"].startswith("Bundle and install (")]
    if name not in ("Determine applicable work", "Determine required verification"):
        return [
            entry
            for entry in jobs
            if entry["name"] in ("Determine applicable work", "Determine required verification")
        ]
    return []


def analyze(snapshot):
    rows, steps, runs = [], [], []
    for entry in snapshot:
        run, jobs = entry["run"], entry["jobs"]
        full = any(job["name"] == "macOS native Harness" and job.get("steps") for job in jobs)
        layout = (
            "shared-plan"
            if any(job["name"] == "Determine required verification" for job in jobs)
            else "workflow-specific"
        )
        for job in jobs:
            totals = defaultdict(float)
            for step in job.get("steps", []):
                if step.get("conclusion") == "skipped":
                    continue
                duration = seconds(step.get("started_at"), step.get("completed_at"))
                category = phase(step["name"])
                if duration is not None:
                    totals[category] += duration
                steps.append(
                    {
                        "run_id": run["id"],
                        "job_id": job["id"],
                        "attempt": job.get("run_attempt"),
                        "step": step["name"],
                        "phase": category,
                        "seconds": duration,
                        "conclusion": step.get("conclusion"),
                    }
                )
            wall = seconds(job.get("started_at"), job.get("completed_at"))
            wait = seconds(run["created_at"], job.get("started_at"))
            deps = [
                dep["completed_at"]
                for dep in predecessors(job, jobs)
                if dep.get("completed_at")
                and dep.get("conclusion") != "skipped"
                and instant(dep["completed_at"])
                <= instant(job.get("started_at") or run["created_at"])
            ]
            ready = max(deps, key=instant) if deps else run["created_at"]
            dag = min(wait or 0, seconds(run["created_at"], ready) or 0)
            created = job.get("created_at") or ready
            runner_wait = seconds(max((created, ready), key=instant), job.get("started_at"))
            labels = job.get("labels", [])
            os_name = (
                "macOS"
                if any("macos" in label.lower() for label in labels)
                else "Linux"
                if any("ubuntu" in label.lower() for label in labels)
                else "other"
            )
            rows.append(
                {
                    "workflow": run["name"],
                    "run_id": run["id"],
                    "sha": run["head_sha"],
                    "event": run["event"],
                    "run_conclusion": run.get("conclusion"),
                    "layout": layout,
                    "verify_scope": "native-and-portable" if full else "other",
                    "job_id": job["id"],
                    "job": job["name"],
                    "attempt": job.get("run_attempt"),
                    "conclusion": job.get("conclusion"),
                    "os": os_name,
                    "runner": job.get("runner_name"),
                    "runner_group": job.get("runner_group_name"),
                    "cache_state": "unknown",
                    "wait_from_run_s": wait,
                    "dag_wait_estimate_s": dag,
                    "runner_wait_lower_bound_s": runner_wait,
                    "unattributed_wait_s": max(0, (wait or 0) - dag - (runner_wait or 0)),
                    "preparation_s": totals["preparation"],
                    "validation_s": totals["validation"],
                    "mixed_work_s": totals["mixed_work"],
                    "upload_cleanup_s": totals["upload_cleanup"],
                    "control_s": totals["control"],
                    "unclassified_s": totals["unclassified"]
                    + max(0, (wall or 0) - sum(totals.values())),
                    "wall_s": wall,
                }
            )
        ended = [job["completed_at"] for job in jobs if job.get("completed_at")]
        completed = run["status"] == "completed"
        runs.append(
            {
                "workflow": run["name"],
                "run_id": run["id"],
                "sha": run["head_sha"],
                "event": run["event"],
                "conclusion": run.get("conclusion"),
                "layout": layout,
                "verify_scope": "native-and-portable" if full else "other",
                "wall_s": seconds(run["created_at"], max(ended, key=instant))
                if completed and ended
                else None,
                "runner_minutes": sum(
                    row["wall_s"] or 0 for row in rows if row["run_id"] == run["id"]
                )
                / 60,
            }
        )
    grouped = defaultdict(list)
    for row in rows:
        grouped[
            tuple(
                row[key]
                for key in (
                    "workflow",
                    "job",
                    "event",
                    "conclusion",
                    "layout",
                    "verify_scope",
                    "cache_state",
                )
            )
        ].append(row)
    summary = []
    measures = (
        "wall_s",
        "preparation_s",
        "validation_s",
        "mixed_work_s",
        "upload_cleanup_s",
        "dag_wait_estimate_s",
        "runner_wait_lower_bound_s",
    )
    for key, samples in sorted(grouped.items(), key=lambda pair: str(pair[0])):
        item = dict(
            zip(
                ("workflow", "job", "event", "conclusion", "layout", "verify_scope", "cache_state"),
                key,
            )
        )
        item["samples"] = len(samples)
        for measure in measures:
            values = [sample[measure] for sample in samples if sample[measure] is not None]
            item[measure] = (
                {"median": statistics.median(values), "max": max(values), "min": min(values)}
                if values
                else None
            )
        summary.append(item)
    return {
        "notes": [
            "DAG waiting is estimated from known predecessor completions. Jobs API does not expose exact ready time; runner wait is a lower bound and residual waiting stays unattributed.",
            "Mixed steps include compilation/installation and validation; do not count them as pure test time. Child reports or logs are needed for an exact split.",
            "Cache state is unknown without cache logs. Compare successful runs with the same coverage, platform and cache state; cancelled/failed/incomplete runs are retained separately.",
            "Runner minutes are accumulated observed job wall time, not a billing estimate. Incomplete jobs have no complete duration.",
        ],
        "runs": runs,
        "jobs": rows,
        "steps": steps,
        "cohorts": summary,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--collect", metavar="OWNER/REPO")
    source.add_argument("--input", type=Path)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--output", type=Path, default=Path("target/ci/timing"))
    args = parser.parse_args()
    snapshot = (
        collect(args.collect, args.limit) if args.collect else json.loads(args.input.read_text())
    )
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "snapshot.json").write_text(json.dumps(snapshot, indent=2) + "\n")
    result = analyze(snapshot)
    (args.output / "analysis.json").write_text(json.dumps(result, indent=2) + "\n")
    for name in ("jobs", "steps", "runs"):
        with (args.output / (name + ".csv")).open("w", newline="") as stream:
            values = result[name]
            if values:
                writer = csv.DictWriter(stream, fieldnames=list(values[0]))
                writer.writeheader()
                writer.writerows(values)
    print(
        json.dumps({"runs": len(snapshot), "jobs": len(result["jobs"]), "output": str(args.output)})
    )


if __name__ == "__main__":
    main()
