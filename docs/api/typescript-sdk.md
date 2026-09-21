**中文** | [English](typescript-sdk.en.md)

# TypeScript SDK

两套 SDK 均为仓库内 private ESM 包，Node.js 22.19.0+，未发布 npm。通过 `make sdk-test` 编译并验证。

## @areal/runtime

[类型](../../runtime/sdk-typescript/src/types.ts) · [实现](../../runtime/sdk-typescript/src/index.ts) · [Runtime wire](runtime.md)

可信宿主提供独占 Readable/Writable，不能共享响应流；没有 endpoint、自动重连或恢复租约。

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

runtimeRead/runtimeWrite 由宿主创建，示例导入路径相对仓库根。接口包括 scopes、owners、processes、files、operations、output/pages/bytes/text、supports/operationId、close/disconnect。processes 支持 start/get/wait/terminate/write/resize/closeStdin。

每个 RPC 可带 signal/timeoutMs。AbortSignal 只取消等待者，不撤销操作；清理用独立等待。默认 90 秒，start/wait/files 使用握手 wallTimeMs + 90 秒（受 Node 定时器上限约束），显式 timeoutMs 优先。SDK 不自动重试。

最多 128 在途、16 保留控制；帧限 128 KiB。畸形/未知 ID/EOF/超时封闭传输，结果可能 UNKNOWN。pages 保留 gap/truncated/closed；bytes/text 遇输出丢失抛 OutputGapError，并按 stdout/stderr/pty 分别持续解码。close 等待清理，disconnect 不表示清理成功。

## @areal/plugins

[导出类型](../../core/sdk-typescript/src/index.ts) · [编辑器示例](../examples/dsh-editor-plugin.md)

```ts
import * as editor from '@deepseek-ai/dsh-tool-str-replace-editor';
import { servePlugin } from './core/sdk-typescript/dist/index.js';
await servePlugin({
  plugin: editor,
  config: { maxOutputChars: 1000 },
  commands: { str_replace_editor: ['view', 'str_replace'] },
});
```

PluginOptions 接收 plugin、可选 config/commands/input/output；默认 stdio 为专用协议流，日志写 stderr。与 @areal/runtime 不共享连接。

tools.register 仅初始化时最多 32 项；execute context 只有 signal，结果限 16 KiB。fs.resolve/stat/readText/writeText 支持 `/repo` 下普通 UTF-8 文件，限 32 KiB；写入必须 createIfAbsent 或 replaceIfVersion。观察版本按 Thread 隔离，重启/淘汰后重新读取。仅接受 tools/fs/sandboxPolicy 注入，未知 DSH 服务拒绝。

Host 使用 v1 JSONL，128 KiB 帧，10 秒握手；每调用最多 32 文件请求、16 同时在途，journal 8 KiB。同 Host 串行，Core 绑定 callId/Scope/operationId，超时/取消关闭 generation。冻结对象不是隔离，Node 代码必须可信。Native Host v2 的进程 broker 是[另一契约](native-host.md)。
