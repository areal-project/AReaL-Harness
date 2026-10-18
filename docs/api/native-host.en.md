[中文](native-host.md) | **English**

# Native Host v2

An explicitly trusted independent process can connect to Core using UTF-8 JSONL in any language, without DSH/SDK. The Host itself is not OS-sandboxed. Managed files/processes use a broker without access to Runtime pipes.

[Machine schema](../../schemas/native-host-v2.json) · [Runnable Host](../../examples/desktop-api/native-host.mjs)

Configure plugins in tools.extensions_file with trusted=true, argv, readRoots/writeRoots and timeoutMs. Process brokering additionally requires allowProcess=true. The first line is `{protocolVersion:2,tools:[{name,description,inputSchema,outputSchema?}]}` with up to 32 tools and a 10-second handshake; v1 supports files only. Diagnostics go to stderr; each Host is serial.

Both v1 and v2 Hosts automatically inherit standard proxy variables, including credentials in proxy URLs; other variables retain the allowlist. This changes neither the message protocol nor broker command environments. See [plugin boundaries](../design/plugins.en.md) and [proxy configuration](../guides/configuration.en.md#proxies) for HTTP library requirements and inheritance details.

| Direction | Message |
|---|---|
| Core → Host | `{type:"call",callId,params:{tool,arguments,...}}` |
| Host → Core | `{type:"file" or "process",callId,requestId,command}` |
| Core → Host | `{type:"fileResult" or "processResult",callId,requestId,result}`, or error |
| Host → Core | `{type:"result",callId,response:{success,contentItems}}` |

requestId is an integer unique within the call, with 32 combined file/process requests. Core binds callId, generation, Scope and operationId and journals intent before side effects; Hosts cannot self-assign owner. Cancellation, timeout, crash or protocol failure closes the generation; uncertain outcomes become UNKNOWN.

File command.kind is stat/read/write with workspace URIs. Reads start at 0 and permit up to 32768 bytes. Writes carry dataBase64 and absent/sha256 conditions. Files are limited to 32 KiB.

Process command.op is start/get/read/write/resize/closeStdin/terminate. start takes argv/cwd/tty/timeoutMs; other operations require a processId created in this call. Foreign and previous-call handles are forbidden. Read-only Profiles reject Host tools that cannot be established as read-only.

Approvals bind effective arguments, generation and permissions without expanding grants. Close the Scope before completing each call; use the [shared process API](desktop.en.md) for persistent services. Results are checked for schema, size, modality and Blob ownership. Confirmed nested writes remain recorded after outer failure.
