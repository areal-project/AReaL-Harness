"""独立扫描所有锁文件；保留漏洞命中与扫描错误，不让前一个失败遮住后续。"""

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SCANS = [
    ("rust", ["cargo", "audit", "--json"], "."),
    ("npm-root", ["npm", "audit", "--json"], "."),
    ("npm-runtime", ["npm", "audit", "--json"], "runtime/sdk-typescript"),
    ("npm-core", ["npm", "audit", "--json"], "core/sdk-typescript"),
    ("pnpm-gui", ["pnpm", "audit", "--json"], "clients/gui"),
]


def outcome(code, document):
    if not isinstance(document, dict) or document.get("error"):
        return "scan_error"
    metadata = document.get("metadata")
    vulnerabilities = document.get("vulnerabilities")
    if isinstance(vulnerabilities, dict) and isinstance(vulnerabilities.get("list"), list):
        hits = len(vulnerabilities["list"])
    elif isinstance(metadata, dict) and isinstance(metadata.get("vulnerabilities"), dict):
        counts = metadata["vulnerabilities"]
        if not counts or any(type(value) is not int or value < 0 for value in counts.values()):
            return "scan_error"
        hits = max(
            counts.get("total", 0), sum(value for key, value in counts.items() if key != "total")
        )
    else:
        return "scan_error"
    return "vulnerabilities" if hits else ("clean" if code == 0 else "scan_error")


def scan_all(scans=SCANS, run=subprocess.run, root=ROOT):
    results = []
    for name, command, directory in scans:
        try:
            process = run(
                command, cwd=root / directory, text=True, capture_output=True, timeout=180
            )
            try:
                document = json.loads(process.stdout)
            except json.JSONDecodeError:
                document = None
            result = {
                "name": name,
                "status": outcome(process.returncode, document),
                "exitCode": process.returncode,
                "report": document,
                "stderr": process.stderr[-8192:],
            }
        except (OSError, subprocess.TimeoutExpired) as error:
            result = {"name": name, "status": "scan_error", "error": str(error)}
        results.append(result)
    return results


if __name__ == "__main__":
    output = ROOT / "target/ci/audit"
    output.mkdir(parents=True, exist_ok=True)
    results = scan_all()
    revision = subprocess.run(
        ["git", "-C", str(Path.home() / ".cargo/advisory-db"), "rev-parse", "HEAD"],
        text=True,
        capture_output=True,
    )
    report = {
        "rustsecRevision": revision.stdout.strip() if revision.returncode == 0 else None,
        "npmDatabase": "registry live audit endpoint; immutable revision unavailable",
        "scans": results,
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "rustsecRevision": report["rustsecRevision"],
                "scans": [{"name": item["name"], "status": item["status"]} for item in results],
            }
        )
    )
    sys.exit(0 if all(item["status"] == "clean" for item in results) else 1)
