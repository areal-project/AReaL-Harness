#!/usr/bin/env python3
"""验证 macOS 系统 Git helper 的权限边界；只查询随机不存在的条目，不读写真实凭据。"""

import argparse
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("runtime_smoke", ROOT / "scripts/runtime-smoke.py")
RUNTIME_SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME_SMOKE)


def check(binary):
    helper = (
        Path(subprocess.check_output(["/usr/bin/git", "--exec-path"], text=True).strip())
        / "git-credential-osxkeychain"
    )
    assert helper.is_file(), "系统 Git 缺少 osxkeychain helper"
    # 每次使用唯一域名与账户，绝不发网络请求，也不枚举或输出已有凭据。
    identity = uuid.uuid4().hex
    query = f"protocol=https\nhost=areal-{identity}.invalid\nusername=areal-{identity}\n\n"
    command = f"printf %s {shlex.quote(query)} | {shlex.quote(str(helper))} get"
    cases = [
        ("full-access", False, None, True),
        ("native", False, None, False),
        ("full-access", True, None, False),
        ("full-access", False, "network", False),
        ("full-access", False, "writes", False),
    ]
    checks = []
    with tempfile.TemporaryDirectory(prefix="areal-keychain-") as directory:
        root = Path(directory)
        workspace, home, scratch = (root / name for name in ("repo", "home", "scratch"))
        for path in [workspace, home, scratch]:
            path.mkdir()
        for profile, protected, narrowed, allowed in cases:
            args = [
                "--sandbox-profile",
                profile,
                "--allow-network",
                "--scratch",
                str(scratch),
                "--wall-time-ms",
                "10000",
            ]
            if protected:
                args += ["--read-only-path", str(home)]
            runtime = RUNTIME_SMOKE.Runtime(
                binary,
                workspace,
                args,
                env={"PATH": "/usr/bin:/bin", "HOME": str(home)},
            )
            try:
                runtime.info = runtime.call(
                    "connection.open", {"protocolVersion": "areal.runtime.v0"}
                )
                scope = runtime.info["rootScopeId"]
                if narrowed:
                    permissions = (
                        {"network": "deny"}
                        if narrowed == "network"
                        else {"writeRoots": ["workspace://repo", "workspace://scratch"]}
                    )
                    scope = runtime.call(
                        "scope.create",
                        {
                            "operationId": runtime.op(),
                            "parentScopeId": scope,
                            "owner": {"taskId": "keychain-fixture"},
                            "permissions": permissions,
                        },
                    )["scopeId"]
                process = runtime.start(scope, command)
                result = runtime.call("process.wait", {"processId": process})
                output = RUNTIME_SMOKE.text(runtime.output(process)).decode()
                label = f"{profile}/protected={protected}/narrowed={narrowed}"
                # 错误报告也不输出 helper 返回的任意 credential 字段。
                assert "password=" not in output and "username=" not in output, (
                    f"{label}: 随机不存在的条目意外匹配；已隐藏输出"
                )
                assert result["cleanupConfirmed"], f"{label}: 进程回收未确认"
                if allowed:
                    assert result["exitCode"] == 0 and not output, (
                        f"{label}: 宿主 Keychain 查询不可用，exit={result['exitCode']}；"
                        "需要可用的 macOS 登录会话，不能将环境不可用记为通过"
                    )
                else:
                    assert result["exitCode"] not in (None, 0), label
                    assert "failed to get:" in output, f"{label}: 未到达预期 helper 拒绝路径"
                checks.append(
                    {
                        "profile": profile,
                        "protected": protected,
                        "narrowed": narrowed,
                        "exitCode": result["exitCode"],
                        "keychainQueryAllowed": allowed,
                        "keychainErrorMinus50": "failed to get: -50" in output,
                        "cleanupConfirmed": True,
                    }
                )
            finally:
                runtime.close()
    return {"checks": checks, "credentialReads": False, "credentialWrites": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, default=ROOT / "target/debug")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("该检查只适用于具有登录会话的 macOS；不把其他平台记为通过")
    report = check(args.bin_dir.resolve() / "areal-runtime")
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(serialized + "\n")
    print(serialized)


if __name__ == "__main__":
    main()
