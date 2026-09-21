Create `/app/rpc_fanout.py`. It must provide this reusable coroutine:

```python
async def fanout(host: str, port: int, requests: list[dict], limit: int,
                 timeout_ms: int) -> list[dict]
```

`requests` has 1-256 entries. Each request has exactly `id` and `payload`: a
nonempty unique string ID and a JSON object. One RPC opens
a TCP connection, writes that request as compact UTF-8 JSON plus LF, and reads
one UTF-8 JSON line. A successful response has exactly
`{"ok":true,"value":...}`; an exact `{"ok":false,"error":string}` response is
a call failure. Malformed JSON or any other shape is a call failure. Preserve
input order in returned entries
of the form `{"id":...,"value":...}`.

`limit` must be positive, and no more than `limit` RPC connections may be
active. `timeout_ms` is a positive per-RPC deadline beginning when that RPC
starts. After a failed response, timeout, or cancellation of `fanout` is
observed, no queued request may open a connection. Before `fanout` returns or
raises, every connection and asynchronous operation it started must be closed
or finished.

Also provide:

```text
python3 /app/rpc_fanout.py HOST PORT REQUESTS.json OUTPUT.json LIMIT TIMEOUT_MS
```

`REQUESTS.json` is an array using the schema above. On complete success, replace
the output with a regular file containing the ordered result array as compact
JSON plus LF, leaving no temporary sibling. Invalid arguments
exit `2`; call failure or timeout exits nonzero; SIGINT exits `130`. Failed or
cancelled runs must not leave `OUTPUT.json`. The task is offline; localhost is
available. A protocol-only example is under `/app/data`.
