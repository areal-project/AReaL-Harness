#!/usr/bin/env python3
"""核对已推送的 head 后创建 PR 并回读回执；不推送或合并。"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote


def command(root, *args):
    return subprocess.check_output(args, cwd=root, text=True, stderr=subprocess.PIPE).strip()


def create(args):
    if not re.fullmatch(r"[a-f0-9]{40}", args.expected_head):
        raise ValueError("expected head must be a full commit SHA")
    for repo in (args.repo, args.head_repo):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            raise ValueError("repositories must use owner/name")
    command(args.root, "git", "check-ref-format", "--branch", args.branch)
    command(args.root, "git", "check-ref-format", "--branch", args.base)
    if (
        command(args.root, "git", "rev-parse", "HEAD") != args.expected_head
        or command(args.root, "git", "branch", "--show-current") != args.branch
        or command(args.root, "git", "status", "--porcelain")
    ):
        raise ValueError("expected head and branch must match a clean checkout")
    if not args.body_file.is_file():
        raise ValueError("body file must exist")

    published = json.loads(
        command(
            args.root,
            "gh",
            "api",
            f"repos/{args.head_repo}/git/ref/heads/{quote(args.branch, safe='')}",
        )
    )
    if published.get("object", {}).get("sha") != args.expected_head:
        raise ValueError("published branch differs from expected head; finish push first")
    owner, name = args.head_repo.split("/")
    head = f"{owner}:{args.branch}"
    existing = json.loads(
        command(
            args.root,
            "gh",
            "api",
            "--method",
            "GET",
            f"repos/{args.repo}/pulls",
            "--raw-field",
            f"head={head}",
            "--raw-field",
            f"base={args.base}",
            "--raw-field",
            "state=open",
        )
    )
    if existing:
        raise ValueError("an open PR already exists; inspect it instead of creating another")
    try:
        url = command(
            args.root,
            "gh",
            "pr",
            "create",
            "--repo",
            args.repo,
            "--head",
            head,
            "--base",
            args.base,
            "--title",
            args.title,
            "--body-file",
            str(args.body_file.resolve()),
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            "PR creation outcome is unknown; inspect PRs for this head (including closed "
            "and merged PRs) before any retry"
        ) from error
    match = re.fullmatch(r"https://[^\s/]+/([\w.-]+/[\w.-]+)/pull/\d+", url)
    if not match or match[1].lower() != args.repo.lower():
        raise RuntimeError("PR creation returned no usable receipt; reconcile before retrying")
    try:
        receipt = json.loads(
            command(
                args.root,
                "gh",
                "pr",
                "view",
                url,
                "--repo",
                args.repo,
                "--json",
                "state,headRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner",
            )
        )
        if (
            receipt.get("state") != "OPEN"
            or receipt.get("headRefOid") != args.expected_head
            or receipt.get("headRefName") != args.branch
            or receipt.get("baseRefName") != args.base
            or (receipt.get("headRepository") or {}).get("name") != name
            or (receipt.get("headRepositoryOwner") or {}).get("login") != owner
        ):
            raise ValueError("PR identity changed")
    except (subprocess.CalledProcessError, ValueError, TypeError, AttributeError) as error:
        raise RuntimeError(
            f"PR exists at {url}, but head verification failed; inspect this PR, do not recreate"
        ) from error
    return {"url": url, "headRefOid": args.expected_head, "base": args.base}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    for flag in ("repo", "head-repo", "branch", "base", "expected-head", "title"):
        parser.add_argument(f"--{flag}", required=True)
    parser.add_argument("--body-file", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(create(args)))
    except subprocess.CalledProcessError:
        print("PR preflight command failed; no create request sent", file=sys.stderr)
        return 1
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except OSError:
        print(
            "Required command or input unavailable; inspect PR state before retrying",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
