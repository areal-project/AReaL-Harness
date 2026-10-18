import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { RuntimeClient, OutputGapError, decodeBase64 } from "../dist/index.js";

async function fixture(handle, capabilities = {}) {
  const read = new PassThrough(),
    write = new PassThrough();
  let buffer = "";
  const requests = [];
  const reply = (id, result) => read.write(JSON.stringify({ id, result }) + "\n");
  write.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const request = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      requests.push(request);
      if (request.method === "connection.open")
        reply(request.id, {
          protocolVersion: "areal.runtime.v0",
          runtimeEpoch: "fixture-epoch",
          rootScopeId: "root",
          connectionId: "connection",
          capabilities: {
            ...capabilities,
            methods: [
              "connection.close",
              "process.start",
              "process.wait",
              "scope.get",
              "scope.revoke",
              "output.read",
              "fs.execute",
              "process.write",
            ],
          },
        });
      else if (request.method === "connection.close") reply(request.id, { closed: true });
      else handle(request, reply);
    }
  });
  return {
    client: await RuntimeClient.connect(read, write),
    read,
    write,
    requests,
    reply,
  };
}

test("execution waits inherit the Runtime deadline and leave control requests usable", async (t) => {
  const waiting = [];
  const f = await fixture(
    (request, reply) => {
      if (["process.start", "process.wait", "fs.execute"].includes(request.method))
        waiting.push(request);
      else reply(request.id, { scopeId: "root", state: "revoking" });
    },
    { processLimits: { wallTimeMs: 300000 } },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const requests = [
      f.client.processes.start({
        operationId: "start",
        scopeId: "root",
        argv: ["fixture"],
        cwd: "workspace://repo",
      }),
      f.client.processes.wait("process"),
      f.client.files.execute({
        operationId: "read",
        scopeId: "root",
        command: { kind: "read", path: "workspace://repo/file", maxBytes: 65536 },
      }),
    ];
    const completed = Promise.all(requests);
    t.mock.timers.tick(180000);
    assert.equal((await f.client.scopes.revoke("root")).state, "revoking");
    for (const request of waiting) f.reply(request.id, { confirmed: true });
    assert.equal((await completed).length, 3);
    await f.client.close();
  } finally {
    f.client.disconnect();
    t.mock.timers.reset();
  }
});

test("explicit deadlines and ordinary control deadlines still fence an unresponsive transport", async (t) => {
  for (const explicit of [true, false]) {
    const f = await fixture(() => {}, { processLimits: { wallTimeMs: 300000 } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const request = explicit
        ? f.client.processes.wait("process", { timeoutMs: 1234 })
        : f.client.scopes.get("root");
      const failed = assert.rejects(request, (error) => error.code === "UNAVAILABLE");
      t.mock.timers.tick(explicit ? 1234 : 90000);
      await failed;
      assert.equal(f.read.destroyed, true);
      assert.equal(f.write.destroyed, true);
    } finally {
      f.client.disconnect();
      t.mock.timers.reset();
    }
  }
});

test("execution deadlines support legacy handshakes and bound oversized timer values", async (t) => {
  for (const wallTimeMs of [undefined, 0, -1, "300000", Number.MAX_SAFE_INTEGER]) {
    const f = await fixture(() => {}, { processLimits: { wallTimeMs } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const failed = assert.rejects(
        f.client.processes.wait("process"),
        (error) => error.code === "UNAVAILABLE",
      );
      t.mock.timers.tick(wallTimeMs === Number.MAX_SAFE_INTEGER ? 2147483647 : 90000);
      await failed;
    } finally {
      f.client.disconnect();
      t.mock.timers.reset();
    }
  }
});

test("abort cancels only the waiter; a late result remains correlated and close is explicit", async () => {
  let delayed;
  const f = await fixture((request, reply) => {
    if (request.method === "process.start") delayed = request;
    else reply(request.id, { scopeId: "root" });
  });
  const abort = new AbortController();
  const pending = f.client.processes.start(
    {
      operationId: "same-logical-operation",
      scopeId: "root",
      argv: ["fixture"],
      cwd: "workspace://repo",
    },
    { signal: abort.signal },
  );
  abort.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  f.reply(delayed.id, { processId: "process", scopeId: "root" });
  assert.equal((await f.client.scopes.get("root")).scopeId, "root");
  assert.equal(f.requests.filter((request) => request.method === "process.start").length, 1);
  assert.equal(
    f.requests.some((request) => request.method === "scope.revoke"),
    false,
  );
  await f.client.close();
  await f.client.close();
  assert.equal(f.requests.filter((request) => request.method === "connection.close").length, 1);
});

test("Unicode survives page and stream boundaries; gaps retain the recovery cursor", async () => {
  const encoded = Buffer.from("你好");
  let reads = 0;
  const f = await fixture((request, reply) => {
    reads++;
    if (reads <= 2)
      reply(request.id, {
        chunks: [
          {
            cursor: `process/${reads}`,
            stream: "pty",
            dataBase64: encoded
              .subarray(reads === 1 ? 0 : 2, reads === 1 ? 2 : 6)
              .toString("base64"),
          },
        ],
        nextCursor: `process/${reads}`,
        gap: false,
        truncated: false,
        closed: reads === 2,
      });
    else
      reply(request.id, {
        chunks: [],
        nextCursor: "process/99",
        gap: true,
        truncated: false,
        closed: true,
      });
  });
  let text = "";
  for await (const chunk of f.client.text({
    processId: "process",
    maxBytes: 100,
  })) {
    assert.equal(chunk.stream, "pty");
    text += chunk.text;
  }
  assert.equal(text, "你好");
  await assert.rejects(
    async () => {
      for await (const _chunk of f.client.bytes({
        processId: "process",
        maxBytes: 100,
      })) {
      }
    },
    (error) => error instanceof OutputGapError && error.page.nextCursor === "process/99",
  );
  await f.client.close();
});

test("reserved control capacity survives a flood of aborted waits", async () => {
  const f = await fixture((request, reply) => {
    if (request.method === "scope.revoke")
      reply(request.id, { scopeId: "root", state: "revoking" });
  });
  for (let i = 0; i < 112; i++) {
    const controller = new AbortController();
    const wait = f.client.processes.wait("process", {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(wait);
  }
  await assert.rejects(
    f.client.processes.wait("process"),
    (error) => error.code === "RESOURCE_EXHAUSTED",
  );
  assert.equal((await f.client.scopes.revoke("root")).state, "revoking");
  await f.client.close();
});

test("EOF, invalid frames and deadlines are failures without automatic retry", async () => {
  for (const failure of ["eof", "frame", "timeout"]) {
    const f = await fixture(() => {});
    const wait = f.client.processes.wait("process", { timeoutMs: 20 });
    if (failure === "eof") f.read.end();
    if (failure === "frame") f.read.write(Buffer.alloc(128 * 1024 + 1, 65));
    await assert.rejects(wait, (error) => error.code === "UNAVAILABLE");
    await assert.rejects(f.client.close(), (error) => error.code === "UNAVAILABLE");
    assert.equal(f.requests.filter((request) => request.method === "process.wait").length, 1);
  }
  assert.throws(() => decodeBase64("a==="));
  assert.throws(() => decodeBase64("Zh=="));
});

test("file and input mutations preserve caller operation IDs and gate unsupported methods", async () => {
  const f = await fixture((request, reply) =>
    reply(
      request.id,
      request.method === "process.write" ? { accepted: true } : { sha256: "hash", size: 3 },
    ),
  );
  const id = f.client.operationId();
  assert.match(id, /^fixture-epoch:op:/);
  await f.client.files.execute({
    operationId: id,
    scopeId: "root",
    command: {
      kind: "write",
      path: "workspace://repo/a",
      dataBase64: "YWJj",
      expected: { kind: "absent" },
    },
  });
  assert.equal(f.requests.at(-1).params.operationId, id);
  await f.client.processes.write({
    operationId: "fixed-input-id",
    processId: "process",
    dataBase64: "YQ==",
  });
  assert.equal(f.requests.at(-1).params.operationId, "fixed-input-id");
  await assert.rejects(f.client.owners.revoke("owner"), (error) => error.code === "UNSUPPORTED");
  await f.client.close();
});
