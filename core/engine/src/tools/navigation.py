"""Bounded read/search operations executed inside the task Runtime scope."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

LIMIT = 14000


def project_path(request):
    uri = request["path"]
    for name in ("repo", "scratch"):
        prefix = "workspace://" + name
        if uri == prefix or uri.startswith(prefix + "/"):
            if not request["roots"].get(name):
                raise ValueError("workspace root is not configured")
            root = Path(request["roots"][name])
            parts = Path(uri[len(prefix) :].lstrip("/")).parts
            current = root
            for part in parts:
                if part in (".", ".."):
                    raise ValueError("path traversal rejected")
                current = current / part
                if current.is_symlink():
                    raise ValueError("symlink path rejected")
            return current
    raise ValueError("unsupported workspace path")


def read_file(request):
    path = project_path(request)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
            raise ValueError("read_file requires a regular file no larger than 8 MiB")
        data = stream.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("file grew beyond 8 MiB")
    lines = data.decode("utf-8").splitlines(keepends=True)
    offset, limit = request.get("offset", 1), request.get("limit", 120)
    result = {
        "path": request["path"],
        "sha256": hashlib.sha256(data).hexdigest(),
        "totalLines": len(lines),
        "offset": offset,
        "lines": [],
        "nextLine": offset,
        "eof": offset > len(lines),
    }
    for index in range(offset - 1, min(len(lines), offset - 1 + limit)):
        line = {"number": index + 1, "text": lines[index]}
        result["lines"].append(line)
        if len(json.dumps(result, ensure_ascii=False).encode()) > LIMIT:
            result["lines"].pop()
            if not result["lines"]:
                raise ValueError(
                    "single line exceeds output budget; use fs_read for bounded byte ranges"
                )
            break
        result["nextLine"] = index + 2
    result["eof"] = result["nextLine"] > len(lines)
    result["truncated"] = not result["eof"]
    return result


def search_files(request):
    path = project_path(request)
    command = [
        "rg",
        "--json",
        "--no-follow",
        "--line-number",
        "--context",
        str(request.get("context", 2)),
    ]
    if request.get("glob"):
        command.extend(["--glob", request["glob"]])
    command.extend(["--", request["pattern"], str(path)])
    rows, matches, scanned = [], 0, 0
    limited = False
    # An unread stderr pipe can deadlock when rg visits many unreadable paths.
    with (
        tempfile.TemporaryFile() as errors,
        subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors) as process,
    ):
        try:
            while True:
                raw = process.stdout.readline(65537)
                if not raw:
                    break
                scanned += len(raw)
                if len(raw) > 65536 or scanned > 8 * 1024 * 1024:
                    limited = True
                    break
                event = json.loads(raw)
                if event.get("type") not in ("match", "context"):
                    continue
                data = event["data"]
                if event["type"] == "match":
                    matches += 1
                row = {
                    "path": data["path"].get("text"),
                    "line": data.get("line_number"),
                    "text": data["lines"].get("text"),
                    "kind": event["type"],
                }
                rows.append(row)
                if (
                    matches > request.get("limit", 50)
                    or len(json.dumps(rows, ensure_ascii=False).encode()) > LIMIT - 1000
                ):
                    rows.pop()
                    limited = True
                    break
        finally:
            if limited:
                process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        errors.seek(0)
        error = errors.read(2048).decode("utf-8", errors="replace")
        if process.returncode not in (0, 1) and not limited:
            raise ValueError("search failed: " + error)
    return {
        "matches": rows,
        "limited": limited,
        "guidance": "Narrow path/pattern when limited; no matches is meaningful only when limited=false.",
    }


if __name__ == "__main__":
    request = json.loads(sys.argv[1])
    try:
        result = (
            read_file(request) if request["operation"] == "read_file" else search_files(request)
        )
        print(json.dumps({"result": result}, ensure_ascii=False))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
