#!/usr/bin/env python3
"""按需加载 MCP schema（policy.lazyMcpSchemas）真实模型对照。

同一模型、同一任务、同一组 48 个 MCP 工具，分别在关/开两组下运行，记录
成功率、token、轮数和耗时。全部状态写进 --out 下的隔离目录，不碰 ~/.areal。

用法见 make lazy-mcp-compare；--serve 是内部入口，作为对照用的 stdio MCP 服务。
"""

import argparse
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

SERVER = "bench"
PREFIX = f"mcp__{SERVER}__"


def tool(tool_name, description, **params):
    required = [k for k, v in params.items() if not v.get("optional")]
    props = {k: {kk: vv for kk, vv in v.items() if kk != "optional"} for k, v in params.items()}
    return {
        "name": tool_name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": False,
        },
    }


def S(description, **extra):
    return {"type": "string", "description": description, **extra}


def N(description, **extra):
    return {"type": "integer", "description": description, **extra}


OPT = {"optional": True}

# 8 个领域 × 6 个工具。名称相近的工具是干扰项，检验模型能否在目录里找准。
TOOLS = [
    tool(
        "crm_find_customer",
        "Find a CRM customer by email address. Returns the customer_id.",
        email=S("Customer email"),
    ),
    tool("crm_get_account", "Get a CRM account profile by account id.", account_id=S("Account id")),
    tool(
        "crm_list_opportunities",
        "List open sales opportunities for an account.",
        account_id=S("Account id"),
        stage=S("Pipeline stage", **OPT),
    ),
    tool(
        "crm_update_contact",
        "Update a contact's phone or title.",
        customer_id=S("Customer id"),
        phone=S("Phone", **OPT),
        title=S("Job title", **OPT),
    ),
    tool(
        "crm_log_activity",
        "Log a call, meeting or email activity against a customer.",
        customer_id=S("Customer id"),
        kind=S("call|meeting|email"),
        note=S("Free text"),
    ),
    tool(
        "crm_search_notes",
        "Full-text search across CRM notes.",
        query=S("Search text"),
        limit=N("Max results", **OPT),
    ),
    tool("billing_get_invoice", "Get one invoice by invoice id.", invoice_id=S("Invoice id")),
    tool(
        "billing_list_invoices",
        "List invoices for a customer, optionally filtered by status.",
        customer_id=S("Customer id"),
        status=S("paid|open|void", **OPT),
    ),
    tool(
        "billing_refund",
        "Issue a refund against an invoice.",
        invoice_id=S("Invoice id"),
        amount_cents=N("Amount in cents"),
    ),
    tool(
        "billing_get_subscription",
        "Get the active subscription plan for a customer.",
        customer_id=S("Customer id"),
    ),
    tool(
        "billing_apply_coupon",
        "Apply a coupon code to a customer's subscription.",
        customer_id=S("Customer id"),
        code=S("Coupon code"),
    ),
    tool(
        "billing_tax_rate",
        "Look up the VAT/sales tax rate for a region code.",
        region=S("ISO region code, e.g. DE"),
    ),
    tool(
        "cal_list_events",
        "List calendar events in a date range.",
        start=S("ISO date"),
        end=S("ISO date"),
    ),
    tool(
        "cal_create_event",
        "Create a calendar event.",
        title=S("Title"),
        start=S("ISO datetime"),
        duration_minutes=N("Duration"),
    ),
    tool(
        "cal_find_free_slot",
        "Find the first free slot shared by attendees.",
        attendees=S("Comma-separated usernames"),
        duration_minutes=N("Duration"),
    ),
    tool("cal_get_event", "Get a calendar event by id.", event_id=S("Event id")),
    tool(
        "cal_cancel_event",
        "Cancel a calendar event.",
        event_id=S("Event id"),
        reason=S("Reason", **OPT),
    ),
    tool("cal_list_rooms", "List bookable meeting rooms in an office.", office=S("Office name")),
    tool("docs_search", "Search wiki pages by keyword.", query=S("Search text")),
    tool("docs_get_page", "Get the current content of a wiki page.", page_id=S("Page id")),
    tool(
        "docs_create_page",
        "Create a wiki page in a space.",
        space=S("Space key"),
        title=S("Title"),
        body=S("Markdown body"),
    ),
    tool("docs_list_spaces", "List wiki spaces the caller can read."),
    tool("docs_get_attachments", "List attachments on a wiki page.", page_id=S("Page id")),
    tool(
        "docs_page_history",
        "Get the edit history (revisions and authors) of a wiki page.",
        page_id=S("Page id"),
    ),
    tool("deploy_list_services", "List deployable services."),
    tool(
        "deploy_get_status",
        "Get the rollout status of a service in an environment.",
        service=S("Service name"),
        env=S("staging|production"),
    ),
    tool(
        "deploy_rollback",
        "Roll a service back to a previous release.",
        service=S("Service name"),
        release_id=S("Release id"),
    ),
    tool(
        "deploy_get_logs",
        "Fetch deploy logs for one release of a service.",
        service=S("Service name"),
        release_id=S("Release id"),
    ),
    tool(
        "deploy_list_releases",
        "List releases of a service, newest first. Returns latest_release_id.",
        service=S("Service name"),
    ),
    tool(
        "deploy_get_config",
        "Get the runtime configuration of a service.",
        service=S("Service name"),
        env=S("staging|production"),
    ),
    tool(
        "metrics_query",
        "Run a metrics query over a time window.",
        metric=S("Metric name"),
        window=S("e.g. 1h, 24h"),
    ),
    tool("metrics_list_dashboards", "List metrics dashboards."),
    tool("metrics_get_alert", "Get one alert rule by id.", alert_id=S("Alert id")),
    tool(
        "metrics_list_alerts",
        "List alert rules, optionally only firing ones.",
        firing=S("true|false", **OPT),
    ),
    tool(
        "metrics_silence_alert",
        "Silence an alert for a duration.",
        alert_id=S("Alert id"),
        minutes=N("Minutes"),
    ),
    tool(
        "metrics_get_slo",
        "Get the SLO target and current error budget of a service.",
        service=S("Service name"),
    ),
    tool("tickets_search", "Search support tickets by text.", query=S("Search text")),
    tool("tickets_get", "Get one support ticket by id.", ticket_id=S("Ticket id")),
    tool(
        "tickets_create",
        "Create a support ticket.",
        title=S("Title"),
        body=S("Body"),
        queue=S("Queue name"),
    ),
    tool(
        "tickets_comment", "Add a comment to a ticket.", ticket_id=S("Ticket id"), body=S("Comment")
    ),
    tool(
        "tickets_assign",
        "Assign a ticket to an agent.",
        ticket_id=S("Ticket id"),
        assignee=S("Username"),
    ),
    tool("tickets_list_queues", "List support queues."),
    tool("geo_lookup_city", "Resolve a city name to a city_id.", name=S("City name")),
    tool("weather_current", "Current weather for a city id.", city_id=S("City id")),
    tool(
        "weather_forecast",
        "Multi-day weather forecast for a city id.",
        city_id=S("City id"),
        days=N("Number of days, 1-7"),
    ),
    tool("geo_timezone", "IANA timezone of a city id.", city_id=S("City id")),
    tool(
        "geo_distance",
        "Distance in km between two city ids.",
        from_city_id=S("City id"),
        to_city_id=S("City id"),
    ),
    tool(
        "weather_alerts", "Active severe weather alerts for a region code.", region=S("Region code")
    ),
]
SCHEMAS = {t["name"]: t for t in TOOLS}


def norm(value):
    return str(value).strip().lower()


def digest(*parts, size=8):
    return hashlib.sha256("\x1f".join(norm(p) for p in parts).encode()).hexdigest()[:size].upper()


def ref(name, args):
    """每次调用的确定性回执码：只取必填参数，大小写与空白不敏感。"""
    keys = SCHEMAS[name]["inputSchema"]["required"]
    return "R" + digest(name, *[f"{k}={args.get(k, '')}" for k in keys])


# 返回给模型的额外字段：多步任务靠它拿到下一步要的 id。
IDS = {
    "crm_find_customer": lambda a: {
        "customer_id": "CUS" + digest("cus", a.get("email", ""), size=6)
    },
    "geo_lookup_city": lambda a: {"city_id": "C" + digest("city", a.get("name", ""), size=6)},
    "deploy_list_releases": lambda a: {
        "latest_release_id": "REL" + digest("rel", a.get("service", ""), size=6)
    },
}

# 每个任务：提示词、期望调用序列（工具名, 必填参数）。最后一次调用的回执码必须出现在答复里。
TASKS = {
    "deploy_status": (
        "What is the rollout status of the checkout service in production?",
        [("deploy_get_status", {"service": "checkout", "env": "production"})],
    ),
    "slo": (
        "What is the SLO target of the search service?",
        [("metrics_get_slo", {"service": "search"})],
    ),
    "ticket": ("Show me support ticket T-4821.", [("tickets_get", {"ticket_id": "T-4821"})]),
    "page_history": (
        "Who has edited wiki page P-77? I need its revision history, not its content.",
        [("docs_page_history", {"page_id": "P-77"})],
    ),
    "tax": ("What VAT rate applies in region DE?", [("billing_tax_rate", {"region": "DE"})]),
    "forecast": (
        "Give me the 3-day weather forecast for Lisbon.",
        [
            ("geo_lookup_city", {"name": "Lisbon"}),
            (
                "weather_forecast",
                {"city_id": IDS["geo_lookup_city"]({"name": "Lisbon"})["city_id"], "days": 3},
            ),
        ],
    ),
    "subscription": (
        "Which subscription plan is the customer ada@example.com on?",
        [
            ("crm_find_customer", {"email": "ada@example.com"}),
            (
                "billing_get_subscription",
                {
                    "customer_id": IDS["crm_find_customer"]({"email": "ada@example.com"})[
                        "customer_id"
                    ]
                },
            ),
        ],
    ),
    "release_logs": (
        "Fetch the deploy logs of the latest release of the api service.",
        [
            ("deploy_list_releases", {"service": "api"}),
            (
                "deploy_get_logs",
                {
                    "service": "api",
                    "release_id": IDS["deploy_list_releases"]({"service": "api"})[
                        "latest_release_id"
                    ],
                },
            ),
        ],
    ),
}
SUFFIX = (
    "\n\nUse the available tools; do not guess. Each tool result contains a field named ref. "
    "End your answer with one line exactly of the form `REF: <ref>` using the ref from the last tool result you relied on."
)


def serve(log):
    for line in sys.stdin:
        request = json.loads(line)
        method, params = request.get("method"), request.get("params") or {}
        if "id" not in request:
            continue
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        if method == "initialize":
            reply["result"] = {
                "protocolVersion": "2025-11-25",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER, "version": "1"},
            }
        elif method == "tools/list":
            reply["result"] = {"tools": TOOLS}
        elif method == "ping":
            reply["result"] = {}
        elif method == "tools/call" and params.get("name") in SCHEMAS:
            name, args = params["name"], params.get("arguments") or {}
            body = {
                "ok": True,
                "tool": name,
                **IDS.get(name, lambda a: {})(args),
                "ref": ref(name, args),
            }
            with open(log, "a") as f:
                f.write(json.dumps({"tool": name, "arguments": args}) + "\n")
            reply["result"] = {"content": [{"type": "text", "text": json.dumps(body)}]}
        else:
            reply["error"] = {"code": -32601, "message": "Method not found"}
        print(json.dumps(reply), flush=True)


def matches(call, expected):
    name, args = expected
    return call["tool"] == name and all(
        norm(call["arguments"].get(k, "")) == norm(v) for k, v in args.items()
    )


def parse(lines):
    calls, errors, result = [], [], None
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event["message"].get("content", []):
                if block.get("type") == "tool_use":
                    raw = block.get("input")
                    if isinstance(raw, str):
                        try:
                            raw = json.loads(raw or "{}")
                        except json.JSONDecodeError:
                            raw = {"_raw": raw}
                    calls.append(
                        {"tool": block["name"].removeprefix(PREFIX), "arguments": raw or {}}
                    )
        elif event.get("type") == "user":
            for block in event["message"].get("content", []):
                if block.get("type") == "tool_result" and block.get("is_error"):
                    errors.append(
                        " ".join(c.get("text", "") for c in block.get("content", []))[:200]
                    )
        elif event.get("type") == "result":
            result = event
    return calls, errors, result


def score(task, calls, result):
    expected = TASKS[task][1]
    found = all(any(matches(c, e) for c in calls) for e in expected)
    text = (result or {}).get("result") or ""
    answered = f"REF: {ref(*expected[-1])}".lower() in text.lower()
    return found and answered and not (result or {}).get("is_error", True)


def run_once(args, arm, task, home, extensions, workspace, model_env):
    prompt = TASKS[task][0] + SUFFIX
    # 两组都用默认工具集和默认权限；无人值守时需审批的操作直接拒绝，不会改动工作区外的东西。
    command = [
        args.areal,
        "exec",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-name",
        "--workspace",
        str(workspace),
        "--max-turns",
        str(args.max_turns),
    ]
    if args.model:
        command += ["--model", args.model]
    command.append(prompt)
    env = {
        **model_env,
        "AREAL_HARNESS_HOME": str(home),
        "AREAL_HARNESS_SERVICE_HOME": str(home),
        "AREAL_CORE_HOME": str(home / "core"),
        "AREAL_HARNESS_TOOL_EXTENSIONS": str(extensions),
    }
    logs = home.parent / "logs"
    logs.mkdir(exist_ok=True)
    stem = logs / f"{len(list(logs.glob('*.out'))):03d}-{task}-{arm}"
    started = time.monotonic()
    # 输出写文件而非管道：首次运行会拉起常驻 Host，它继承的句柄会让管道永远等不到结束。
    with open(f"{stem}.out", "w") as out, open(f"{stem}.err", "w") as err:
        process = subprocess.Popen(
            command, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err
        )
        try:
            code = process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            code = -1
    stdout, stderr = Path(f"{stem}.out").read_text(), Path(f"{stem}.err").read_text()
    if code == -1:
        stderr += "\nTIMEOUT"
    calls, errors, result = parse(stdout.splitlines())
    usage = (result or {}).get("usage") or {}
    return {
        "arm": arm,
        "task": task,
        "exit": code,
        "success": score(task, calls, result),
        "input_tokens": usage.get("input_tokens"),
        "cached_input_tokens": usage.get("cache_read_input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "num_turns": (result or {}).get("num_turns"),
        "duration_ms": round((time.monotonic() - started) * 1000),
        "search_calls": sum(c["tool"] == "mcp_tool_search" for c in calls),
        "mcp_calls": sum(c["tool"] in SCHEMAS for c in calls),
        "schema_not_offered": sum("MCP_SCHEMA_NOT_OFFERED" in e for e in errors),
        "tool_errors": errors,
        "calls": calls,
        "answer": ((result or {}).get("result") or "")[-300:],
        "stderr_tail": stderr[-600:] if code else "",
    }


def summarize(rows):
    def stat(values):
        values = [v for v in values if isinstance(v, (int, float))]
        return (
            {"mean": round(statistics.mean(values), 1), "median": statistics.median(values)}
            if values
            else None
        )

    arms = {}
    for arm in ("off", "on"):
        group = [r for r in rows if r["arm"] == arm]
        if not group:
            continue
        arms[arm] = {
            "runs": len(group),
            "success_rate": round(sum(r["success"] for r in group) / len(group), 3),
            **{
                k: stat([r[k] for r in group])
                for k in (
                    "input_tokens",
                    "cached_input_tokens",
                    "output_tokens",
                    "num_turns",
                    "duration_ms",
                    "search_calls",
                    "schema_not_offered",
                )
            },
        }
    tasks = {
        task: {
            arm: f"{sum(r['success'] for r in rows if r['task'] == task and r['arm'] == arm)}/{sum(1 for r in rows if r['task'] == task and r['arm'] == arm)}"
            for arm in ("off", "on")
        }
        for task in dict.fromkeys(r["task"] for r in rows)
    }
    return {"arms": arms, "tasks": tasks}


def report(summary):
    lines = ["| 指标 | 关 | 开 |", "| --- | --- | --- |"]
    off, on = summary["arms"].get("off", {}), summary["arms"].get("on", {})
    lines.append(f"| 运行次数 | {off.get('runs')} | {on.get('runs')} |")
    lines.append(f"| 成功率 | {off.get('success_rate')} | {on.get('success_rate')} |")
    for key, label in (
        ("input_tokens", "输入 token 均值"),
        ("cached_input_tokens", "缓存命中 token 均值"),
        ("output_tokens", "输出 token 均值"),
        ("num_turns", "模型轮数均值"),
        ("duration_ms", "耗时 ms 均值"),
        ("search_calls", "搜索调用均值"),
        ("schema_not_offered", "同批未加载报错均值"),
    ):
        lines.append(
            f"| {label} | {(off.get(key) or {}).get('mean')} | {(on.get(key) or {}).get('mean')} |"
        )
    lines += ["", "| 任务 | 关 | 开 |", "| --- | --- | --- |"]
    lines += [f"| {t} | {v['off']} | {v['on']} |" for t, v in summary["tasks"].items()]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--serve", metavar="LOG", help=argparse.SUPPRESS)
    parser.add_argument(
        "--areal", default=shutil.which("areal") or "areal", help="areal 可执行文件（默认取 PATH）"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path.home() / ".areal" / "config.toml",
        help="模型配置；只复制进隔离目录，不改原文件",
    )
    parser.add_argument("--model", help="覆盖配置里的模型")
    parser.add_argument("--repeats", type=int, default=3, help="每个任务每组的次数")
    parser.add_argument("--tasks", default=",".join(TASKS), help="逗号分隔的任务名")
    parser.add_argument("--max-turns", type=int, default=12)
    parser.add_argument("--timeout", type=int, default=300, help="单次运行秒数上限")
    parser.add_argument("--out", type=Path, default=Path("lazy-mcp-compare-out"))
    args = parser.parse_args()
    if args.serve:
        return serve(args.serve)

    tasks = [t for t in args.tasks.split(",") if t]
    unknown = [t for t in tasks if t not in TASKS]
    if unknown:
        parser.error(f"unknown tasks: {unknown}")
    out = args.out.resolve()
    if out.exists() and any(out.iterdir()):
        parser.error(f"{out} is not empty; choose a new --out")
    home = out / "areal-home"
    home.mkdir(parents=True)
    if args.config.exists():
        shutil.copyfile(args.config, home / "config.toml")
    script = Path(__file__).resolve()
    # 每组一个工作区和固定的扩展文件，项目服务在组内复用，组间配置互不影响。
    setups = {}
    for arm in ("off", "on"):
        workspace = out / f"workspace-{arm}"
        workspace.mkdir()
        extensions = out / f"extensions-{arm}.json"
        server = {
            "transport": {
                "type": "stdio",
                "command": sys.executable,
                "args": [str(script), "--serve", str(out / f"mcp-calls-{arm}.jsonl")],
                "cwd": str(workspace),
                "envVars": [],
            },
            "startupTimeoutMs": 30000,
        }
        extensions.write_text(
            json.dumps({"policy": {"lazyMcpSchemas": arm == "on"}, "mcpServers": {SERVER: server}})
        )
        setups[arm] = (extensions, workspace)
    model_env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("AREAL_HARNESS_") and k != "AREAL_CORE_HOME"
    }

    rows = []
    with open(out / "runs.jsonl", "w") as sink:
        for repeat in range(args.repeats):
            for index, task in enumerate(tasks):
                # 交替先后，抵消缓存预热和服务端波动对某一组的偏向。
                order = ("off", "on") if (repeat + index) % 2 == 0 else ("on", "off")
                for arm in order:
                    row = run_once(args, arm, task, home, *setups[arm], model_env)
                    row["repeat"] = repeat
                    rows.append(row)
                    sink.write(json.dumps(row, ensure_ascii=False) + "\n")
                    sink.flush()
                    print(
                        f"[{repeat + 1}/{args.repeats}] {task:14} {arm:3} success={row['success']} in={row['input_tokens']} turns={row['num_turns']} search={row['search_calls']} exit={row['exit']}",
                        flush=True,
                    )
                    if row["exit"] and row["stderr_tail"]:
                        print("  " + row["stderr_tail"].strip().splitlines()[-1], flush=True)
    subprocess.run(
        [args.areal, "host", "stop", "--cancel"],
        env={**model_env, "AREAL_HARNESS_HOME": str(home), "AREAL_HARNESS_SERVICE_HOME": str(home)},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=60,
    )

    summary = summarize(rows)
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    (out / "summary.md").write_text(report(summary) + "\n")
    print("\n" + report(summary))
    print(f"\n结果目录：{out}（把 summary.json 和 runs.jsonl 发回即可）")


if __name__ == "__main__":
    sys.exit(main())
