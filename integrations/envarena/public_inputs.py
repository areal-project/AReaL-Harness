"""只物化平台公开输入；模型通过已有 scratch 工具按需读取。"""

import hashlib
import json
import mimetypes
import os
from pathlib import Path
import stat

from graybox_inputs import PublicInputError, check_public_inputs, public_manifest

BOOTSTRAP_BYTES = 64 * 1024


class InputDeliveryError(PublicInputError):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.outcome = {
            "code": code,
            "class": "infrastructure",
            "source": "runner_input",
            "details": {"reason": message, "requestSent": False, **details},
        }


def regular(path):
    # 拒绝源路径任一层软链接，复制阶段不将私有路径带入公开目录。
    path = Path(path).absolute()
    if path.resolve() != path or not stat.S_ISREG(path.lstat().st_mode):
        raise PublicInputError("Public input must be a regular file without symlinks")
    if path.stat().st_nlink != 1:
        raise PublicInputError("Hard-linked public input is unsupported")
    return path


def copy_file(source, destination):
    source = regular(source)
    before = source.stat()
    digest = hashlib.sha256()
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(source, flags), "rb") as stream, destination.open("xb") as target:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise PublicInputError("Public input changed before import")
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            target.write(chunk)
        after = os.fstat(stream.fileno())
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise PublicInputError("Public input changed during import")
    return digest.hexdigest(), after.st_size


def prepare(query_path, destination, assets=Path("/problem_assets"), rules_path=None):
    destination = Path(destination)
    destination.mkdir(mode=0o700)
    sha, size = copy_file(query_path, destination / "TASK.md")
    task = {"path": "workspace://scratch/public-inputs/TASK.md", "sha256": sha, "bytes": size}
    rules = None
    if rules_path:
        sha, size = copy_file(rules_path, destination / "RULES.md")
        rules = {"path": "workspace://scratch/public-inputs/RULES.md", "sha256": sha, "bytes": size}
    records = []
    assets = Path(assets)
    if assets.exists() or assets.is_symlink():
        if assets.is_symlink() or not assets.is_dir() or assets.resolve() != assets.absolute():
            raise PublicInputError("Public assets must be a regular directory")
        # 只枚举约定的公开附件目录，绝不扫描 Arena 的环境、评分器或其他挂载。
        public_manifest(assets) if any(assets.iterdir()) else None
        objects = destination / "assets"
        objects.mkdir()
        for source in sorted(assets.rglob("*")):
            if source.is_dir():
                continue
            temporary = objects / "importing"
            sha, size = copy_file(source, temporary)
            name = sha
            target = objects / name
            if target.exists():
                temporary.unlink()
            else:
                temporary.rename(target)
            records.append(
                {
                    "source": str(source),
                    "alias": str(source.relative_to(assets)),
                    "path": "workspace://scratch/public-inputs/assets/" + name,
                    "shell_path": str(target),
                    "mime_hint": mimetypes.guess_type(source.name)[0] or "application/octet-stream",
                    "sha256": sha,
                    "bytes": size,
                }
            )
    with (destination / "attachments.jsonl").open("w") as output:
        for record in records:
            output.write(json.dumps(record, ensure_ascii=False) + "\n")
    receipt = {
        "input_delivery": "lazy_files",
        "task": task,
        "rules": rules,
        "attachment_count": len(records),
        "unique_attachment_count": len({r["sha256"] for r in records}),
        "attachment_bytes": sum(r["bytes"] for r in records),
        "unique_attachment_bytes": sum({r["sha256"]: r["bytes"] for r in records}.values()),
        "manifest_path": "workspace://scratch/public-inputs/attachments.jsonl",
    }
    baseline = public_manifest(destination)
    # chmod 是辅助约束；真正的只读和祖先保护由 Runtime 的 --read-only-path 执行。
    for path in [*destination.rglob("*"), destination]:
        path.chmod(0o555 if path.is_dir() else 0o444)
    return receipt, records, baseline


def bootstrap(receipt, destination):
    text = (
        "Complete the task in the trusted task entry below. First read TASK.md, then the attachment manifest. "
        "Preserve all task requirements and the task's original output contract. Public inputs are read-only. "
        "Read text in bounded ranges with read_file; follow nextLine. For sources over 8 MiB use bounded "
        "streaming commands (for example Python line iteration), never cat the whole file into context. "
        "Resolve original attachment references through the manifest aliases. Use image_read on its path "
        "to see visual content; GIF results include frame/time coverage and can be read again with frameIndex. "
        "Keep the task entry and remaining requirements in any working notes.\n"
        f"Task entry: {receipt['task']['path']}\n"
        f"Attachment manifest: {receipt['manifest_path']}\n"
        f"Public input shell directory: {destination}\n"
    )
    if receipt["rules"]:
        text += f"Read the frozen Harness rules before acting: {receipt['rules']['path']}\n"
    return [{"type": "text", "text": text}]


def validate_envelope(inputs):
    size = len(json.dumps(inputs, ensure_ascii=False, indent=2).encode())
    if size > BOOTSTRAP_BYTES:
        raise InputDeliveryError(
            "INPUT_ENVELOPE_TOO_LARGE",
            "lazy bootstrap exceeds limit",
            actualBytes=size,
            maxBytes=BOOTSTRAP_BYTES,
        )
    return size


def verify(directory, baseline):
    check_public_inputs(directory, baseline)
