#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


os.umask(0o077)
binary = Path(os.environ["AREAL_CORE_BIN"])
assert binary.is_absolute() and binary.is_file() and not binary.is_symlink()
root = Path(tempfile.mkdtemp(prefix="ah-service-ownership-", dir="/private/tmp")).resolve()
registry = root / "registry"
workspace = root / "workspace"
data = root / "state"
profile = root / "profile"
configuration = root / "configuration"
for directory in (registry, workspace, data, profile, configuration, root / "user"):
    directory.mkdir(mode=0o700)
config = configuration / "config.toml"
config.write_text(
    'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n'
    '[model.providers.fixture]\nprotocol="chat-completions"\n'
    'endpoint="http://127.0.0.1:9/v1/chat/completions"\n'
)
env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "LANG", "TMPDIR"}}
env.update(
    AREAL_HARNESS_HOME=str(configuration),
    AREAL_HARNESS_SERVICE_HOME=str(registry),
    AREAL_CORE_USER_HOME=str(root / "user"),
    OTEL_SDK_DISABLED="true",
)
evidence = {
    "root": str(root),
    "binary": str(binary),
    "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
    "commands": [],
    "checks": [],
    "passed": False,
}
result = root / "result.json"
print(f"Service ownership evidence {result}", flush=True)


def save():
    result.write_text(json.dumps(evidence, indent=2) + "\n")


def call(args, *, extra=None, pass_fds=(), success=True):
    record = {"args": args}
    evidence["commands"].append(record)
    save()
    completed = subprocess.run(
        [str(binary), *args],
        cwd=workspace,
        env={**env, **(extra or {})},
        pass_fds=pass_fds,
        capture_output=True,
        text=True,
        timeout=90,
    )
    record.update(code=completed.returncode, stdout=completed.stdout, stderr=completed.stderr)
    save()
    if not success:
        assert completed.returncode != 0, record
        return completed
    assert completed.returncode == 0, record
    return json.loads(completed.stdout)


local = [
    "--workspace",
    str(workspace),
    "--data-dir",
    str(data),
    "--config",
    str(config),
    "--json",
]
service = None
pending = None
reader, writer = os.pipe()
owner = {"kind": "gui", "appRunId": str(uuid.uuid4()), "profile": str(profile)}


def original_stop(reference):
    if reference["kind"] == "host":
        return call(["host", "operation", reference["requestId"], "--json"])["operation"]
    return call(
        [
            "service",
            "operation",
            "--instance",
            reference["serviceId"],
            "--expected-generation",
            reference["generation"],
            "--request-id",
            reference["requestId"],
            "--json",
        ]
    )["operation"]


def settle(reference, receipt):
    deadline = time.monotonic() + 45
    while receipt is None or receipt["state"] not in {"completed", "blocked"}:
        assert time.monotonic() < deadline, f"UNKNOWN original operation {reference}"
        time.sleep(0.05)
        receipt = original_stop(reference)
        evidence["originalObservation"] = {"reference": reference, "receipt": receipt}
        save()
    assert receipt["state"] == "completed", receipt
    assert receipt["requestId"] == reference["requestId"], receipt
    if reference["kind"] == "host":
        assert receipt["hostId"] == reference["hostId"], receipt
        assert receipt["generation"] == reference["generation"], receipt
    else:
        assert receipt["serviceId"] == reference["serviceId"], receipt
        assert receipt["generation"] == reference["generation"], receipt
    return receipt


def stop_service(current):
    global pending
    pending = {
        "kind": "service",
        "requestId": str(uuid.uuid4()),
        "serviceId": current["serviceId"],
        "generation": current["generation"],
    }
    evidence.setdefault("stops", []).append(pending.copy())
    save()
    receipt = call(
        [
            "service",
            "stop",
            "--instance",
            current["serviceId"],
            "--expected-generation",
            current["generation"],
            "--request-id",
            pending["requestId"],
            "--json",
        ]
    )
    receipt = settle(pending, receipt)
    pending = None
    return receipt


try:
    service = call(
        ["service", "ensure", *local],
        extra={
            "AREAL_GUI_OWNER": json.dumps(owner),
            "AREAL_GUI_LIFETIME_FD": str(reader),
        },
        pass_fds=(reader,),
    )
    assert service["owner"] == owner, service
    assert not (registry / "host").exists()
    refused = call(["service", "restart", *local], success=False)
    assert "GUI restart requires its generation-bound lifecycle operation" in refused.stderr
    assert not (registry / "host").exists(), "GUI restart must not create a Host"
    stopped_gui = stop_service(service)
    assert not (registry / "host").exists(), "GUI stop must not create a Host"
    assert (
        original_stop(
            {
                "kind": "service",
                "requestId": stopped_gui["requestId"],
                "serviceId": service["serviceId"],
                "generation": service["generation"],
            }
        )
        == stopped_gui
    )
    evidence["checks"].append("GUI-owned restart rejects and stop completes without any Host")
    evidence["gui"] = {"service": service, "stop": stopped_gui}
    os.close(writer)
    writer = None

    pending = {"kind": "host", "requestId": stopped_gui["requestId"], "method": "project.ensure"}
    evidence["hostEnsureReference"] = pending.copy()
    save()
    opened = call(["host", "ensure", "--request-id", stopped_gui["requestId"], *local])
    pending = None
    hosted = opened["service"]
    assert hosted["owner"]["kind"] == "host"
    assert hosted["serviceId"] == service["serviceId"]
    assert hosted["generation"] != service["generation"]
    host_identity = json.loads((registry / "host/host.json").read_text())
    assert hosted["owner"]["hostId"] == host_identity["hostId"]
    assert hosted["owner"]["generation"] == host_identity["generation"]
    old_reference = {
        "kind": "service",
        "requestId": stopped_gui["requestId"],
        "serviceId": service["serviceId"],
        "generation": service["generation"],
    }
    assert original_stop(old_reference) == stopped_gui
    ensure_operation = call(["host", "operation", stopped_gui["requestId"], "--json"])["operation"]
    assert ensure_operation["method"] == "project.ensure"
    call(
        [
            "service",
            "operation",
            "--instance",
            hosted["serviceId"],
            "--expected-generation",
            hosted["generation"],
            "--request-id",
            stopped_gui["requestId"],
            "--json",
        ],
        success=False,
    )
    evidence["checks"].append(
        "original GUI stop stays readable after actual Host takeover and same-ID ensure is never a stop"
    )
    service = hosted
    stopped_host = stop_service(hosted)
    status = call(["host", "status", "--json"])
    project = next(row for row in status["projects"] if row["registration"]["dataDir"] == str(data))
    assert project["scheduleActivationSuppressed"] is True
    assert project["state"] == "stopped"
    assert status["hostId"] == host_identity["hostId"]
    assert status["generation"] == host_identity["generation"]
    evidence["hosted"] = {
        "service": hosted,
        "stop": stopped_host,
        "statusAfterProjectStop": status,
    }
    evidence["checks"].append(
        "Host-owned stop uses the same Host and retains its scheduling stop intent"
    )

    pending = {
        "kind": "host",
        "requestId": str(uuid.uuid4()),
        "hostId": host_identity["hostId"],
        "generation": host_identity["generation"],
    }
    evidence["hostStop"] = pending.copy()
    save()
    receipt = call(
        [
            "host",
            "stop",
            "--request-id",
            pending["requestId"],
            "--expected-generation",
            pending["generation"],
            "--json",
        ]
    )
    evidence["hostStopReceipt"] = settle(pending, receipt)
    pending = None
    deadline = time.monotonic() + 15
    while (registry / "host/host.json").exists():
        assert time.monotonic() < deadline, "Host descriptor remains after completed stop"
        time.sleep(0.05)
    assert original_stop(old_reference) == stopped_gui
    assert not (registry / "host/host.json").exists(), (
        "original receipt lookup must not recreate Host"
    )
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == evidence["binarySha256"]
    evidence["checks"].append("offline original receipt reads do not recreate Host after shutdown")
    evidence["passed"] = True
except BaseException as error:
    evidence["error"] = {"type": type(error).__name__, "message": str(error)}
    evidence["pending"] = pending
    evidence["cleanupRequired"] = (
        "Inspect this isolated registry and recorded original operations before cleanup"
    )
    if pending:
        try:
            evidence["originalObservation"] = {
                "reference": pending,
                "receipt": original_stop(pending),
            }
        except BaseException as lookup_error:
            evidence["originalLookupError"] = str(lookup_error)
        evidence["cleanupRequired"] = "Only query the recorded original request; do not replay"
    raise
finally:
    if writer is not None:
        os.close(writer)
        evidence["guiOwnerLifetimeClosed"] = True
    os.close(reader)
    save()
