#!/usr/bin/env python3
"""验证真实并行进程共享祖先容量，不调用模型。"""

import argparse
import importlib.util
import json
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location(
    "runtime_smoke", Path(__file__).with_name("runtime-smoke.py")
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def trial(binary, profile, capacity):
    with tempfile.TemporaryDirectory(prefix="areal-capacity-") as directory:
        runtime = smoke.Runtime(
            binary,
            Path(directory),
            [
                "--sandbox-profile",
                profile,
                "--allow-concurrent-writes",
                *([] if capacity is None else ["--max-processes", str(capacity)]),
            ],
        )
        try:
            runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
            expected = capacity or 4
            root = runtime.info["rootScopeId"]
            scopes = [runtime.scope() for _ in range(6)]
            processes = []
            for scope in scopes[: min(expected, 6)]:
                processes.append(runtime.start(scope, "exec sleep 20"))
            info = runtime.call("scope.get", {"scopeId": root})
            assert info["activeProcesses"] == len(processes), info
            assert info["limits"]["maxProcesses"] == expected, info
            rejected = False
            if expected == 4:
                try:
                    runtime.start(scopes[4], "exec sleep 20")
                except smoke.RpcError as error:
                    assert error.value["code"] == "RESOURCE_EXHAUSTED", error
                    rejected = True
                assert rejected, "default capacity must reject the fifth concurrent process"
            else:
                assert len(processes) == 6
            runtime.call("scope.revoke", {"scopeId": root})
            final = runtime.call("scope.waitClosed", {"scopeId": root})
            assert final["activeProcesses"] == 0, final
            return {
                "configured": capacity,
                "effective": expected,
                "simultaneousProcesses": info["activeProcesses"],
                "defaultFifthRejected": rejected,
                "afterCleanup": final["activeProcesses"],
                "profile": profile,
            }
        finally:
            runtime.close()


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument(
        "--sandbox-profile",
        choices=("native", "full-access", "outer-container-perf"),
        default="native",
    )
    args = parser.parse_args()
    binary = args.bin_dir.resolve() / "areal-runtime"
    print(json.dumps([trial(binary, args.sandbox_profile, n) for n in (None, 32)], indent=2))


if __name__ == "__main__":
    main()
