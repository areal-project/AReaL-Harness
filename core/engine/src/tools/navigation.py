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
    column = request.get("column", 1)
    digest = hashlib.sha256(data).hexdigest()
    if request.get("expectedSha256") not in (None, digest):
        raise ValueError(
            "file changed since the requested read; read the new version before continuing"
        )
    if column > 1 and not request.get("expectedSha256"):
        raise ValueError("continuing a line requires expectedSha256 from nextRead")
    if column < 1 or offset < 1 or limit < 1:
        raise ValueError("offset, limit and column must be positive")
    if column > 1 and (offset > len(lines) or column > len(lines[offset - 1])):
        raise ValueError("column is outside the requested source line")
    result = {
        "path": request["path"],
        "sha256": digest,
        "totalLines": len(lines),
        "offset": offset,
        "lines": [],
        "nextLine": offset,
        "eof": offset > len(lines),
        "truncated": offset <= len(lines),
    }
    for index in range(offset - 1, min(len(lines), offset - 1 + limit)):
        start = column - 1 if index == offset - 1 else 0
        content = lines[index][start:]
        line = {"number": index + 1, "text": content}
        if start:
            line.update(column=start + 1, complete=True)
        result["lines"].append(line)
        result["nextLine"] = index + 2
        result["eof"] = result["nextLine"] > len(lines)
        result["truncated"] = not result["eof"]
        if len(json.dumps(result, ensure_ascii=False).encode()) > LIMIT:
            result["lines"].pop()
            result["nextLine"] = index + 1
            if result["lines"]:
                break
            # 按 Unicode 字符分页，不截断 UTF-8，也不把 JSON 残片冒充完整文档。
            line.update(text="", column=start + 1, complete=False)
            result["lines"].append(line)
            result.update(eof=False, truncated=True, nextColumn=start + 1)
            result["nextRead"] = {
                "path": request["path"],
                "offset": index + 1,
                "column": start + 1,
                "expectedSha256": digest,
            }
            low, high = 0, len(content)
            while low < high:
                middle = (low + high + 1) // 2
                line["text"] = content[:middle]
                result["nextColumn"] = result["nextRead"]["column"] = start + middle + 1
                if len(json.dumps(result, ensure_ascii=False).encode()) <= LIMIT:
                    low = middle
                else:
                    high = middle - 1
            if low == 0:
                raise ValueError("file read metadata exceeds output budget")
            line["text"] = content[:low]
            result["nextColumn"] = result["nextRead"]["column"] = start + low + 1
            break
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
