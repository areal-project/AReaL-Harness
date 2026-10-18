"""Bounded read/search operations executed inside the task Runtime scope."""

import hashlib
import json
import os
from pathlib import Path
import stat
import sys

LIMIT = 14000


def project_path(request):
    uri = request["path"]
    for name in ("repo", "scratch", "host"):
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
    try:
        lines = data.decode("utf-8").splitlines(keepends=True)
    except UnicodeDecodeError as error:
        raise ValueError(
            "read_file accepts UTF-8 text only; use fs_read for binary bytes or "
            "image_read for PNG/JPEG/WebP images"
        ) from error
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


if __name__ == "__main__":
    request = json.loads(sys.argv[1])
    try:
        result = read_file(request)
        print(json.dumps({"result": result}, ensure_ascii=False))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
