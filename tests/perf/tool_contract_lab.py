#!/usr/bin/env python3
"""直接模型工具契约探针；先持久化意图，单次派发，全部终态计量。"""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import random
import ssl
import statistics
import time
import urllib.error
import urllib.request
import uuid


MODELS = {
    "astra": ("gpt-6-astra", "responses", 36),
    "qwen": ("qwen38-27b-flywheel", "responses", 50),
}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def cases():
    return [
        (
            "read-lines",
            "read_file",
            {"path": "src/模型.py", "offset": 17, "limit": 23},
            "Read exactly 23 lines of src/模型.py starting at 1-based line 17.",
        ),
        (
            "regex-escaping",
            "search_files",
            {"path": "src", "pattern": r"\bcall\(\"[^\"]+\"\)", "glob": "*.py", "limit": 20},
            "Search src, glob *.py, limit 20, using this exact regex: " + r"\bcall\(\"[^\"]+\"\)",
        ),
        (
            "argv-spaces",
            "run_command",
            {
                "argv": ["python", "scripts/build asset.py", "--label", "a b; $HOME"],
                "yieldMs": 1000,
            },
            'Run python directly with these literal arguments: ["scripts/build asset.py", "--label", "a b; $HOME"]. Do not invoke a shell. Set yieldMs to 1000.',
        ),
        (
            "shell-multiline",
            "run_command",
            {"command": "python - <<'PY'\nprint('你好 \\\\ world')\nPY", "yieldMs": 1000},
            "Run exactly this shell text, with yieldMs 1000:\npython - <<'PY'\nprint('你好 \\\\ world')\nPY",
        ),
        (
            "create-text",
            "edit_files",
            {"files": [{"path": "hello.txt", "text": '你好\nquote: "a"\npath: C:\\tmp\\a\n'}]},
            'Create absent hello.txt containing exactly the JSON-decoded string: "你好\\nquote: \\"a\\"\\npath: C:\\\\tmp\\\\a\\n". Parent exists.',
        ),
        (
            "edit-one",
            "edit_files",
            {
                "files": [
                    {
                        "path": "src/a.py",
                        "patches": [{"oldText": "return x - 1", "newText": "return x + 1"}],
                    }
                ]
            },
            "In already observed src/a.py, replace the unique exact text `return x - 1` with `return x + 1`.",
        ),
        (
            "edit-batch",
            "edit_files",
            {
                "files": [
                    {"path": "a.py", "patches": [{"oldText": "A = 1", "newText": "A = 2"}]},
                    {"path": "b.py", "patches": [{"oldText": "B = 3", "newText": "B = 4"}]},
                ]
            },
            "In one ordered batch, edit already observed a.py: unique A = 1 to A = 2; then already observed b.py: unique B = 3 to B = 4.",
        ),
        (
            "edit-mixed",
            "edit_files",
            {
                "files": [
                    {"path": "new.txt", "text": "first\n"},
                    {"path": "old.txt", "patches": [{"oldText": "second", "newText": "third"}]},
                ]
            },
            'In one ordered batch, create absent new.txt with exact text "first\\n", then edit observed old.txt by replacing unique second with third. Parent directories exist.',
        ),
        (
            "process-handle",
            "read_process",
            {"processId": "p7a42b1e9c03f5d86", "waitMs": 1000},
            "Collect process p7a42b1e9c03f5d86 for up to 1000 ms, resuming the last returned cursor by omitting after.",
        ),
        (
            "stdin-eof",
            "write_process",
            {"processId": "p68a03fe91b247dc5", "text": "yes\n", "close": True},
            "The process p68a03fe91b247dc5 was started with stdinOpen=true. Send the line yes followed by newline, then EOF in the same call.",
        ),
        (
            "blender-check-argv",
            "verify_command",
            {
                "argv": [
                    "blender",
                    "--background",
                    "scene.blend",
                    "--python-exit-code",
                    "1",
                    "--python",
                    "check_scene.py",
                ]
            },
            'Run this exact already-selected executable and arguments directly: ["blender", "--background", "scene.blend", "--python-exit-code", "1", "--python", "check_scene.py"].',
        ),
        (
            "directory-page",
            "fs_list",
            {"path": "assets", "after": "opaque-page:2/中文", "limit": 64},
            "List assets with limit 64, continuing the returned cursor exactly: opaque-page:2/中文.",
        ),
    ]


def normalize_tools(capture):
    tools = []
    for entry in capture["tools"]:
        function = entry.get("function", entry)
        tools.append(
            {
                "type": "function",
                "name": function["name"],
                "description": function.get("description", ""),
                "parameters": function["parameters"],
                "strict": False,
            }
        )
    return tools


def usage_of(value, protocol):
    if not isinstance(value, dict):
        return {
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "cached_input_tokens": None,
            "reasoning_tokens": None,
        }
    inp = value.get("input_tokens" if protocol == "responses" else "prompt_tokens")
    out = value.get("output_tokens" if protocol == "responses" else "completion_tokens")
    valid = all(type(n) is int and n >= 0 for n in (inp, out))
    total = value.get("total_tokens", inp + out if valid else None)
    valid = valid and type(total) is int and total == inp + out
    details = (
        value.get("input_tokens_details" if protocol == "responses" else "prompt_tokens_details")
        or {}
    )
    output_details = (
        value.get(
            "output_tokens_details" if protocol == "responses" else "completion_tokens_details"
        )
        or {}
    )
    details = details if isinstance(details, dict) else {}
    output_details = output_details if isinstance(output_details, dict) else {}
    cached = details.get("cached_tokens")
    reasoning = output_details.get("reasoning_tokens", value.get("reasoning_tokens"))
    return {
        "input_tokens": inp if valid else None,
        "output_tokens": out if valid else None,
        "total_tokens": total if valid else None,
        "cached_input_tokens": cached
        if valid and type(cached) is int and 0 <= cached <= inp
        else None,
        "reasoning_tokens": reasoning
        if valid and type(reasoning) is int and 0 <= reasoning <= out
        else None,
    }


def parse_stream(response, protocol, started):
    calls, output, usage, returned, progress = {}, [], None, None, None
    status, count = None, 0
    for line in response:
        if not line.startswith(b"data:"):
            continue
        data = line[5:].strip()
        if data == b"[DONE]":
            break
        if not data:
            continue
        count += len(data)
        if count > 16 * 1024 * 1024:
            raise ValueError("bounded probe response exceeded 16 MiB")
        event = json.loads(data)
        if event.get("error"):
            raise ValueError("upstream returned an error event")
        if protocol == "responses":
            if event.get("type", "").endswith(".delta") and event.get("delta") and progress is None:
                progress = time.monotonic() - started
            if event.get("type") in {
                "response.completed",
                "response.incomplete",
                "response.failed",
            }:
                final = event["response"]
                output, usage = final.get("output", []), final.get("usage")
                returned, status = final.get("model"), final.get("status")
        else:
            returned = event.get("model", returned)
            if event.get("usage"):
                usage = event["usage"]
            for choice in event.get("choices") or []:
                delta = choice.get("delta") or {}
                if (
                    any(delta.get(k) for k in ("content", "reasoning_content", "tool_calls"))
                    and progress is None
                ):
                    progress = time.monotonic() - started
                for call in delta.get("tool_calls") or []:
                    item = calls.setdefault(
                        call.get("index", 0), {"type": "function_call", "name": "", "arguments": ""}
                    )
                    for key in ("name", "arguments"):
                        item[key] += (call.get("function") or {}).get(key) or ""
                if choice.get("finish_reason"):
                    status = choice["finish_reason"]
    if protocol != "responses":
        output = list(calls.values())
    if status is None:
        raise ValueError("stream has no terminal response")
    return {
        "output": output,
        "usage": usage,
        "returned_model": returned,
        "status": status,
        "first_progress_seconds": progress,
    }


def validate(output, expected_tool, expected_args, schemas):
    from jsonschema import Draft202012Validator

    calls = [item for item in output if item.get("type") == "function_call"]
    result = {"call_count": len(calls), "schema_valid": False, "semantic_correct": False}
    if len(calls) != 1:
        return result
    call = calls[0]
    result["selected_tool"] = call.get("name")
    try:
        arguments = json.loads(call["arguments"])
    except (KeyError, TypeError, ValueError):
        result["failure"] = "malformed_json"
        return result
    if call.get("name") not in schemas:
        result["failure"] = "unknown_tool"
        return result
    errors = list(Draft202012Validator(schemas[call["name"]]).iter_errors(arguments))
    result["schema_valid"] = not errors
    result["error_paths"] = ["/" + "/".join(map(str, e.path)) for e in errors]
    result["arguments"] = arguments
    # 任务明确要求一个指定操作；仅忽略不改变要求的可选字段。
    result["semantic_correct"] = (
        not errors
        and call["name"] == expected_tool
        and all(arguments.get(k) == v for k, v in expected_args.items())
    )
    if expected_tool == "read_process" and "after" in arguments:
        result["semantic_correct"] = False
    return result


def assess(response, protocol, expected_tool, expected_args, schemas):
    result = validate(response["output"], expected_tool, expected_args, schemas)
    complete = (
        response["status"] == "completed"
        if protocol == "responses"
        else response["status"] in {"stop", "tool_calls"}
    )
    result["completed_response"] = complete
    if not complete:
        result["semantic_correct"] = False
        result["failure"] = "non_success_terminal"
    return result


def single(credentials, model_key, tool_definitions, case, repeat, out):
    model, protocol, _ = MODELS[model_key]
    case_id, tool, expected, instruction = case
    folder = out / f"{model_key}-{case_id}-r{repeat}"
    folder.mkdir()
    # 原生工具目录仍提供干扰选项；明确指定工具后测参数准确率，不伪称开放任务规划能力。
    prompt = f"Use {tool} exactly once. {instruction}\nReturn only the tool call."
    system = "Perform the requested single operation using the available tool contract. Do not execute extra operations."
    base = {"model": model, "stream": True, "parallel_tool_calls": True}
    if protocol == "responses":
        request = {
            **base,
            "tools": tool_definitions,
            "instructions": system,
            "input": [{"role": "user", "content": prompt}],
            "reasoning": {"effort": "medium"},
            "max_output_tokens": 8192,
        }
        suffix = "/v1/responses"
    else:
        request = {
            **base,
            "tools": [
                {"type": "function", "function": {k: v for k, v in t.items() if k != "type"}}
                for t in tool_definitions
            ],
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "reasoning_effort": "medium",
            "max_completion_tokens": 8192,
            "temperature": 1.0,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.0,
            "presence_penalty": 0.0,
            "repetition_penalty": 1.0,
            "stream_options": {"include_usage": True},
        }
        suffix = "/v1/chat/completions"
    session = "tool-contract-lab-" + uuid.uuid4().hex
    save(folder / "request.json", request)
    intent = {
        "model": model,
        "model_key": model_key,
        "protocol": protocol,
        "case": case_id,
        "repeat": repeat,
        "request_sha256": digest(request),
        "automatic_retries": 0,
        "dispatched_at": time.time(),
        "session_id": session,
    }
    save(folder / "intent.json", intent)
    endpoint = credentials["base_url"].rstrip("/")
    if endpoint.endswith("/v1"):
        endpoint = endpoint[:-3]
    http_request = urllib.request.Request(
        endpoint + suffix,
        json.dumps(request, ensure_ascii=False).encode(),
        {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + credentials["api_key"],
            "X-Session-Id": session,
            "X-Request-Id": session + "-1",
        },
    )
    started = time.monotonic()
    result = {**intent, "request_dispatched": True}
    try:
        context = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context)
        )
        with (
            opener.open(http_request, timeout=180) as response,
            (folder / "response.sse").open("wb") as raw_stream,
        ):

            def recorded_lines():
                for line in response:
                    raw_stream.write(line)
                    yield line

            raw = parse_stream(recorded_lines(), protocol, started)
        save(folder / "response.json", raw)
        result.update(usage_of(raw["usage"], protocol))
        result.update(
            assess(
                raw,
                protocol,
                tool,
                expected,
                {t["name"]: t["parameters"] for t in tool_definitions},
            )
        )
        result.update(
            status=raw["status"],
            returned_model=raw["returned_model"],
            first_progress_seconds=raw["first_progress_seconds"],
        )
    except Exception as error:
        result.update(usage_of(None, protocol))
        result.update(
            status="ERROR",
            schema_valid=False,
            semantic_correct=False,
            error_type=type(error).__name__,
            http_status=getattr(error, "code", None),
        )
        # 不记录 URL、认证材料或上游回显；完整异常类型足以区分连接与模型错误。
    result["wall_seconds"] = time.monotonic() - started
    save(folder / "result.json", result)
    return result


def summarize(rows):
    results = {}
    for model in MODELS:
        group = [r for r in rows if r["model_key"] == model]
        known = [r for r in group if r.get("total_tokens") is not None]
        cached = [r for r in known if r.get("cached_input_tokens") is not None]
        results[model] = {
            "planned": len(group),
            "schema_valid": sum(r.get("schema_valid", False) for r in group),
            "semantic_correct": sum(r.get("semantic_correct", False) for r in group),
            "known_total_tokens": sum(r["total_tokens"] for r in known),
            "known_output_tokens": sum(r["output_tokens"] for r in known),
            "unknown_usage_requests": len(group) - len(known),
            "cache_known_requests": len(cached),
            "cached_input_tokens": sum(r["cached_input_tokens"] for r in cached),
            "cache_denominator_input_tokens": sum(r["input_tokens"] for r in cached),
            "median_request_seconds": statistics.median(r["wall_seconds"] for r in group)
            if group
            else None,
        }
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--credentials", type=Path)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--case", action="append")
    parser.add_argument("--model", action="append", choices=list(MODELS))
    parser.add_argument(
        "--qwen-protocol", choices=["responses", "chat-completions"], default="responses"
    )
    args = parser.parse_args()
    MODELS["qwen"] = (MODELS["qwen"][0], args.qwen_protocol, MODELS["qwen"][2])
    from jsonschema import Draft202012Validator

    selected = [c for c in cases() if not args.case or c[0] in args.case]
    assert selected and 1 <= args.repeat <= 5
    capture = json.loads(args.capture.read_text())
    tools = normalize_tools(capture)
    names = {c[1] for c in cases()}
    tools = [t for t in tools if t["name"] in names]
    schemas = {t["name"]: t["parameters"] for t in tools}
    for _, name, expected, _ in selected:
        Draft202012Validator.check_schema(schemas[name])
        Draft202012Validator(schemas[name]).validate(expected)
        # 负控制必须被语义验证拒绝，不能只确认 gold 合法。
        assert not validate([], name, expected, schemas)["semantic_correct"]
        assert not validate(
            [{"type": "function_call", "name": name, "arguments": "{}"}], name, expected, schemas
        )["semantic_correct"]
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = {
        "case_ids": [c[0] for c in selected],
        "tool_sha256": digest(tools),
        "capture_sha256": digest(capture),
        "repeat": args.repeat,
        "models": args.model or list(MODELS),
        "protocols": {k: MODELS[k][1] for k in MODELS},
        "concurrency_per_model": {k: MODELS[k][2] for k in MODELS},
        "scope": "Conditioned tool argument probe; no native effects, no benchmark quality claims",
        "maximum_output_tokens": 8192,
        "automatic_retries": 0,
    }
    save(args.output / "manifest.json", manifest)
    if args.preflight:
        save(
            args.output / "preflight.json",
            {"pass": True, "cases": len(selected), "external_requests": 0},
        )
        print("offline preflight passed", len(selected))
        return
    assert args.credentials is not None
    assert args.credentials.stat().st_mode & 0o077 == 0, "credentials must be owner-only"
    credentials = json.loads(args.credentials.read_text())
    rows = []
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(manifest["models"])) as model_pool:

        def run_model(model_key):
            jobs = [(c, repeat) for repeat in range(args.repeat) for c in selected]
            random.Random(20261108).shuffle(jobs)
            with concurrent.futures.ThreadPoolExecutor(max_workers=MODELS[model_key][2]) as pool:
                futures = [
                    pool.submit(single, credentials, model_key, tools, case, repeat, args.output)
                    for case, repeat in jobs
                ]
                return [future.result() for future in futures]

        futures = [model_pool.submit(run_model, model) for model in manifest["models"]]
        for future in futures:
            rows.extend(future.result())
    result = {"summary": summarize(rows), "wall_seconds": time.monotonic() - started, "rows": rows}
    save(args.output / "results.json", result)
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
