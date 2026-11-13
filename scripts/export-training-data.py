#!/usr/bin/env python3
"""从 Harness OTLP/JSON 或 AReaL 原生导出离线制样；不调用模型。"""

import argparse
from collections import Counter
import hashlib
from itertools import chain
import json
from pathlib import Path
import sys

from training_data import (
    EvidenceError,
    log_records,
    read_documents,
    requests_from_logs,
    samples_from_areal,
    tokenize_request,
    validate_sft,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("format", choices=["otlp", "areal", "tokenize"])
    parser.add_argument("--input", type=Path, nargs="+", required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="新目录，拒绝覆盖")
    parser.add_argument(
        "--areal-root", type=Path, help="本机 AReaL 源码，用于解析原生 export_interactions 响应"
    )
    parser.add_argument("--tokenizer", help="tokenize 模式使用的本地 tokenizer 目录")
    parser.add_argument(
        "--backend-context",
        choices=["request-template"],
        help="明确确认后端按请求模板重编码；concat 不适用",
    )
    parser.add_argument(
        "--template-kwargs", default="{}", help="与推理一致的 chat_template_kwargs JSON"
    )
    parser.add_argument("--max-length", type=int, help="只隔离超长样本，绝不截断历史或目标")
    args = parser.parse_args()
    if args.max_length is not None and args.max_length < 2:
        parser.error("--max-length must be >= 2")
    if args.format == "tokenize" and (not args.tokenizer or not args.backend_context):
        parser.error("tokenize requires --tokenizer and --backend-context request-template")
    if args.format != "tokenize" and (args.tokenizer or args.backend_context):
        parser.error("tokenizer/context options apply only to tokenize")
    if args.areal_root:
        sys.path.insert(0, str(args.areal_root.resolve()))
    kwargs = json.loads(args.template_kwargs)
    if not isinstance(kwargs, dict):
        parser.error("--template-kwargs must be a JSON object")
    sources = []
    for path in args.input:
        with path.open("rb") as stream:
            sources.append(
                {"file": path.name, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}
            )
    documents = chain.from_iterable(read_documents(path) for path in args.input)
    if args.format == "otlp":
        records = [record for doc in documents for record in log_records(doc)]
        rows = requests_from_logs(records)
    elif args.format == "areal":
        from areal.experimental.openai.proxy.server import deserialize_interactions

        def areal_rows():
            for doc in documents:
                if not isinstance(doc, dict) or not isinstance(doc.get("interactions"), dict):
                    yield (
                        None,
                        {"id": None, "status": "UNKNOWN", "reason": "missing_native_interactions"},
                    )
                    continue
                for key, entry in doc["interactions"].items():
                    try:
                        interaction = deserialize_interactions({key: entry})
                        yield from samples_from_areal(interaction)
                    except (
                        ValueError,
                        TypeError,
                        KeyError,
                        AttributeError,
                        RuntimeError,
                        IndexError,
                    ):
                        yield (
                            None,
                            {
                                "id": key,
                                "status": "UNKNOWN",
                                "reason": "malformed_native_interaction",
                            },
                        )

        rows = areal_rows()
    else:
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, local_files_only=True)

        def token_rows():
            for doc in documents:
                for sample in doc if isinstance(doc, list) else [doc]:
                    sample_id = sample.get("id") if isinstance(sample, dict) else None
                    try:
                        if not isinstance(sample, dict):
                            raise EvidenceError("malformed_request_sample")
                        yield (
                            tokenize_request(sample, tokenizer, kwargs),
                            {
                                "id": sample_id,
                                "status": "READY",
                                "reason": None,
                            },
                        )
                    except (EvidenceError, ValueError, KeyError, TypeError, AttributeError) as exc:
                        yield (
                            None,
                            {
                                "id": sample_id,
                                "status": "UNKNOWN",
                                "reason": str(exc)
                                if isinstance(exc, EvidenceError)
                                else "unsupported_or_malformed_template_input",
                            },
                        )

        rows = token_rows()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    counts, reasons, seen = Counter(), Counter(), set()
    with (
        (args.output_dir / "samples.jsonl.tmp").open("w", encoding="utf-8") as samples,
        (args.output_dir / "audit.jsonl.tmp").open("w", encoding="utf-8") as audit,
    ):
        for sample, decision in rows:
            if sample is not None:
                try:
                    if "input_ids" in sample:
                        validate_sft(sample, args.max_length)
                    if sample["id"] in seen:
                        raise EvidenceError("duplicate_sample_id")
                    seen.add(sample["id"])
                except EvidenceError as exc:
                    sample = None
                    decision.update(status="UNKNOWN", reason=str(exc))
            if sample is not None:
                samples.write(json.dumps(sample, ensure_ascii=False) + "\n")
            audit.write(json.dumps(decision, ensure_ascii=False) + "\n")
            counts[decision["status"]] += 1
            if decision["reason"]:
                reasons[decision["reason"]] += 1
    report = {
        "schema": "areal.sft.report/v1",
        "format": args.format,
        "sources": sources,
        "counts": dict(counts),
        "reasons": dict(reasons),
        "quality": "unreviewed",
        "max_length": args.max_length,
        "tokenizer": args.tokenizer,
        "template_kwargs": kwargs,
        "backend_context": args.backend_context,
    }
    (args.output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for name in ("samples.jsonl", "audit.jsonl"):
        (args.output_dir / f"{name}.tmp").rename(args.output_dir / name)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
