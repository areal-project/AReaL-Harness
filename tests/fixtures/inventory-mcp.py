#!/usr/bin/env python3
"""用于原文回取探针的 stdio MCP 数据源；由 Core 启动，不授予任务文件访问。"""

import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "inventory-fixture", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "snapshot",
                    "description": "Return an immutable inventory snapshot; call once.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False,
                    },
                }
            ]
        }
    elif method == "tools/call":
        rows = [
            {"state": "inactive", "value": "ordinary-inventory-entry-" + str(i)} for i in range(700)
        ]
        rows[347] = {"state": "active", "value": "quartz-river-846"}
        result = {"content": [{"type": "text", "text": json.dumps(rows)}]}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
