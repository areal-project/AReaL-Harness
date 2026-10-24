import json
import os
import sys

observed = {
    "argument": sys.argv[1],
    "cwd": os.getcwd(),
    "literal": os.environ["IMPORT_LITERAL"],
    "root": os.environ.get("PLUGIN_ROOT"),
    "data": os.environ.get("PLUGIN_DATA"),
}
with open(os.environ["IMPORT_MARKER"], "w") as marker:
    json.dump(observed, marker)
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "import", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "observe",
                    "inputSchema": {"type": "object"},
                    "annotations": {"readOnlyHint": True},
                    "_meta": {"ui": {"resourceUri": "ui://import", "visibility": ["app"]}},
                }
            ]
        }
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": json.dumps(observed)}]}
    elif method == "resources/read":
        result = {
            "contents": [
                {
                    "uri": "ui://import",
                    "mimeType": "text/html;profile=mcp-app",
                    "text": "<p>Import fixture</p>",
                }
            ]
        }
    elif method == "resources/list":
        result = {"resources": []}
    elif method == "resources/templates/list":
        result = {"resourceTemplates": []}
    else:
        print(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "error": {"code": -32601, "message": "Method not found"},
                }
            ),
            flush=True,
        )
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
