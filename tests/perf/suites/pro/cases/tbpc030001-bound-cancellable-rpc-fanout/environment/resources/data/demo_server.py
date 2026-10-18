#!/usr/bin/env python3
"""Small protocol demonstration; production evaluation uses a separate server."""

import asyncio
import json
import sys


async def handle(reader, writer):
    try:
        request = json.loads(await reader.readline())
        payload = request["payload"]
        await asyncio.sleep(float(payload.get("delay_ms", 0)) / 1000)
        response = {"ok": True, "value": {"token": payload.get("token"), "request_id": request["id"]}}
        writer.write(json.dumps(response, separators=(",", ":")).encode() + b"\n")
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def main():
    port = int(sys.argv[1]) if len(sys.argv) == 2 else 8765
    server = await asyncio.start_server(handle, "127.0.0.1", port)
    async with server:
        await server.serve_forever()


asyncio.run(main())
