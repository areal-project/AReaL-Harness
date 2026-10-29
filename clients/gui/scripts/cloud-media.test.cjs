"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { mediaCommand } = require("../app/src/core/media.cjs");
const { readFileSync } = require("node:fs");
const ts = require("../renderer/node_modules/typescript");
const compiled = ts.transpileModule(
  readFileSync(require.resolve("../renderer/src/ComposerUploads.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
const exportsObject = {};
new Function("exports", compiled)(exportsObject);
test("Cloud media preserves workspace path, credentials and thread query, and treats incomplete receipts as unknown", async (t) => {
  let malformed = false;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    res.end(
      malformed
        ? "{"
        : JSON.stringify({ uri: "areal://blob/abc", mimeType: "image/png", sizeBytes: 3 }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const project = {
    endpoint: `ws://127.0.0.1:${server.address().port}/openapi/v1/app-server/work/`,
    token: "test-token",
    model: { state: { threads: { thread: {} } } },
  };
  const request = {
    projectId: "p",
    threadId: "thread",
    operation: "upload",
    mime: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
  };
  for (const prefix of ["/", "/proxy/core/", "/openapi/v1/app-server/work/"]) {
    project.endpoint = `ws://127.0.0.1:${server.address().port}${prefix}`;
    assert.equal((await mediaCommand(project, request, {})).uri, "areal://blob/abc");
    assert.deepEqual(seen.at(-1), {
      path: `${prefix}areal/blobs?threadId=thread`,
      auth: "Bearer test-token",
    });
    const read = await mediaCommand(
      project,
      { ...request, operation: "read", uri: "areal://blob/abc" },
      {},
    );
    assert.ok(read.bytes.length > 0);
    assert.deepEqual(seen.at(-1), {
      path: `${prefix}areal/blobs/abc?threadId=thread`,
      auth: "Bearer test-token",
    });
  }
  malformed = true;
  await assert.rejects(mediaCommand(project, request, {}), (e) => e.submissionUnknown === true);
  await assert.rejects(mediaCommand(project, { ...request, threadId: "other" }, {}), /所属会话/);
});
test("partial batch upload reuses accepted receipts when the second file is retried", async () => {
  const first = new File(["a"], "a.txt", { type: "text/plain" }),
    second = new File(["b"], "b.txt", { type: "text/plain" });
  const accepted = new Map();
  let calls = 0,
    fail = true;
  const action = async () => {
    calls++;
    if (calls === 2 && fail) throw new Error("quota");
    return { uri: "areal://blob/" + calls, mimeType: "text/plain", sizeBytes: 1 };
  };
  await assert.rejects(
    exportsObject.uploadComposerFiles(action, "p", "t", [first, second], accepted),
    /quota/,
  );
  fail = false;
  const result = await exportsObject.uploadComposerFiles(
    action,
    "p",
    "t",
    [first, second],
    accepted,
  );
  assert.equal(calls, 3);
  assert.equal(result[0].url, "areal://blob/1");
  assert.equal(result[1].url, "areal://blob/3");
});

test("Cloud desktop contract admits attachment-only input and rejects local paths", () => {
  const { validateCommand } = require("../packages/workbench/client/desktop-contract.cjs");
  const params = {
    operation: "send",
    projectId: "p",
    threadId: "t",
    text: "",
    attachments: [{ type: "image", url: "areal://blob/abc" }],
  };
  assert.doesNotThrow(() => validateCommand("cloudSession", params));
  assert.throws(() => validateCommand("cloudSession", { ...params, attachments: [] }));
  assert.throws(() =>
    validateCommand("cloudSession", {
      ...params,
      attachments: [{ type: "image", url: "file:///private/image.png" }],
    }),
  );
});

test("5xx with a broken response body is still an unknown upload", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 503,
    text: async () => {
      throw new Error("body disconnected");
    },
  }));
  const project = {
    endpoint: "ws://example.test/work/",
    token: "test",
    model: { state: { threads: { thread: {} } } },
  };
  await assert.rejects(
    mediaCommand(
      project,
      {
        projectId: "p",
        threadId: "thread",
        operation: "upload",
        mime: "image/png",
        bytes: new Uint8Array([1]),
      },
      {},
    ),
    (error) => error.submissionUnknown === true,
  );
});
