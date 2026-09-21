#!/usr/bin/env python3
"""Real Core/Runtime research agents: concurrency, boundaries, recovery and cancellation."""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

PARAMETERS = {
    "reasoning_effort": "xhigh",
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 20,
    "min_p": 0.0,
    "presence_penalty": 0.0,
    "repetition_penalty": 1.0,
}


def exercise(args, mode):
    errors, requests = [], []
    workers = 1 if mode == "single" else 3
    barrier = threading.Barrier(workers)
    release = threading.Event()
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="areal-native-agents-") as temp:
        base = Path(temp).resolve()
        repo = base / "repo"
        scratch = base / "scratch"
        data = base / "data"
        repo.mkdir()
        scratch.mkdir()
        (repo / "code.py").write_text("value = 1\n")
        # Forces project-instruction loading through the same narrowed child Scope.
        (repo / "AGENTS.md").write_text("Keep code.py focused. Run the assigned checks.\n")
        original = hashlib.sha256((repo / "code.py").read_bytes()).hexdigest()
        config_agents = {
            "maxModelRequests": 40,
            "maxToolCalls": 60,
            "maxWorkerModelRequests": 1 if mode == "budget" else 10,
            "maxWorkerToolCalls": 12,
            "workerTimeoutSeconds": 30,
        }
        (base / "tools.json").write_text(json.dumps({"agents": config_agents}))

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(request)
                    for key, value in PARAMETERS.items():
                        assert request[key] == value, (key, request.get(key))
                    messages = request["messages"]
                    results = [json.loads(m["content"]) for m in messages if m["role"] == "tool"]
                    users = [m["content"] for m in messages if m["role"] == "user"]
                    worker = any(isinstance(m, str) and m.startswith("WORKER:") for m in users)
                    names = [t["function"]["name"] for t in request["tools"]]
                    assert not any(name.startswith("agent_") for name in names), names
                    name = None
                    arguments = None
                    text = "Verified integration."
                    n = len(results)
                    if worker:
                        assert "delegate_tasks" not in names
                        prompt = "\n".join(m["content"] for m in messages if m["role"] == "system")
                        private = Path(
                            re.search(r"only under (.*?) \(also TMPDIR\)", prompt).group(1)
                        )
                        assert private.parent == scratch
                        if n == 0:
                            barrier.wait(timeout=15)
                            if mode == "async":
                                assert release.wait(15), (
                                    "parent did not progress while children were running"
                                )
                            time.sleep(0.05)
                            name = "fs_write"
                            arguments = {
                                "path": "code.py",
                                "text": "BAD\n",
                                "expectedSha256": original,
                            }
                        elif n == 1:
                            assert results[-1]["error"]["code"] == "PERMISSION_DENIED", results
                            name = "run_command"
                            if mode == "cancel":
                                script = 'import os,time; p=os.path.join(os.environ["TMPDIR"],"ticks");\nwhile True:\n with open(p,"a") as f: f.write("tick\\n")\n time.sleep(.05)'
                                arguments = {
                                    "argv": ["/usr/bin/python3", "-c", script],
                                    "yieldMs": 0,
                                }
                            else:
                                arguments = {
                                    "argv": [
                                        "/usr/bin/python3",
                                        "-c",
                                        'open("code.py","w").write("BAD")',
                                    ]
                                }
                        elif mode == "cancel":
                            time.sleep(12)
                            text = "Interrupted fixture"
                        elif n == 2:
                            assert (
                                results[-1]["state"] == "exited" and results[-1]["exitCode"] != 0
                            ), results[-1]
                            name = "verify_command"
                            arguments = {
                                "argv": [
                                    "/usr/bin/python3",
                                    "-c",
                                    'import os,time; time.sleep(.3); p=os.path.join(os.environ["TMPDIR"],"repro.txt"); open(p,"w").write("checked"); print("reproduced")',
                                ],
                                "yieldMs": 0,
                            }
                        elif results[-1].get("verification", {}).get("status") == "pending":
                            if messages[-1]["role"] != "user":
                                text = "Premature final: check is still running."
                            else:
                                assert "Verification processes" in messages[-1]["content"]
                                name = "read_process"
                                arguments = {"processId": results[-1]["processId"]}
                        else:
                            receipt = results[-1]["verification"]
                            assert receipt["status"] == "complete" and receipt["exitCode"] == 0, (
                                results[-1]
                            )
                            assert Path(receipt["receiptPath"]).is_relative_to(private)
                            assert (private / "repro.txt").read_text() == "checked"
                            text = "Independent evidence: source writes denied, private reproduction passed."
                    else:
                        assert "delegate_tasks" in names
                        if mode == "skip":
                            text = "No delegation needed for this question."
                        elif mode == "solo":
                            if n == 0:
                                name = "fs_write"
                                arguments = {
                                    "path": "code.py",
                                    "text": "value = 2\n",
                                    "expectedSha256": original,
                                }
                            else:
                                assert n == 1 and (repo / "code.py").read_text() == "value = 2\n"
                                text = "Completed directly without delegation."
                        elif n == 0:
                            name = "delegate_tasks"
                            arguments = {
                                "tasks": [
                                    "WORKER: "
                                    + str(i)
                                    + " independently inspect the fixture; keep source unchanged."
                                    for i in range(workers)
                                ]
                            }
                            if mode != "async":
                                arguments["wait"] = True
                        elif mode == "async":
                            reports = results[0]["reports"]
                            assert results[0]["asynchronous"] and len(reports) == workers
                            if n == 1:
                                assert all(r["status"] == "inProgress" for r in reports)
                                name = "run_command"
                                arguments = {
                                    "command": 'printf parent-progress > "$TMPDIR/parent-progress"'
                                }
                            elif n == 2:
                                assert (
                                    scratch / "parent-progress"
                                ).read_text() == "parent-progress"
                                assert results[-1]["commandStatus"] == "succeeded"
                                release.set()
                                name = "read_agent"
                                arguments = {"threadId": reports[0]["threadId"], "waitMs": 60000}
                            elif n < 2 + workers:
                                assert (
                                    results[-1]["status"] == "completed"
                                    and results[-1]["reportKind"] == "final"
                                ), results[-1]
                                name = "read_agent"
                                arguments = {
                                    "threadId": reports[n - 2]["threadId"],
                                    "waitMs": 60000,
                                }
                            else:
                                assert (
                                    results[-1]["status"] == "completed"
                                    and results[-1]["reportKind"] == "final"
                                ), results[-1]
                                text = "Parent made independent progress while three workers researched; final reports observed."
                        elif mode == "budget":
                            assert len(results[0]["reports"]) == workers
                            assert all(
                                r["status"] == "failed"
                                and "budget exhausted" in r["error"]["message"]
                                for r in results[0]["reports"]
                            )
                            text = "Workers exhausted their declared budgets; their failed reports were handled explicitly."
                        elif n == 1:
                            assert len(results[0]["reports"]) == workers and all(
                                r["status"] == "completed" for r in results[0]["reports"]
                            ), results
                            assert (repo / "code.py").read_text() == "value = 1\n"
                            name = "fs_write"
                            arguments = {
                                "path": "code.py",
                                "text": "value = 2\n",
                                "expectedSha256": original,
                            }
                        elif n == 2 and messages[-1]["role"] != "user":
                            text = " \n"  # empty stop after a confirmed mutation must recover without replay
                        else:
                            assert n == 2 and "no visible answer" in messages[-1]["content"]
                            text = "Integrated one source change after independent reports."
                    delta = {"content": text}
                    finish = "stop"
                    if name:
                        delta = {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": ("child" if worker else "root") + str(n),
                                    "type": "function",
                                    "function": {"name": name, "arguments": json.dumps(arguments)},
                                }
                            ]
                        }
                        finish = "tool_calls"
                    event = {
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                        "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                    }
                    body = ("data: " + json.dumps(event) + "\n\ndata: [DONE]\n\n").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    if mode != "cancel":
                        errors.append("unexpected client disconnect")
                except Exception as error:
                    errors.append(repr(error))
                    self.send_error(400)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        sampling = "\n".join(f"{key} = {json.dumps(value)}" for key, value in PARAMETERS.items())
        config = f"""schema_version = 1
[model]
name = "fixture"
{sampling}
max_retries = 0
max_output_tokens = 32000
[model.providers.default]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:{server.server_port}/v1/chat/completions"
api_key_env = "AREAL_API_KEY"
[limits]
turn_timeout_seconds = {5 if mode == "cancel" else 60}
max_completion_retries = 2
max_children_per_turn = 3
max_agent_depth = 1
model_concurrency = 4
max_active_turns = 4
[tools]
extensions_file = "tools.json"
"""
        (base / "config.toml").write_text(config)
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith("AREAL_HARNESS_")
            and k not in {"AREAL_MODEL", "AREAL_MODEL_ENDPOINT", "AREAL_MODEL_PROTOCOL"}
        }
        env["HOME"] = str(base / "user")
        env.update(AREAL_API_KEY="fixture-only", AREAL_HARNESS_HOME=str(base / "home"))
        try:
            done = subprocess.run(
                [
                    sys.executable,
                    str(root / "scripts/launch.py"),
                    "--bin-dir",
                    str(args.bin_dir.resolve()),
                    "--tui",
                    "--sandbox-profile",
                    args.sandbox_profile,
                    "--config",
                    str(base / "config.toml"),
                    "--workspace",
                    str(repo),
                    "--scratch",
                    str(scratch),
                    "--data-dir",
                    str(data),
                    "--allow-write",
                    "--allow-concurrent-writes",
                    "--prompt",
                    "Resolve the fixture task using whichever tools are useful.",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=90,
            )
            if args.evidence_dir:
                destination = args.evidence_dir / mode
                shutil.copytree(base, destination, dirs_exist_ok=True)
                (destination / "client-output.log").write_text(done.stdout + done.stderr)
                (destination / "fixture-requests.json").write_text(json.dumps(requests, indent=2))
            assert not errors, errors
            threads = [json.loads(p.read_text())["thread"] for p in data.glob("*.json")]
            if mode in ("skip", "solo"):
                assert len(threads) == 1 and done.returncode == 0, (
                    threads,
                    done.stdout + done.stderr,
                )
                assert threads[0]["turns"][-1]["status"] == "completed"
                assert (repo / "code.py").read_text() == (
                    "value = 2\n" if mode == "solo" else "value = 1\n"
                )
                assert len(requests) == (2 if mode == "solo" else 1)
                print(
                    json.dumps(
                        {
                            "native_agents_smoke": mode,
                            "status": "passed",
                            "threads": 1,
                            "requests": len(requests),
                            "delegation_optional": True,
                            "seven_parameters_match": True,
                        }
                    )
                )
                return
            assert len(threads) == 1 + workers, (
                len(threads),
                done.stdout[-3000:] + done.stderr[-3000:],
            )
            children = [t for t in threads if t.get("parentThreadId")]
            assert len(children) == workers and all(
                t["source"] == "nativeResearchAgent" for t in children
            )
            assert all(t["turns"][-1]["status"] != "inProgress" for t in threads)
            if mode == "cancel":
                assert done.returncode != 0
                ticks = list(scratch.glob("agent-*/ticks"))
                assert len(ticks) == workers
                sizes = [p.stat().st_size for p in ticks]
                time.sleep(0.3)
                assert sizes == [p.stat().st_size for p in ticks], (
                    "cancelled descendants still write"
                )
            else:
                assert done.returncode == 0, done.stdout[-4000:] + done.stderr[-4000:]
                assert (repo / "code.py").read_text() == (
                    "value = 2\n" if mode in ("happy", "single") else "value = 1\n"
                )
            audits = [
                json.loads(line)
                for line in (data / "model-requests/requests.jsonl").read_text().splitlines()
            ]
            assert {a["threadId"] for a in audits} == {t["id"] for t in threads}
            for audit in audits:
                for key, value in PARAMETERS.items():
                    assert audit["parameters"][key] == value
            boundaries = []
            for audit in audits:
                start = audit["startedAtUnixMs"]
                boundaries.extend([(start, 1), (start + audit["durationMs"], -1)])
            active = 0
            maximum = 0
            for _, delta in sorted(boundaries):
                active += delta
                maximum = max(maximum, active)
            assert maximum >= workers, ("model calls did not overlap", maximum)
            if mode == "async":
                assert maximum == workers + 1, ("parent/worker inference did not overlap", maximum)
                assert (scratch / "parent-progress").is_file()
            if mode in ("happy", "single"):
                events = [json.loads(p.read_text()) for p in (data / "audit").glob("*.json")]
                assert (
                    sum(
                        e.get("error", "") == "verification process has not been observed to finish"
                        for e in events
                    )
                    == workers
                )
                assert (
                    sum(
                        e.get("error", "") == "model stopped without visible output or tool calls"
                        for e in events
                    )
                    == 1
                )
                root_thread = next(t for t in threads if not t.get("parentThreadId"))
                writes = [
                    i
                    for t in root_thread["turns"]
                    for i in t["items"]
                    if i.get("tool") == "fs_write"
                ]
                assert len(writes) == 1
            print(
                json.dumps(
                    {
                        "native_agents_smoke": mode,
                        "status": "passed",
                        "threads": len(threads),
                        "requests": len(audits),
                        "max_overlapping_requests": maximum,
                        "seven_parameters_match": True,
                    }
                )
            )
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join()


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument(
        "--sandbox-profile", choices=["native", "outer-container-perf"], default="native"
    )
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument(
        "--mode",
        choices=["all", "skip", "solo", "single", "happy", "budget", "cancel", "async"],
        default="all",
    )
    args = parser.parse_args()
    for mode in (
        ["skip", "solo", "single", "happy", "budget", "cancel", "async"]
        if args.mode == "all"
        else [args.mode]
    ):
        exercise(args, mode)


if __name__ == "__main__":
    main()
