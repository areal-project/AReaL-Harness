#!/usr/bin/env python3
"""汇总 Core 模型请求审计：未知用量与真实未命中分开，比较每个线程的 wire 前缀。"""

import argparse
import json
from collections import defaultdict
from pathlib import Path


def report(directory):
    # 单请求 JSON 是最终权威记录；不再读 requests.jsonl，避免重复计数。
    rows = []
    seen = set()
    for path in directory.rglob("*.json"):
        if path.parent.name not in {"model-requests", "model-requests-child"}:
            continue
        value = json.loads(path.read_text())
        request = value.get("requestId")
        if request and request not in seen:
            seen.add(request)
            rows.append(value)
    rows.sort(key=lambda r: (r.get("startedAtUnixMs", 0), r.get("requestId", "")))
    previous = {}
    totals = {
        "requests": len(rows),
        "usageObservedRequests": 0,
        "unknownUsageRequests": 0,
        "knownCacheRequests": 0,
        "unknownCacheRequests": 0,
        "inputTokens": 0,
        "cacheComparableInputTokens": 0,
        "cachedInputTokens": 0,
        "knownUncachedInputTokens": 0,
        "comparablePrefixPairs": 0,
        "preservedPrefixPairs": 0,
    }
    outcomes = defaultdict(int)
    details = []
    for row in rows:
        outcomes[row.get("outcome", "unknown")] += 1
        item = {
            "requestId": row.get("requestId"),
            "threadId": row.get("threadId"),
            "outcome": row.get("outcome"),
            "durationMs": row.get("durationMs"),
        }
        for field in [
            "transport",
            "incremental",
            "wireInputItems",
            "wireBodyBytes",
            "gatewayTraceId",
            "httpRequestId",
            "timeToFirstResponseBytesMs",
            "timeToFirstTextDeltaMs",
            "timeToFirstReasoningDeltaMs",
        ]:
            if field in row:
                item[field] = row[field]
        usage = row.get("usage") or {}
        detail = row.get("usageDetails") or {}
        if row.get("usageObserved") and isinstance(usage.get("inputTokens"), int):
            tokens = usage["inputTokens"]
            totals["usageObservedRequests"] += 1
            totals["inputTokens"] += tokens
            # 新审计明确保留 null；旧文件缺 usageDetails 无法判定是否真实返回 cached。
            cached = detail.get("cachedInputTokens")
            if isinstance(cached, int) and 0 <= cached <= tokens:
                totals["knownCacheRequests"] += 1
                totals["cacheComparableInputTokens"] += tokens
                totals["cachedInputTokens"] += cached
                totals["knownUncachedInputTokens"] += tokens - cached
                item.update(inputTokens=tokens, cachedInputTokens=cached)
            else:
                totals["unknownCacheRequests"] += 1
                item.update(inputTokens=tokens, cachedInputTokens=None)
        else:
            totals["unknownUsageRequests"] += 1
            item.update(inputTokens=None, cachedInputTokens=None)
        if detail.get("providerResponseId"):
            item["providerResponseId"] = detail["providerResponseId"]
        key = (
            row.get("threadId"),
            row.get("purpose"),
            row.get("protocol"),
            json.dumps(row.get("parameters"), sort_keys=True),
        )
        old = previous.get(key)
        blocks = row.get("messageBlocks")
        if (
            old is not None
            and isinstance(blocks, list)
            and isinstance(old.get("messageBlocks"), list)
        ):
            common = 0
            for a, b in zip(old["messageBlocks"], blocks):
                if a != b:
                    break
                common += 1
            stable_tools = old.get("toolSchemaSha256") == row.get("toolSchemaSha256")
            stable_instructions = old.get("instructionsSha256") == row.get("instructionsSha256")
            preserved = common == len(old["messageBlocks"]) and stable_tools and stable_instructions
            totals["comparablePrefixPairs"] += 1
            totals["preservedPrefixPairs"] += preserved
            item.update(
                previousRequestId=old.get("requestId"),
                commonMessageBlocks=common,
                commonBlockBytes=sum(b.get("bytes", 0) for b in blocks[:common]),
                completePreviousInputPrefix=preserved,
                stableTools=stable_tools,
                stableInstructions=stable_instructions,
            )
        previous[key] = row
        details.append(item)
    denominator = totals["cacheComparableInputTokens"]
    totals["weightedCacheRate"] = totals["cachedInputTokens"] / denominator if denominator else None
    return {
        "schema": "areal.cache-report.v1",
        "totals": totals,
        "outcomes": dict(outcomes),
        "requests": details,
        "limitations": [
            "Wire prefix equality does not prove identical provider tokenization or backend cache residency.",
            "Rates include only requests with observed input and explicit valid cached-token counts.",
            "Missing usage/cache counts are unknown, never inferred as zero; no cost or TTFT inferred from duration.",
            "Compaction, model changes and tool changes can intentionally reset prefixes.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path, help="Core state directory")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.state.is_dir():
        parser.error("state directory does not exist")
    result = json.dumps(report(args.state), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(result)
    else:
        print(result, end="")


if __name__ == "__main__":
    main()
