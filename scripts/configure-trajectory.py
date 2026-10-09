#!/usr/bin/env python3
"""持久配置本地轨迹导出；仅修改 [trajectory]，不启动 Agent 或修改模型。"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib

# 可编辑默认值；建议凭据通过 --headers-env 读取，避免将秘密写入脚本或命令行。
# None 保留已有开关；首次配置默认关闭。设为 True/False 可显式改变脚本默认动作。
DEFAULT_ENABLED = None
DEFAULT_ENDPOINT = ""
DEFAULT_HEADERS = ""
DEFAULTS = {
    "max_disk_bytes": 256 * 1024 * 1024,
    "max_memory_bytes": 16 * 1024 * 1024,
    "max_batch_bytes": 4 * 1024 * 1024,
    "max_records": 2000,
    "max_retries": 6,
    "retry_initial_seconds": 5,
    "retry_max_seconds": 300,
    "request_timeout_seconds": 10,
    "upload_interval_ms": 1000,
}
MAX_CONFIG_BYTES = 1024 * 1024


class ConfigurationError(ValueError):
    """仅包含可直接展示的固定错误说明。"""


def regular_text(path, limit=MAX_CONFIG_BYTES):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ConfigurationError("配置和凭据必须是普通文件，不能使用符号链接或硬链接")
        if metadata.st_size > limit:
            raise ConfigurationError("配置或凭据文件过大")
        return stream.read(limit + 1)


def atomic_private(path, text):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, pending = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)


def table_headers(text):
    """只识别字符串外的表头，避免误改模型提示词中的同名文本。"""
    quote = None
    offset = 0
    for line in text.splitlines(keepends=True):
        if quote is None and re.match(r"^\s*\[", line):
            match = re.match(r"^\s*(\[.*?\])\s*(?:#.*)?(?:\r?\n)?$", line)
            if match:
                yield offset, match.group(1)
        index = 0
        while index < len(line):
            if quote in ('"""', "'''"):
                if quote == '"""' and line[index] == "\\":
                    index += 2
                elif line.startswith(quote, index):
                    # TOML 多行字符串可用四/五个引号结束，额外引号属于字符串内容。
                    marker = quote[0]
                    while index < len(line) and line[index] == marker:
                        index += 1
                    quote = None
                else:
                    index += 1
            elif quote:
                if quote == '"' and line[index] == "\\":
                    index += 2
                elif line[index] == quote:
                    quote = None
                    index += 1
                else:
                    index += 1
            elif line[index] == "#":
                break
            elif line[index] in ('"', "'"):
                quote = line[index] * (3 if line.startswith(line[index] * 3, index) else 1)
                index += len(quote)
            else:
                index += 1
        offset += len(line)


def replace_trajectory(text, values):
    parsed = tomllib.loads(text)
    if parsed.get("schema_version") not in (1, 2):
        raise ConfigurationError("原配置必须使用 schema_version = 1 或 2")
    body = "[trajectory]\n" + "".join(
        f"{key} = {json.dumps(value, ensure_ascii=False)}\n" for key, value in values.items()
    )
    headers = list(table_headers(text))
    selected = []
    for index, (start, header) in enumerate(headers):
        declaration = tomllib.loads(header + "\n")
        if "trajectory" in declaration:
            if declaration != {"trajectory": {}}:
                raise ConfigurationError("请先将轨迹配置整理为单独的 [trajectory] 表")
            selected.append(
                (start, headers[index + 1][0] if index + 1 < len(headers) else len(text))
            )
    if len(selected) > 1 or ("trajectory" in parsed and not selected):
        raise ConfigurationError("请先将轨迹配置整理为单独的 [trajectory] 表")
    if selected:
        start, end = selected[0]
        result = text[:start] + body + "\n" + text[end:]
    else:
        result = text.rstrip() + "\n\n" + body
    desired = dict(parsed)
    desired["trajectory"] = values
    if tomllib.loads(result) != desired:
        raise ConfigurationError("配置写入校验失败，原文件保持不变")
    return result


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, help="独立 AREAL_HARNESS_HOME，默认 ~/.areal")
    parser.add_argument(
        "--config", type=Path, help="指定完整配置文件，默认遵循 AREAL_HARNESS_CONFIG"
    )
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--enable", action="store_true")
    action.add_argument("--disable", action="store_true")
    parser.add_argument("--endpoint", help="OTLP HTTP/protobuf 基地址，自动追加 /v1/logs")
    spool = parser.add_mutually_exclusive_group()
    spool.add_argument("--spool-dir", type=Path)
    spool.add_argument(
        "--default-spool", action="store_true", help="恢复按配置文件身份隔离的默认队列"
    )
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument("--headers-env", help="从环境变量读取编码头并存入私有文件，跨启动生效")
    credentials.add_argument(
        "--headers-file", type=Path, help="从文件读取编码头并复制到私有凭据文件"
    )
    credentials.add_argument("--clear-headers", action="store_true")
    parser.add_argument("--areal-binary", type=Path, help="用于即时应用控制的 areal 可执行文件")
    for field in DEFAULTS:
        parser.add_argument("--" + field.replace("_", "-"), type=int)
    return parser.parse_args(argv)


def apply_control(binary, action, config, home):
    if not binary:
        return False
    try:
        result = subprocess.run(
            [binary, "trajectory", action, "--config", str(config)],
            env=dict(os.environ, AREAL_HARNESS_HOME=str(home)),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def configure(args):
    env_home = os.environ.get("AREAL_HARNESS_HOME")
    if (
        not args.home
        and env_home is not None
        and (not env_home or not Path(env_home).is_absolute())
    ):
        raise ConfigurationError("AREAL_HARNESS_HOME 必须是非空绝对路径")
    home = (
        (args.home or Path(env_home if env_home is not None else "~/.areal"))
        .expanduser()
        .absolute()
    )
    env_config = os.environ.get("AREAL_HARNESS_CONFIG")
    if not args.config and env_config == "":
        raise ConfigurationError("AREAL_HARNESS_CONFIG 必须是非空路径")
    config = (
        (args.config or (Path(env_config) if env_config else home / "config.toml"))
        .expanduser()
        .absolute()
    )
    binary = (
        str(args.areal_binary.expanduser().absolute())
        if args.areal_binary
        else shutil.which("areal")
    )
    config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # 与 Core 的模型配置写入共用锁，避免并发修改覆盖模型目录。
    lock_path = config.with_name(f".{config.name}.lock")
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "a") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ConfigurationError("配置锁必须是普通文件")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ConfigurationError("另一个配置写入正在进行，请稍后重试") from None
        existed = os.path.lexists(config)
        old = regular_text(config) if existed else "schema_version = 2\n"
        parsed = tomllib.loads(old)
        existing = parsed.get("trajectory", {})
        if not isinstance(existing, dict):
            raise ConfigurationError("trajectory 必须是 TOML 表")
        unknown = (
            set(existing)
            - set(DEFAULTS)
            - {"enabled", "endpoint", "spool_dir", "headers_env", "headers_file"}
        )
        if unknown:
            raise ConfigurationError("原轨迹配置含不支持的字段，请先校验配置")
        values = dict(existing)
        values["enabled"] = (
            False
            if args.disable
            else True
            if args.enable
            else DEFAULT_ENABLED
            if DEFAULT_ENABLED is not None
            else existing.get("enabled", False)
        )
        if type(values["enabled"]) is not bool:
            raise ConfigurationError("enabled 必须是布尔值")
        values["endpoint"] = (
            args.endpoint
            if args.endpoint is not None
            else DEFAULT_ENDPOINT or existing.get("endpoint", "")
        )
        if args.default_spool:
            values.pop("spool_dir", None)
        elif args.spool_dir:
            values["spool_dir"] = str(args.spool_dir.expanduser().absolute())
        for field, default in DEFAULTS.items():
            option = getattr(args, field)
            values[field] = option if option is not None else existing.get(field, default)
        for field in DEFAULTS:
            if type(values[field]) is not int or values[field] < (
                0 if field == "max_retries" else 1
            ):
                raise ConfigurationError("容量和时间必须为正整数；max_retries 可以为 0")
        maxima = {
            "max_disk_bytes": 1 << 40,
            "max_memory_bytes": 1 << 30,
            "max_batch_bytes": 64 << 20,
            "max_records": 10_000,
            "max_retries": 100,
            "retry_initial_seconds": 86400,
            "retry_max_seconds": 86400,
            "request_timeout_seconds": 86400,
            "upload_interval_ms": 86_400_000,
        }
        if any(values[field] > maximum for field, maximum in maxima.items()):
            raise ConfigurationError("容量或时间超出支持范围")
        if not isinstance(values["endpoint"], str) or len(values["endpoint"].encode()) > 4096:
            raise ConfigurationError("接收地址必须是长度不超过 4096 的文本")
        for field in ("spool_dir", "headers_file"):
            if field in values and (
                not isinstance(values[field], str)
                or not values[field].strip()
                or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in values[field])
            ):
                raise ConfigurationError("队列和凭据路径必须是非空、无控制字符的文本")
        if "headers_env" in values and (
            not isinstance(values["headers_env"], str) or len(values["headers_env"].encode()) > 4096
        ):
            raise ConfigurationError("认证环境变量引用必须是长度不超过 4096 字节的文本")
        if values["max_batch_bytes"] > min(values["max_memory_bytes"], values["max_disk_bytes"]):
            raise ConfigurationError("批次上限不得超过内存或磁盘上限")
        if values["retry_initial_seconds"] > values["retry_max_seconds"]:
            raise ConfigurationError("最大退避时间不得小于初始退避时间")
        if values["enabled"] and not values["endpoint"]:
            raise ConfigurationError("启用前请通过 --endpoint 或脚本 DEFAULT_ENDPOINT 配置接收地址")
        secret = None
        if args.headers_env:
            secret = os.environ.get(args.headers_env)
            if not secret:
                raise ConfigurationError("指定的认证环境变量未设置或为空")
        elif args.headers_file:
            secret = regular_text(args.headers_file.expanduser(), 16384).strip()
        elif DEFAULT_HEADERS and not args.clear_headers:
            secret = DEFAULT_HEADERS
        if args.clear_headers or secret is not None:
            values.pop("headers_env", None)
            values.pop("headers_file", None)
        credential_update = None
        if secret is not None:
            if not secret or len(secret.encode()) > 16384 or any(ord(c) < 32 for c in secret):
                raise ConfigurationError("认证头必须是非空、无控制字符的编码文本，且不超过 16 KiB")
            # 同接收端轮换保持引用稳定；切换地址用独立文件，旧在途请求不能读取新地址凭据。
            identity = json.dumps([str(config.resolve()), values["endpoint"]], ensure_ascii=False)
            digest = hashlib.sha256(identity.encode()).hexdigest()
            private = home / "trajectory-credentials" / f"headers-{digest}.txt"
            credential_update = (private, secret)
            values["headers_file"] = str(private)
        if values.get("headers_env") is not None and values.get("headers_file") is not None:
            raise ConfigurationError("headers_env 与 headers_file 不能同时配置")
        updated = replace_trajectory(old, values)
        changed = tomllib.loads(old).get("trajectory") != values
        if (os.path.lexists(config) != existed) or (existed and regular_text(config) != old):
            raise ConfigurationError("配置已被其他编辑器修改，请重新运行")
        migrating = (
            existed
            and "trajectory" in parsed
            and any(
                values.get(field, "" if field == "endpoint" else None)
                != existing.get(field, "" if field == "endpoint" else None)
                for field in ("spool_dir", "endpoint")
            )
        )
        if migrating and not apply_control(binary, "suspend", config, home):
            raise ConfigurationError(
                "切换接收地址或队列前必须先停止原队列；请通过 --areal-binary 指定支持 "
                "trajectory suspend 的新版 areal，并确认原队列属于此配置。原配置和凭据未修改"
            )
        if migrating and regular_text(config) != old:
            raise ConfigurationError("停止原队列期间配置被其他编辑器修改，请重新运行")
        if credential_update is not None:
            atomic_private(*credential_update)
        if changed:
            if config.exists():
                atomic_private(config.with_name(config.name + ".trajectory.bak"), old)
            atomic_private(config, updated)
    applied = apply_control(binary, "sync-config", config, home)
    print(
        json.dumps(
            {
                "config": str(config),
                "enabled": values["enabled"],
                "changed": changed,
                "controlApplied": applied,
            },
            ensure_ascii=False,
        )
    )
    if not applied:
        print(
            "配置已保存，导出控制尚未即时应用；请使用新版 areal trajectory sync-config --config 指定文件，或重新启动 Core。",
            file=sys.stderr,
        )
    print("已运行的 Core 需安全重启以应用采集配置；脚本不会重启或取消 Agent。", file=sys.stderr)


def main(argv=None):
    try:
        configure(parse_args(argv))
    except ConfigurationError as error:
        print(f"轨迹配置未完成：{error}", file=sys.stderr)
        return 1
    except (ValueError, OSError):
        # 不打印解析器上下文、子进程 stderr 或 OS 路径，防止回显认证材料。
        print("轨迹配置未完成：请检查配置格式、参数、认证输入和文件权限。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
