import json
import os
import time
from pathlib import Path

import lldb

root = Path(os.environ["AREAL_T18_LLDB_ROOT"])
process = lldb.debugger.GetSelectedTarget().GetProcess()
deadline = time.monotonic() + 75
ready = False
hit = False
result = {"action": None, "success": False}


def publish(name, value):
    path = root / name
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


try:
    while time.monotonic() < deadline:
        state = process.GetState()
        if state == lldb.eStateRunning and not ready:
            publish("lldb-ready.json", {"state": "running"})
            ready = True
        if state == lldb.eStateStopped and ready and not hit:
            threads = [process.GetThreadAtIndex(i) for i in range(process.GetNumThreads())]
            matches = [
                thread
                for thread in threads
                if thread.GetStopReason() == lldb.eStopReasonBreakpoint
                and thread.GetStopReasonDataAtIndex(0) == 1
                and thread.GetStopReasonDataAtIndex(1) == 1
            ]
            if not matches:
                raise RuntimeError("Host stopped for an unexpected reason")
            publish(
                "lldb-hit.json",
                {
                    "state": "stopped",
                    "pid": process.GetProcessID(),
                    "breakpoint": 1,
                    "location": 1,
                    "threads": len(threads),
                },
            )
            hit = True
        decision = root / "lldb-decision"
        if decision.exists():
            action = decision.read_text()
            if action == "kill" and hit:
                error = process.Kill()
            elif action == "abort":
                if state == lldb.eStateRunning:
                    error = process.Stop()
                    if not error.Success():
                        raise RuntimeError("stop failed: " + str(error))
                    while process.GetState() != lldb.eStateStopped and time.monotonic() < deadline:
                        time.sleep(0.02)
                error = process.Detach()
            else:
                raise RuntimeError("invalid debugger decision")
            result = {"action": action, "success": error.Success(), "error": str(error)}
            if not error.Success():
                raise RuntimeError("debugger action failed: " + str(error))
            break
        time.sleep(0.02)
    else:
        raise RuntimeError("debugger controller deadline")
except Exception as error:
    result["failure"] = str(error)
finally:
    if not result["success"]:
        if process.GetState() == lldb.eStateRunning:
            process.Stop()
            until = time.monotonic() + 5
            while process.GetState() != lldb.eStateStopped and time.monotonic() < until:
                time.sleep(0.02)
        detached = process.Detach()
        result["fallbackDetach"] = detached.Success()
        result["fallbackError"] = str(detached)
    publish("lldb-result.json", result)
