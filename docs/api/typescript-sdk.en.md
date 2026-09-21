[中文](typescript-sdk.md) | **English**

# TypeScript SDKs

Both SDKs are private in-repository ESM packages for Node.js 22.19.0+, unpublished on npm. Build and validate with `make sdk-test`.

## @areal/runtime

[Types](../../runtime/sdk-typescript/src/types.ts) · [Implementation](../../runtime/sdk-typescript/src/index.ts) · [Runtime wire](runtime.en.md)

A trusted host supplies exclusive Readable/Writable streams. Response streams cannot be shared; there is no endpoint, automatic reconnection or recovery lease.

```ts
import { RuntimeClient } from './runtime/sdk-typescript/dist/index.js';
const runtime = await RuntimeClient.connect(runtimeRead, runtimeWrite);
const scope = await runtime.scopes.create({
  operationId: runtime.operationId(),
  parentScopeId: runtime.info.rootScopeId,
  owner: { taskId: 'task-1' },
});
try {
  const file = await runtime.files.execute({
    operationId: runtime.operationId(), scopeId: scope.scopeId,
    command: { kind: 'read', path: 'workspace://repo/README.md', maxBytes: 4096 },
  });
  console.error(file.sha256);
} finally {
  await runtime.scopes.revoke(scope.scopeId);
  await runtime.scopes.waitClosed(scope.scopeId);
  await runtime.close();
}
```

The host creates runtimeRead/runtimeWrite; example imports are relative to repository root. Interfaces include scopes, owners, processes, files, operations, output/pages/bytes/text, supports/operationId and close/disconnect. processes supports start/get/wait/terminate/write/resize/closeStdin.

Each RPC accepts signal/timeoutMs. AbortSignal cancels only the waiter, not the operation; cleanup needs an independent wait. The default is 90 seconds. start/wait/files use handshake wallTimeMs + 90 seconds, bounded by Node timer limits; explicit timeoutMs wins. The SDK never retries automatically.

There are at most 128 in-flight requests, with 16 reserved for control, and 128 KiB frames. Malformed/unknown IDs, EOF and timeout close transport and may leave UNKNOWN outcomes. pages preserves gap/truncated/closed; bytes/text throw OutputGapError on loss and incrementally decode stdout/stderr/pty separately. close awaits cleanup; disconnect does not establish it.

## @areal/plugins

[Exported types](../../core/sdk-typescript/src/index.ts) · [Editor example](../examples/dsh-editor-plugin.en.md)

```ts
import * as editor from '@deepseek-ai/dsh-tool-str-replace-editor';
import { servePlugin } from './core/sdk-typescript/dist/index.js';
await servePlugin({
  plugin: editor,
  config: { maxOutputChars: 1000 },
  commands: { str_replace_editor: ['view', 'str_replace'] },
});
```

PluginOptions accepts plugin and optional config/commands/input/output. Default stdio is a dedicated protocol stream; log to stderr. It shares no connection with @areal/runtime.

tools.register allows 32 definitions during initialization only. execute context contains signal only; results are limited to 16 KiB. fs.resolve/stat/readText/writeText supports regular UTF-8 files below `/repo`, up to 32 KiB. Writes require createIfAbsent or replaceIfVersion. Observed versions are isolated by Thread and must be read again after restart/eviction. Injection accepts only tools/fs/sandboxPolicy; unknown DSH services fail.

The Host uses v1 JSONL, 128 KiB frames and a 10-second handshake. Each call allows 32 file requests, 16 concurrent and an 8 KiB journal. Calls within a Host are serial; Core binds callId/Scope/operationId. Timeout/cancellation closes the generation. Frozen objects are not isolation and Node code must be trusted. Native Host v2 process brokering is a [separate contract](native-host.en.md).
