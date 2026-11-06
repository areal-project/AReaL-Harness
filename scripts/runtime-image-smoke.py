#!/usr/bin/env python3
"""通过真实 Runtime/文件助手验证传输前图片视图，不调用模型或外部图片依赖。"""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import random
import runpy
import struct
import tempfile
import time
import zlib

SMOKE = runpy.run_path(str(Path(__file__).with_name("runtime-smoke.py")))
Runtime, RpcError = SMOKE["Runtime"], SMOKE["RpcError"]


def source_png():
    def chunk(kind, data):
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    rng = random.Random(42)
    pixels = b"".join(b"\0" + rng.randbytes(1024 * 3) for _ in range(1024))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1024, 1024, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels))
        + chunk(b"IEND", b"")
    )


def collect(runtime, reference):
    process = reference["processId"]
    assert runtime.call("process.get", {"processId": process})["state"] == "exited"
    raw, after, pages = bytearray(), None, 0
    while True:
        page = runtime.output(process, after=after)
        assert not page["gap"] and not page["truncated"], page
        assert len(json.dumps(page).encode()) < 128 * 1024
        pages += 1
        for chunk in page["chunks"]:
            assert chunk["stream"] == "stdout"
            raw.extend(base64.b64decode(chunk["dataBase64"], validate=True))
        if page["closed"]:
            break
        assert after != page["nextCursor"]
        after = page["nextCursor"]
    assert len(raw) == reference["bytes"]
    return json.loads(raw)["result"], pages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--dimension", type=int, default=512)
    parser.add_argument("--output-budget", type=int, default=1420661)
    parser.add_argument("--sandbox-profile", default="native")
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    binary = args.bin_dir.resolve() / "areal-runtime"
    source = args.image.read_bytes() if args.image else source_png()
    source_hash = hashlib.sha256(source).hexdigest()
    records = []
    with tempfile.TemporaryDirectory(prefix="areal-image-smoke-") as directory:
        workspace = Path(directory)
        (workspace / "source.png").write_bytes(source)
        for cap, expected_success in [(args.output_budget, True), (1024, False)]:
            runtime = Runtime(
                binary,
                workspace,
                ["--sandbox-profile", args.sandbox_profile, "--output-bytes", str(cap)],
            )
            started = time.monotonic()
            try:
                runtime.info = runtime.call(
                    "connection.open", {"protocolVersion": "areal.runtime.v0"}
                )
                assert runtime.info["capabilities"]["runtimeImageViewsV1"]
                scope = runtime.scope(readonly=True)
                request = {
                    "operationId": runtime.op(),
                    "scopeId": scope,
                    "command": {
                        "kind": "readImage",
                        "path": "workspace://repo/source.png",
                        "options": {"maxDimension": args.dimension},
                    },
                }
                try:
                    response = runtime.call("fs.execute", request)
                except RpcError as error:
                    assert not expected_success, error
                    assert error.value["code"] == "RESOURCE_EXHAUSTED", error
                    assert error.value["details"]["cleanupConfirmed"]
                    used = runtime.call("scope.get", {"scopeId": scope})["outputBytes"]
                    assert used == cap
                    records.append(
                        {
                            "budget": cap,
                            "status": "expectedQuotaFailure",
                            "used": used,
                            "error": error.value,
                        }
                    )
                    continue
                assert expected_success
                assert len(json.dumps(response).encode()) < 128 * 1024
                view, pages = collect(runtime, response["imageOutput"])
                assert view["sourceSha256"] == source_hash and view["sourceBytes"] == len(source)
                assert view["sourceTransferred"] is False
                for item in view["views"]:
                    png = base64.b64decode(item.pop("dataBase64"), validate=True)
                    assert png.startswith(b"\x89PNG") and len(png) == item["outputBytes"]
                    assert list(struct.unpack(">II", png[16:24])) == item["outputDimensions"]
                    assert max(item["outputDimensions"]) <= args.dimension
                    item["sha256"] = hashlib.sha256(png).hexdigest()
                used = runtime.call("scope.get", {"scopeId": scope})["outputBytes"]
                assert used == response["imageOutput"]["bytes"] <= cap
                assert runtime.call("fs.execute", request) == response
                assert runtime.call("scope.get", {"scopeId": scope})["outputBytes"] == used
                records.append(
                    {
                        "budget": cap,
                        "status": "passed",
                        "used": used,
                        "pages": pages,
                        "view": view,
                        "seconds": time.monotonic() - started,
                    }
                )
                assert (
                    hashlib.sha256((workspace / "source.png").read_bytes()).hexdigest()
                    == source_hash
                )
            finally:
                runtime.close()
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(
        json.dumps(
            {
                "kind": "mechanismOnly",
                "modelRequests": 0,
                "sourceSha256": source_hash,
                "sourceBytes": len(source),
                "cases": records,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps(
            {
                "pass": True,
                "modelRequests": 0,
                "sourceBytes": len(source),
                "runtimeOutputBytes": records[0]["used"],
                "evidence": str(args.evidence),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
