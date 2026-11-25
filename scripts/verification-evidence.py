"""Validate the shared verification evidence envelope."""

import argparse
import hashlib
import json
from pathlib import Path


STATUSES = {"passed", "failed", "blocked", "pending", "running", "invalidated", "cancelled"}
FACT_STATUSES = {"passed", "failed", "blocked", "pending"}


def validate_journey_report(detail, contract, identity, imported=False):
    if not isinstance(detail, dict) or not all(
        key in detail for key in ("facts", "firstFailure", "reached", "unreached", "cleanup")
    ):
        raise ValueError("journey report is missing its business evidence envelope")
    if (
        detail.get("schemaVersion") != 1
        or detail.get("journeyId") != contract["journeyId"]
        or detail.get("identity") != identity
    ):
        raise ValueError("journey report identity differs from its current plan/run")
    if (
        not isinstance(detail["facts"], list)
        or any(not isinstance(row, dict) for row in detail["facts"])
        or not isinstance(detail["cleanup"], dict)
    ):
        raise ValueError("journey facts and cleanup must be records")
    facts = indexed(detail["facts"], "business fact")
    if set(facts) != set(contract["terminalFacts"]):
        raise ValueError("journey report does not cover the exact required business facts")
    if not isinstance(detail.get("status"), str) or detail["status"] not in FACT_STATUSES:
        raise ValueError("invalid journey report status")
    cleanup = detail.get("cleanup", {})
    rows = [*facts.values(), cleanup]
    paths = set()
    for row in rows:
        if (
            not isinstance(row.get("status"), str)
            or row["status"] not in FACT_STATUSES
            or not isinstance(row.get("evidence"), list)
        ):
            raise ValueError("business facts and cleanup require status and evidence")
        if row["status"] == "passed" and not row["evidence"]:
            raise ValueError("passed business facts and cleanup require evidence")
        for name in row["evidence"]:
            if (
                not isinstance(name, str)
                or not name
                or Path(name).is_absolute()
                or ".." in Path(name).parts
                or name == "."
            ):
                raise ValueError("journey evidence path must remain inside its report directory")
            paths.add(name)
    for key in ("reached", "unreached"):
        entries = detail.get(key)
        if (
            not isinstance(entries, list)
            or any(not isinstance(entry, str) or not entry for entry in entries)
            or len(entries) != len(set(entries))
        ):
            raise ValueError("journey report requires unique reached and unreached stages")
    if set(detail["reached"]) & set(detail["unreached"]):
        raise ValueError("journey stages cannot be both reached and unreached")
    if detail["status"] == "passed":
        if (
            any(row["status"] != "passed" for row in rows)
            or detail.get("firstFailure") is not None
            or detail["unreached"]
        ):
            raise ValueError("passed journey has failed, pending or unreached obligations")
    elif not detail.get("firstFailure"):
        raise ValueError("unsuccessful journey requires its first failure")
    if imported:
        artifacts = detail.get("artifacts", {})
        if (
            not isinstance(artifacts, dict)
            or set(artifacts) != paths
            or any(
                not isinstance(value, str)
                or len(value) != 64
                or any(char not in "0123456789abcdef" for char in value)
                for value in artifacts.values()
            )
        ):
            raise ValueError("journey artifacts do not match its evidence references")
    return paths


def read_journey_report(path, contract, identity):
    if path.is_symlink() or not path.is_file():
        raise ValueError("journey runner did not produce a regular report file")
    detail = json.loads(path.read_text())
    try:
        paths = validate_journey_report(detail, contract, identity)
        root = path.parent.resolve()
        artifacts = {}
        for name in sorted(paths):
            artifact = root / name
            if (
                not artifact.is_file()
                or not artifact.resolve().is_relative_to(root)
                or any(
                    candidate.is_symlink()
                    for candidate in (artifact, *artifact.parents)
                    if candidate != root and candidate.is_relative_to(root)
                )
            ):
                raise ValueError(
                    "journey evidence is missing or escapes its report directory: " + name
                )
            digest = hashlib.sha256()
            with artifact.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            artifacts[name] = digest.hexdigest()
        return {**detail, "artifacts": artifacts}
    except (OSError, ValueError) as error:
        # 无效附件仍阻断验收，但保留 runner 的首个业务失败，避免只能人工翻日志。
        failure = detail.get("firstFailure") if isinstance(detail, dict) else None
        suffix = (
            "; runner firstFailure: " + json.dumps(failure, ensure_ascii=False) if failure else ""
        )
        raise ValueError(str(error) + suffix) from error


def indexed(rows, label):
    values = {}
    for row in rows:
        name = row.get("id")
        if not isinstance(name, str) or not name or name in values:
            raise ValueError(f"duplicate or missing {label} id: {name}")
        values[name] = row
    return values


def summarize(plan, results, report_status=None, identity=None):
    by_id = indexed(results, "result")
    journeys = []
    for name in plan.get("affectedJourneys", []):
        required = plan["journeyChecks"][name]
        if not required or len(required) != len(set(required)):
            raise ValueError(f"journey {name} must require unique checks")
        observed = [by_id[check] for check in required if check in by_id]
        missing = [check for check in required if check not in by_id]
        states = []
        reasons = []
        for row in observed:
            status = row.get("status")
            if status not in STATUSES:
                raise ValueError(f"unknown result status: {status}")
            if status == "passed" and row.get("exitCode") != 0:
                status = "failed"
            states.append(status)
            if status != "passed":
                details = [
                    row.get("reason"),
                    *row.get("missingRequirements", []),
                    *row.get("blockedBy", []),
                ]
                reasons.extend(f"{row['id']}: {detail}" for detail in details if detail)
                if not any(details):
                    reasons.append(f"{row['id']}: {status}")
        if missing:
            states.append("pending")
            reasons.extend(f"missing check: {check}" for check in missing)
        if report_status in {"invalidated", "cancelled"}:
            states.append(report_status)
            reasons.append("report: " + report_status)
        fact_summary = {}
        contract = plan.get("journeyEvidence", {}).get(name)
        if contract:
            owner = by_id.get(contract["check"])
            detail = owner.get("journeyEvidence") if owner else None
            if detail:
                validate_journey_report(detail, contract, identity, imported=True)
                if owner["status"] == "passed" and detail["status"] != "passed":
                    raise ValueError("passed runner has unsuccessful business evidence")
                states.append(detail["status"])
                fact_summary = {
                    "facts": detail["facts"],
                    "firstFailure": detail["firstFailure"],
                    "reached": detail["reached"],
                    "unreached": detail["unreached"],
                    "cleanup": detail["cleanup"],
                    "artifacts": detail["artifacts"],
                    "report": owner.get("journeyReport"),
                }
                if detail["status"] != "passed":
                    reasons.append("business journey: " + str(detail["firstFailure"]))
            else:
                if owner and owner["status"] == "passed":
                    raise ValueError("passed runner is missing required business evidence")
                states.append("pending")
                reasons.append("business evidence unavailable: " + contract["check"])
                fact_summary = {
                    "facts": [
                        {"id": fact, "status": "pending", "evidence": []}
                        for fact in contract["terminalFacts"]
                    ]
                }
        status = next(
            (
                state
                for state in ("invalidated", "failed", "blocked", "cancelled", "running", "pending")
                if state in states
            ),
            "passed",
        )
        journeys.append(
            {
                "id": name,
                "requiredChecks": list(required),
                "observedChecks": [row["id"] for row in observed],
                "missingChecks": missing,
                "blockReasons": reasons,
                "status": status,
                **fact_summary,
            }
        )
    return journeys


def build(plan, report):
    identity = report["identity"]
    if identity.get("planHash") != plan["planHash"] or any(
        identity.get(key) != value for key, value in plan["source"].items()
    ):
        raise ValueError("verification report source does not match plan identity")
    results = indexed(report["results"], "result")
    planned = indexed(plan["items"], "planned check")
    if results.keys() - planned.keys():
        raise ValueError("verification evidence references an unknown check")
    for result in results.values():
        if result.get("status") not in STATUSES:
            raise ValueError("verification evidence has an invalid check status")
        if report["platform"] not in planned[result["id"]]["platforms"]:
            raise ValueError("verification evidence uses the wrong platform: " + result["id"])
    return {
        "schemaVersion": 1,
        "source": dict(identity),
        "platform": report["platform"],
        "journeys": summarize(plan, report["results"], report["status"], identity),
        "authorities": sorted(
            {
                authority
                for name in plan.get("affectedJourneys", [])
                for authority in plan["journeyAuthorities"][name]
            }
        ),
        "checks": [
            {"id": row["id"], "status": row["status"], "authority": "ci-preflight"}
            for row in results.values()
        ],
    }


def validate(report, plan):
    evidence = report.get("evidence")
    if not isinstance(evidence, dict) or evidence.get("schemaVersion") != 1:
        raise ValueError("verification report is missing evidence schemaVersion 1")
    if evidence != build(plan, report):
        raise ValueError("verification evidence differs from plan, identity or results")
    return evidence


def decision_summary(detail, *, full_ci=None, report_path=None):
    """生成面向人工与 Agent 分诊的紧凑决策摘要，剥离重复附件清单与哈希，保留全部裁决事实。"""
    facts = {row["id"]: row["status"] for row in detail.get("facts", [])}
    faults = {
        name: bool(info.get("injectionReached"))
        for name, info in (detail.get("faults") or {}).items()
        if isinstance(info, dict)
    }
    cleanup = detail.get("cleanup") or {}
    cleanup_summary = {"status": cleanup.get("status", "pending")}
    if cleanup.get("status") != "passed" and (cleanup.get("errors") or cleanup.get("message")):
        cleanup_summary["detail"] = cleanup.get("errors") or cleanup.get("message")
    summary = {
        "schemaVersion": 1,
        "journeyId": detail.get("journeyId"),
        "status": detail.get("status"),
        "facts": facts,
        "firstFailure": detail.get("firstFailure"),
        "unreached": list(detail.get("unreached") or []),
        "cleanup": cleanup_summary,
        "fullCiPassed": full_ci,
    }
    if faults:
        summary["faultsInjectionReached"] = faults
    if detail.get("scope"):
        summary["scope"] = detail["scope"]
    if report_path is not None:
        summary["fullReport"] = str(report_path)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument(
        "--summary",
        action="store_true",
        help="输出精简决策摘要（支持单条旅程 report.json 或完整 preflight report.json）",
    )
    args = parser.parse_args(argv)
    payload = json.loads(args.report.read_text())
    if args.summary and "journeyId" in payload and "facts" in payload:
        print(
            json.dumps(
                decision_summary(payload, full_ci=None, report_path=args.report),
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    plan = json.loads(args.report.with_name("plan.json").read_text())
    ev = validate(payload, plan)
    if args.summary:
        journeys = [
            decision_summary(
                {**j, "journeyId": j["id"]},
                full_ci=None,
                report_path=j.get("report") or args.report,
            )
            for j in ev.get("journeys", [])
        ]
        print(json.dumps({"status": "passed", "journeys": journeys}, ensure_ascii=False, indent=2))
        return 0
    print(json.dumps({"status": "passed", "report": str(args.report)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
