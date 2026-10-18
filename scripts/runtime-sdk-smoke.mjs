// Verify the published SDK surface against real Runtime pipes and the native backend.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeClient } from "../runtime/sdk-typescript/dist/index.js";

const workspace = process.argv[2];
assert(workspace, "start with python3 scripts/runtime-sdk-smoke.py");
let client;
try {
  client = await RuntimeClient.connect(process.stdin, process.stdout, {
    timeoutMs: 10000,
  });
  const scope = await client.scopes.create({
    operationId: client.operationId(),
    parentScopeId: client.info.rootScopeId,
    owner: { taskId: "sdk-smoke", pluginInstanceId: "sdk-plugin:1" },
  });
  const write = {
    operationId: client.operationId(),
    scopeId: scope.scopeId,
    command: {
      kind: "write",
      path: "workspace://repo/code",
      dataBase64: Buffer.from("你好").toString("base64"),
      expected: { kind: "absent" },
    },
  };
  const written = await client.files.execute(write);
  assert.deepEqual(await client.files.execute(write), written);
  const file = await client.files.execute({
    operationId: client.operationId(),
    scopeId: scope.scopeId,
    command: {
      kind: "read",
      path: "workspace://repo/code",
      offset: 0,
      maxBytes: 16384,
    },
  });
  assert.equal(Buffer.from(file.dataBase64, "base64").toString(), "你好");
  assert.equal(file.sha256, written.sha256);
  assert.equal(await readFile(join(workspace, "code"), "utf8"), "你好");
  await assert.rejects(
    client.files.execute({ ...write, operationId: client.operationId() }),
    (error) => error.code === "CONFLICT",
  );
  const execution = await client.processes.start({
    operationId: client.operationId(),
    scopeId: scope.scopeId,
    argv: ["/bin/sh", "-c", 'read line; printf "received:%s" "$line"'],
    cwd: "workspace://repo",
    tty: true,
    pipeStdin: true,
  });
  const input = {
    operationId: client.operationId(),
    processId: execution.processId,
    dataBase64: Buffer.from("中文\n").toString("base64"),
  };
  assert.deepEqual(await client.processes.write(input), { accepted: true });
  assert.deepEqual(await client.processes.write(input), { accepted: true });
  let output = "";
  for await (const chunk of client.text({
    processId: execution.processId,
    maxBytes: 7,
  })) {
    assert.equal(chunk.stream, "pty");
    output += chunk.text;
  }
  assert(output.includes("received:中文"), output);
  assert.equal((await client.processes.wait(execution.processId)).exitCode, 0);
  await client.owners.revoke("sdk-plugin:1");
  assert.equal((await client.scopes.waitClosed(scope.scopeId)).state, "closed");
  await assert.rejects(
    client.scopes.create({
      operationId: client.operationId(),
      parentScopeId: client.info.rootScopeId,
      owner: { taskId: "stale", pluginInstanceId: "sdk-plugin:1" },
    }),
    (error) => error.code === "SCOPE_CLOSED",
  );
  await client.close();
  console.error(
    "PASS native TypeScript SDK: conditional files, operation replay, TTY Unicode input/output, owner revocation and confirmed cleanup",
  );
} finally {
  client?.disconnect();
}
