#!/usr/bin/env python3
"""汇总 Core 输出投影与前缀指纹；可用同一 Rust 实现离线回放已保留原文。"""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def usage_counter(audit, field):
    if not audit.get("usageObserved"):
        return None
    if field in ("cachedInputTokens", "reasoningTokens") and "usageDetails" in audit:
        return audit["usageDetails"].get(field)
    return (audit.get("usage") or {}).get(field)


def records(directory):
    items = []
    for path in sorted(directory.glob("*.json")):
        thread = json.loads(path.read_text()).get("thread")
        if thread:
            for turn in thread["turns"]:
                items.extend(item for item in turn["items"] if item["type"] == "dynamicToolCall")
    return items


def result_value(item):
    parts = item.get("contentItems") or []
    if len(parts) == 1 and parts[0].get("type") == "inputText":
        try:
            return json.loads(parts[0]["text"])
        except ValueError:
            pass
    return None


def prefix_changes(audits):
    previous = {}
    events = []
    for audit in sorted(audits, key=lambda a: (a.get("startedAtUnixMs", 0), a["requestId"])):
        blocks = audit.get("messageBlocks")
        if blocks is None:
            continue
        key = (audit.get("threadId"), audit.get("purpose"))
        before = previous.get(key)
        previous[key] = audit
        if not before:
            continue
        old = before["messageBlocks"]
        shared = 0
        for a, b in zip(old, blocks):
            if a["sha256"] != b["sha256"]:
                break
            shared += 1
        reason = "appendOnly" if shared == len(old) else "existingBlocksChanged"
        if audit.get("toolSchemaSha256") != before.get("toolSchemaSha256"):
            reason = "toolSchemaChanged"
        elif audit.get("instructionsSha256") != before.get("instructionsSha256"):
            reason = "instructionsChanged"
        events.append(
            {
                "requestId": audit["requestId"],
                "reason": reason,
                "sharedBlocks": shared,
                "sharedMessageBytes": sum(b["bytes"] for b in blocks[:shared]),
                "previousBlocks": len(old),
                "currentBlocks": len(blocks),
            }
        )
    return events


def report(directory, items):
    audits = [
        json.loads(path.read_text()) for path in (directory / "model-requests").glob("*.json")
    ]
    projections = [
        i["execution"]["outputProjection"]
        for i in items
        if i.get("execution", {}).get("outputProjection")
    ]
    retrievals = [i for i in items if i["tool"] == "read_tool_result"]
    groups = defaultdict(list)
    for projection in projections:
        groups[(projection["mode"], projection["transform"], projection["reason"])].append(
            projection
        )
    usage = {}
    partial = {}
    for field in ("inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"):
        observed = [
            usage_counter(a, field) for a in audits if isinstance(usage_counter(a, field), int)
        ]
        usage[field] = sum(observed) if observed and len(observed) == len(audits) else None
        partial[field] = sum(observed)
    if usage["inputTokens"] is not None and usage["cachedInputTokens"] is not None:
        usage["uncachedInputTokens"] = usage["inputTokens"] - usage["cachedInputTokens"]
    else:
        usage["uncachedInputTokens"] = None
    prefix = prefix_changes(audits)
    return {
        "modelRequests": len(audits),
        "usage": usage,
        "observedPartialUsage": partial,
        "unknownUsageRequests": sum(not a.get("usageObserved") for a in audits),
        "legacyUsageDetailsRequests": sum("usageDetails" not in a for a in audits),
        "requestOutcomes": dict(Counter(a.get("outcome", "unknown") for a in audits)),
        "toolCalls": len(items),
        "failedTools": sum(i.get("success") is False for i in items),
        "snapshotLogicalBytes": sum(
            i.get("execution", {}).get("resultSnapshot", {}).get("sizeBytes", 0) for i in items
        ),
        "retrievalCalls": len(retrievals),
        "failedRetrievals": sum(i.get("success") is False for i in retrievals),
        "retrievedBytes": sum((result_value(i) or {}).get("bytes", 0) for i in retrievals),
        "projections": [
            {
                "mode": key[0],
                "transform": key[1],
                "reason": key[2],
                "count": len(values),
                "rawBytes": sum(p["rawBytes"] for p in values),
                "displayedBytes": sum(p["displayedBytes"] for p in values),
                "candidateBytes": sum(p.get("candidateBytes") or 0 for p in values),
                "preprocessingMicros": sum(p["durationMicros"] for p in values),
            }
            for key, values in sorted(groups.items())
        ],
        "prefixReasons": dict(Counter(p["reason"] for p in prefix)),
        "prefixComparisons": prefix,
        "limits": "Byte savings/estimated tokens are not billed savings. Prefix fingerprints are diagnostics, not provider cache-hit proof. Missing usage is null. Preprocessing is elapsed time, not CPU time.",
    }


def replay(directory, items):
    originals = []
    for item in items:
        snapshot = item.get("execution", {}).get("resultSnapshot")
        if not snapshot:
            continue
        digest = snapshot["uri"].removeprefix("areal://blob/")
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("invalid snapshot digest")
        data = (directory / "blobs" / digest).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest or len(data) != snapshot["sizeBytes"]:
            raise ValueError("snapshot integrity verification failed")
        raw = json.loads(data)
        args = item.get("execution", {}).get("effectiveArguments") or item["arguments"]
        argv = None
        if (
            item["tool"] in ("run_command", "verify_command")
            and isinstance(raw, dict)
            and raw.get("requestedOutputView") == "auto"
        ):
            argv = args.get("argv") or (
                ["/bin/bash", "-o", "pipefail", "-c", args["command"]]
                if args.get("command")
                else None
            )
        originals.append({"id": item["id"], "tool": item["tool"], "raw": raw, "argv": argv})
    with tempfile.TemporaryDirectory(prefix="areal-result-replay-") as temp:
        source, output = Path(temp) / "input.json", Path(temp) / "output.json"
        source.write_text(json.dumps(originals))
        env = {
            **os.environ,
            "AREAL_RESULT_REPLAY_INPUT": str(source),
            "AREAL_RESULT_REPLAY_OUTPUT": str(output),
        }
        subprocess.run(
            [
                "cargo",
                "test",
                "--locked",
                "-p",
                "areal-engine",
                "--lib",
                "tools::results::tests::replay_saved_originals",
                "--",
                "--ignored",
                "--exact",
            ],
            cwd=ROOT,
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        return {
            "mode": "offline simulation; no model requests",
            "replayedOriginals": len(originals),
            "notReplayed": len(items) - len(originals),
            "limitations": "Only preserved snapshots are replayed. read_process command classification is unavailable when the original argv was not archived in that call. Per-Thread quota is not simulated.",
            "results": json.loads(output.read_text()),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_dir", type=Path)
    parser.add_argument("--replay", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    items = records(args.data_dir)
    value = report(args.data_dir, items)
    if args.replay:
        value["simulation"] = replay(args.data_dir, items)
    text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(text)
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
