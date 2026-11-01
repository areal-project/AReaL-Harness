#!/usr/bin/env python3
"""Verify inherited Host and legacy GUI ownership with real Core/Runtime processes."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
import uuid


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def processes():
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,stat=,args="],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    rows = {}
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) == 4:
            pid, parent, state, command = fields
            rows[int(pid)] = {
                "pid": int(pid),
                "parent": int(parent),
                "state": state,
                "command": command,
            }
    return rows


def descendants(rows, parent):
    owned = {parent}
    while True:
        found = owned | {pid for pid, row in rows.items() if row["parent"] in owned}
        if found == owned:
            return found
        owned = found


def lock_available(path):
    require(path.is_file(), f"missing lifecycle lock {path}")
    with path.open("r+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True


def wait_for(check, description, timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        if check():
            return
        require(time.monotonic() < deadline, f"timed out waiting for {description}")
        time.sleep(0.1)


class LifetimeFixture:
    def __init__(self, binary, root, kind, evidence):
        self.binary = binary
        self.root = root / kind
        self.root.mkdir()
        self.workspace = self.root / "w"
        self.home = self.root / "h"
        self.data = self.root / "d"
        self.profile = self.root / "p"
        for path in [self.workspace, self.home, self.profile]:
            path.mkdir()
        self.config = self.root / "config.toml"
        self.config.write_text(
            'schema_version = 1\n[model]\nname = "fixture"\n'
            '[model.providers.default]\nprotocol = "chat-completions"\n'
            'endpoint = "http://127.0.0.1:9"\n'
        )
        self.env = {
            key: os.environ[key]
            for key in ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]
            if key in os.environ
        }
        self.env.update(
            HOME=str(self.root / "user"),
            AREAL_HARNESS_HOME=str(self.home),
            OTEL_SDK_DISABLED="true",
            NO_PROXY="127.0.0.1,localhost",
            no_proxy="127.0.0.1,localhost",
        )
        self.owner = (
            {"kind": "host", "hostId": str(uuid.uuid4()), "generation": str(uuid.uuid4())}
            if kind == "host"
            else {"kind": "gui", "appRunId": str(uuid.uuid4()), "profile": str(self.profile)}
        )
        self.prefix = "AREAL_SERVICE" if kind == "host" else "AREAL_GUI"
        self.reader, self.writer = os.pipe()
        self.service = None
        self.owned = {}
        self.evidence = evidence
        evidence.update(
            kind=kind,
            root=str(self.root),
            owner=self.owner,
            configSha256=sha256(self.config),
            checks=[],
            commands=[],
        )

    def cli(self, args, owner=None, reader=None, success=True):
        env = dict(self.env)
        if owner is not None:
            env[self.prefix + "_OWNER"] = json.dumps(owner)
            env[self.prefix + "_LIFETIME_FD"] = str(reader)
        result = subprocess.run(
            [str(self.binary), "service", *args],
            cwd=self.workspace,
            env=env,
            pass_fds=() if reader is None else (reader,),
            capture_output=True,
            text=True,
            timeout=80,
        )
        self.evidence["commands"].append(
            {"args": args, "exitCode": result.returncode, "stderr": result.stderr}
        )
        require(
            (result.returncode == 0) == success,
            f"unexpected CLI exit {result.returncode}: {result.stderr}",
        )
        return json.loads(result.stdout) if success else result.stderr

    def ensure(self, owner=None, reader=None, success=True):
        return self.cli(
            [
                "ensure",
                "--json",
                "--workspace",
                str(self.workspace),
                "--data-dir",
                str(self.data),
                "--config",
                str(self.config),
            ],
            owner=self.owner if owner is None else owner,
            reader=self.reader if reader is None else reader,
            success=success,
        )

    def ready(self):
        current = self.cli(["status", "--json", "--instance", self.service["serviceId"]])
        require(current["state"] == "ready", "service must remain ready with owner writer open")
        for key in ["serviceId", "generation", "hostPid", "corePid", "owner"]:
            require(current[key] == self.service[key], f"service changed {key}")
        endpoint = urlsplit(current["endpoint"])
        require(endpoint.hostname == "127.0.0.1", "fixture Core must use loopback")
        auth = json.loads(Path(current["authFile"]).read_text())
        request = urllib.request.Request(
            f"http://{endpoint.netloc}/areal/service",
            headers={"Authorization": "Bearer " + auth["principals"][0]["token"]},
        )
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            request, timeout=5
        ) as response:
            identity = json.load(response)
        for key in [
            "protocolVersion",
            "serviceId",
            "generation",
            "workspace",
            "dataDir",
            "configFingerprint",
        ]:
            require(identity[key] == current[key], f"Core probe identity changed {key}")
        require(not lock_available(self.data / "service.lock"), "live host must own service.lock")
        require(not lock_available(self.data / "owner.lock"), "live Core must own owner.lock")
        return current

    def capture_chain(self):
        rows = processes()
        parent = rows[self.service["hostPid"]]["parent"]
        bridge = rows.get(parent)
        root = (
            parent
            if bridge and str(self.binary) + " service-host" in bridge["command"]
            else self.service["hostPid"]
        )
        owned = descendants(rows, root)
        self.owned.update({pid: rows[pid] for pid in owned if pid in rows})
        require(self.service["corePid"] in owned, "Core must belong to the owned host chain")
        launchers = [
            row
            for row in self.owned.values()
            if row["command"].startswith(str(self.binary) + " launcher ")
        ]
        runtimes = [
            row
            for row in self.owned.values()
            if row["command"].split()[0] == str(self.binary.parent / "areal-runtime")
        ]
        require(len(launchers) == 1, "owned chain must contain one real launcher")
        require(len(runtimes) == 1, "owned chain must contain one real Runtime")
        launcher_chain = descendants(rows, launchers[0]["pid"])
        require(self.service["corePid"] in launcher_chain, "launcher must supervise Core")
        require(runtimes[0]["pid"] in launcher_chain, "launcher must supervise Runtime")
        self.evidence["processes"] = list(self.owned.values())

    def ended(self):
        rows = processes()
        remaining = [
            pid for pid in self.owned if pid in rows and not rows[pid]["state"].startswith("Z")
        ]
        self.evidence["remainingPids"] = remaining
        return not remaining

    def shutdown_observed(self):
        current = self.cli(["status", "--json", "--instance", self.service["serviceId"]])
        require(current["generation"] == self.service["generation"], "shutdown changed generation")
        locks = {name: lock_available(self.data / name) for name in ["service.lock", "owner.lock"]}
        self.evidence["shutdown"] = {"state": current["state"], "locksAvailable": locks}
        return current["state"] == "stopped" and all(locks.values()) and self.ended()

    def close_writer(self):
        if self.writer is not None:
            os.close(self.writer)
            self.writer = None

    def run(self):
        try:
            self.service = self.ensure()
            self.evidence["service"] = self.service
            require(
                self.service.get("owner") == self.owner, "service did not publish supplied owner"
            )
            require(
                self.service["dataDir"] == str(self.data), "service used another data directory"
            )
            self.capture_chain()
            self.ready()
            self.evidence["checks"].append("ensure caller exited while original owner stays ready")
            reused = self.ensure()
            require(reused == self.service, "same owner must reuse the ready generation")
            self.evidence["checks"].append("same owner reuses the exact generation")
            fields = ["hostId", "generation"] if self.owner["kind"] == "host" else ["appRunId"]
            for field in fields:
                wrong = {**self.owner, field: str(uuid.uuid4())}
                reader, writer = os.pipe()
                try:
                    error = self.ensure(owner=wrong, reader=reader, success=False)
                    require(
                        "owner mismatch" in error, "wrong owner failed outside the owner boundary"
                    )
                finally:
                    os.close(reader)
                    os.close(writer)
                self.ready()
                self.evidence["checks"].append(f"different {field} refused without stopping owner")
            self.close_writer()
            wait_for(self.shutdown_observed, "EOF shutdown, stopped status and both released locks")
            self.evidence["checks"].append("owner EOF stops process chain and releases both locks")
            self.evidence["passed"] = True
        finally:
            self.close_writer()
            os.close(self.reader)
            if self.service is None:
                records = list((self.home / "services").glob("*/service.json"))
                if records:
                    self.service = json.loads(records[0].read_text())
            if self.service is not None:
                if not self.owned:
                    rows = processes()
                    self.owned = {
                        pid: rows[pid]
                        for pid in descendants(rows, self.service["hostPid"])
                        if pid in rows
                    }
                    self.evidence["processes"] = list(self.owned.values())
                try:
                    wait_for(self.ended, "owned process cleanup", timeout=10)
                except AssertionError:
                    self.evidence["cleanupStop"] = self.cli(
                        [
                            "stop",
                            "--json",
                            "--instance",
                            self.service["serviceId"],
                            "--expected-generation",
                            self.service["generation"],
                            "--cancel",
                        ]
                    )
                    wait_for(self.ended, "explicit owned generation cleanup")
                self.evidence["cleanupComplete"] = self.shutdown_observed()
                require(self.evidence["cleanupComplete"], "owned generation cleanup is incomplete")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=os.environ.get("AREAL_TEST_EVIDENCE"))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    binary = Path(
        os.environ.get("AREAL_TEST_BIN")
        or str(Path(os.environ.get("AREAL_TEST_BIN_DIR", repo / ".local/dev-bin")) / "areal")
    )
    binary = binary.absolute()
    root = Path(tempfile.mkdtemp(prefix="ahl-", dir="/tmp")).resolve()
    evidence_path = args.evidence or root / "result.json"
    evidence = {"root": str(root), "binary": str(binary), "passed": False, "fixtures": []}
    try:
        binaries = [binary, binary.parent / "areal-runtime", binary.parent / "areal-runtime-fs"]
        for path in binaries:
            require(path.is_file() and not path.is_symlink(), f"missing real binary {path}")
        hashes = {str(path): sha256(path) for path in binaries}
        evidence["binarySha256"] = hashes
        build = subprocess.run(
            [str(binary), "build-info"], capture_output=True, text=True, check=True, timeout=20
        )
        evidence["buildInfo"] = json.loads(build.stdout)
        receipt = binary.parent / "verification-build.json"
        if receipt.is_file():
            evidence["deployment"] = json.loads(receipt.read_text())
        evidence["sourceRevision"] = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
        evidence["sourceDiff"] = subprocess.run(
            ["git", "diff", "--stat"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout
        processes()
        for kind in ["host", "gui"]:
            fixture = {}
            evidence["fixtures"].append(fixture)
            LifetimeFixture(binary, root, kind, fixture).run()
        require(
            hashes == {str(path): sha256(path) for path in binaries},
            "tested artifacts changed during smoke",
        )
        evidence["passed"] = True
    except Exception as error:
        evidence["error"] = str(error)
        raise
    finally:
        evidence_path = evidence_path.absolute()
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps(evidence, indent=2) + "\n")
        print(f"Host lifetime evidence: {evidence_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
