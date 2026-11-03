// 生产只读接口的原生边界 fixture；不表示原生 Core 验收。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { reviewTurnFiles } = require("../packages/workspace-git");
const { ResultReviews } = require("../app/src/core/remote-result-review.cjs");
const { SessionObservers } = require("../app/src/core/remote-session-observer.cjs");
const project = {
  root: "/not-readable",
  endpoint: "ws://native-fixture",
  token: "secret",
  service: { serviceId: "s", generation: "g" },
  model: { state: { connected: true }, subscribe: () => () => {} },
  client: {
    ready: true,
    capabilities: {
      features: { atomicObserve: true, atomicObserveOwnership: true, subscriptionRemoval: true },
    },
    onClose: () => () => {},
  },
};
const grant = {
  devicePeerId: "peer",
  status: "active",
  revision: 1,
  capabilities: ["observe", "review"],
  projectIds: ["p"],
};
const remote = {
  gatewayGeneration: "gw",
  config: { deviceGrants: [grant] },
  backend: {
    saved: [{ id: "p" }],
    projects: new Map([["p", project]]),
    start() {
      throw Error("must not start");
    },
    openThread() {
      throw Error("must not open desktop");
    },
  },
};
const connection = {
  peer: "peer",
  connectionId: "c",
  grantRevision: 1,
  gatewayGeneration: "gw",
  alive: () => true,
};
let turn = {
  id: "turn",
  status: "failed",
  error: { message: "provider failed" },
  items: [
    { id: "text", type: "agentMessage", text: "partial <script> result", phase: "final_answer" },
  ],
};
let afterRead;
const observers = new SessionObservers(remote);
observers.connect = async (entry) => {
  entry.client = {
    close() {},
    request: async (method, params, options) => {
      assert.equal(method, "thread/read");
      assert.equal(params.threadId, "t");
      const result = { thread: { id: "t", turns: [structuredClone(turn)] } };
      await afterRead?.();
      options?.onResult?.(result);
      return result;
    },
  };
};
const reviews = new ResultReviews(observers);
const read = (params = { threadId: "t", turnId: "turn" }, conn = connection, projectId = "p") =>
  reviews.read(conn, projectId, params, (x) => x);
try {
  const page = await read();
  const content = JSON.parse(page.review.chunk);
  assert.equal(content.turnStatus, "failed");
  assert.equal(content.result[0].text, "partial <script> result");
  assert.equal(content.partial, true);
  assert.equal(content.diff.state, "unavailable");
  assert.equal(content.taskRunStatus, null);
  assert.equal(content.error.message, "provider failed");
  console.log("PASS original failed Turn retains partial output and separate Task Run status");
  const write = (itemId, path, value) => ({
    id: itemId,
    type: "dynamicToolCall",
    tool: "fs_create",
    status: "completed",
    success: true,
    execution: {
      backend: "runtime",
      outcome: "succeeded",
      effectiveArguments: { path: `workspace://repo/${path}`, text: value },
    },
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({
          path: `workspace://repo/${path}`,
          size: Buffer.byteLength(value),
          sha256: createHash("sha256").update(value).digest("hex"),
        }),
      },
    ],
  });
  turn = {
    id: "turn",
    status: "completed",
    items: [
      { id: "metadata", type: "fileChange", changes: [{ path: "a.txt" }, { path: "z.txt" }] },
      write("write-z", "z.txt", "Z content\n"),
      write("write-a", "a.txt", "A content\n"),
    ],
  };
  const nativeCreate = write("native-create", "native.txt", "Native original\n");
  nativeCreate.arguments = nativeCreate.execution.effectiveArguments;
  nativeCreate.execution.originalArguments = JSON.stringify({
    path: "workspace://repo/ignored.txt",
    text: "not executed",
  });
  delete nativeCreate.execution.effectiveArguments;
  const originalItems = turn.items;
  turn.items = [nativeCreate];
  const nativeReview = reviewTurnFiles(project.root, turn);
  assert.equal(nativeReview.files[0].path, "native.txt");
  assert.equal(nativeReview.files[0].beforeText, "");
  assert.equal(nativeReview.files[0].afterText, "Native original\n");
  const nativeDiff = JSON.parse((await read()).review.chunk).diff;
  assert.equal(nativeDiff.state, "available");
  assert.equal(
    nativeDiff.files[0].hunks[0].lines.find((line) => line.kind === "add").text,
    "Native original",
  );
  console.log(
    "PASS native parsed arguments without an effective override retain original created text",
  );
  const scratch = await mkdtemp(join(tmpdir(), "rc10-history-contract-"));
  try {
    project.root = scratch;
    await writeFile(join(scratch, "native.txt"), "Current workspace replacement\n");
    assert.equal(reviewTurnFiles(scratch, turn).files[0].afterText, "Native original\n");
    assert.equal(
      JSON.parse((await read()).review.chunk).diff.files[0].hunks[0].lines.find(
        (line) => line.kind === "add",
      ).text,
      "Native original",
    );
    assert.equal(
      await readFile(join(scratch, "native.txt"), "utf8"),
      "Current workspace replacement\n",
    );
  } finally {
    project.root = "/not-readable";
    await rm(scratch, { recursive: true, force: true });
  }
  const overridden = write("override", "effective.txt", "Effective text\n");
  overridden.arguments = { path: "workspace://repo/model.txt", text: "Model text\n" };
  overridden.execution.originalArguments = JSON.stringify(overridden.arguments);
  turn.items = [overridden];
  assert.equal(reviewTurnFiles(project.root, turn).files[0].path, "effective.txt");
  assert.equal(reviewTurnFiles(project.root, turn).files[0].afterText, "Effective text\n");
  const overrideDiff = JSON.parse((await read()).review.chunk).diff;
  assert.equal(overrideDiff.state, "available");
  assert.equal(overrideDiff.files[0].path, "effective.txt");
  const nativeRecord = (id, tool, args, text, extra = {}) => ({
    ...write(id, "chain.txt", text),
    tool,
    arguments: { path: "workspace://repo/chain.txt", ...args },
    execution: { backend: "runtime", outcome: "succeeded", originalArguments: "not parsed" },
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({
          path: "workspace://repo/chain.txt",
          size: Buffer.byteLength(text),
          sha256: createHash("sha256").update(text).digest("hex"),
          ...extra,
        }),
      },
    ],
  });
  const beforeHash = createHash("sha256").update("Before\n").digest("hex");
  const afterHash = createHash("sha256").update("After\n").digest("hex");
  const nativeRead = nativeRecord("read", "fs_read", { offset: 0, maxBytes: 1000000 }, "Before\n", {
    text: "Before\n",
    eof: true,
  });
  const nativeWrite = nativeRecord(
    "write",
    "fs_write",
    { text: "After\n", expectedSha256: beforeHash },
    "After\n",
  );
  const nativePatch = nativeRecord(
    "patch",
    "fs_apply_patches",
    { patches: [{ oldText: "After", newText: "Final" }], expectedSha256: afterHash },
    "Final\n",
  );
  turn.items = [nativeRead, nativeWrite, nativePatch];
  const chain = reviewTurnFiles(project.root, turn);
  assert.equal(chain.files[0].beforeText, "Before\n");
  assert.equal(chain.files[0].afterText, "Final\n");
  const selectedWrite = reviewTurnFiles(project.root, turn, { itemId: "write" });
  assert.equal(selectedWrite.files[0].beforeText, "Before\n");
  assert.equal(selectedWrite.files[0].afterText, "After\n");
  const selectedPatch = reviewTurnFiles(project.root, turn, { itemId: "patch" });
  assert.equal(selectedPatch.files[0].beforeText, "After\n");
  assert.equal(selectedPatch.files[0].afterText, "Final\n");
  const driftedBefore = "Externally formatted\n";
  const driftedHash = createHash("sha256").update(driftedBefore).digest("hex");
  const driftedWrite = nativeRecord(
    "drifted-write",
    "fs_write",
    { text: "Later tool change\n", expectedSha256: driftedHash },
    "Later tool change\n",
  );
  driftedWrite.execution.fileBefore = {
    uri: `areal://blob/${driftedHash}`,
    mimeType: "application/octet-stream",
    sizeBytes: Buffer.byteLength(driftedBefore),
  };
  const fileBefores = new Map([[driftedWrite.id, Buffer.from(driftedBefore)]]);
  const driftedTurn = { ...turn, items: [nativeRead, nativeWrite, nativeCreate, driftedWrite] };
  assert.throws(() => reviewTurnFiles(project.root, driftedTurn, { fileBefores }), /外部变化/);
  const partial = reviewTurnFiles(project.root, driftedTurn, { fileBefores, allowPartial: true });
  assert.deepEqual(
    partial.files.map((file) => file.path),
    ["native.txt"],
    "one broken chain does not hide other verified files",
  );
  assert.deepEqual(
    partial.unavailableFiles.map((file) => file.path),
    ["chain.txt"],
  );
  assert.match(partial.unavailableFiles[0].reason, /外部变化/);
  assert.match(partial.notice, /未包含/);
  assert.ok(!partial.diff.includes("chain.txt"), "external edits never enter the attributed Diff");
  assert.equal(
    reviewTurnFiles(project.root, driftedTurn, {
      itemId: driftedWrite.id,
      fileBefores,
    }).files[0].beforeText,
    driftedBefore,
    "the individual write remains verifiable",
  );
  const allUnavailable = reviewTurnFiles(
    project.root,
    {
      ...driftedTurn,
      items: [nativeRead, nativeWrite, driftedWrite],
    },
    { fileBefores, allowPartial: true },
  );
  assert.equal(allUnavailable.files.length, 0);
  assert.equal(
    allUnavailable.unavailableFiles.length,
    1,
    "an unavailable file is never a verified zero",
  );
  assert.deepEqual(
    reviewTurnFiles(project.root, turn, { allowPartial: true }).unavailableFiles,
    [],
  );
  const chainDiff = JSON.parse((await read()).review.chunk).diff;
  assert.equal(chainDiff.state, "available");
  assert.ok(
    chainDiff.files[0].hunks[0].lines.some((line) => line.kind === "del" && line.text === "Before"),
  );
  assert.ok(
    chainDiff.files[0].hunks[0].lines.some((line) => line.kind === "add" && line.text === "Final"),
  );
  const selectedDiff = JSON.parse(
    (await read({ threadId: "t", turnId: "turn", itemId: "write" })).review.chunk,
  ).diff;
  assert.equal(selectedDiff.scope, "tool");
  assert.ok(
    selectedDiff.files[0].hunks[0].lines.some(
      (line) => line.kind === "add" && line.text === "After",
    ),
  );
  const unavailable = async (items, label) => {
    turn.items = items;
    assert.throws(() => reviewTurnFiles(project.root, turn), undefined, label);
    assert.equal(JSON.parse((await read()).review.chunk).diff.state, "unavailable", label);
  };
  for (const effectiveArguments of [
    null,
    undefined,
    "malformed",
    [],
    1,
    {},
    { path: nativeCreate.arguments.path },
  ]) {
    const item = structuredClone(nativeCreate);
    item.execution.effectiveArguments = effectiveArguments;
    await unavailable(
      [item],
      "present invalid effective arguments never use valid parsed arguments",
    );
  }
  for (const args of [undefined, null, "malformed", [], 1, {}]) {
    const item = structuredClone(nativeCreate);
    item.arguments = args;
    item.execution.originalArguments = JSON.stringify(nativeCreate.arguments);
    item.execution.modelArguments = nativeCreate.arguments;
    await unavailable(
      [item],
      "missing or primitive parsed arguments never use raw/model arguments",
    );
  }
  for (const change of [
    { path: "workspace://repo/other.txt" },
    { size: 999 },
    { sha256: "0".repeat(64) },
  ]) {
    const item = structuredClone(nativeCreate);
    item.contentItems[0].text = JSON.stringify({
      ...JSON.parse(item.contentItems[0].text),
      ...change,
    });
    await unavailable([item], "native path/size/hash confirmation remains mandatory");
  }
  const transformedPathMismatch = structuredClone(nativeCreate);
  transformedPathMismatch.execution.effectiveArguments = {
    ...transformedPathMismatch.arguments,
    path: "workspace://repo/hook-target.txt",
  };
  await unavailable(
    [transformedPathMismatch],
    "rewritten argument path cannot correct the exposed result path",
  );
  const wrongBefore = structuredClone(nativeWrite);
  wrongBefore.arguments.expectedSha256 = "0".repeat(64);
  await unavailable([nativeRead, wrongBefore], "write must follow the verified before hash");
  const rangedRead = structuredClone(nativeRead);
  rangedRead.arguments.offset = 1;
  await unavailable(
    [rangedRead, nativeWrite],
    "a nonzero read offset cannot seed the full before text",
  );
  const singlePatch = structuredClone(nativePatch);
  singlePatch.tool = "fs_apply_patch";
  turn.items = [nativeRead, nativeWrite, singlePatch];
  assert.equal(reviewTurnFiles(project.root, turn).files[0].afterText, "Final\n");
  assert.equal(JSON.parse((await read()).review.chunk).diff.state, "available");
  await unavailable([nativeWrite], "write requires the original before version");
  await unavailable([nativePatch], "patch requires the original before version");
  for (const change of [
    { eof: false },
    { text: "partial" },
    { size: 999 },
    { sha256: "0".repeat(64) },
  ]) {
    const item = structuredClone(nativeRead);
    item.contentItems[0].text = JSON.stringify({
      ...JSON.parse(item.contentItems[0].text),
      ...change,
    });
    await unavailable(
      [item, nativeWrite],
      "partial or unverified reads cannot seed a before version",
    );
  }
  for (const outcome of ["unknown", "failed"]) {
    const item = structuredClone(nativeCreate);
    item.execution.outcome = outcome;
    turn.items = [item];
    assert.equal(reviewTurnFiles(project.root, turn).files.length, 0);
    assert.equal(JSON.parse((await read()).review.chunk).diff.state, "unavailable");
    assert.throws(() => reviewTurnFiles(project.root, turn, { itemId: item.id }));
  }
  for (const change of [{ success: false }, { status: "failed" }, { status: "started" }]) {
    turn.items = [{ ...structuredClone(nativeCreate), ...change }];
    assert.equal(reviewTurnFiles(project.root, turn).files.length, 0);
    assert.equal(JSON.parse((await read()).review.chunk).diff.state, "unavailable");
  }
  turn.items = [nativeCreate];
  turn.status = "failed";
  assert.throws(() => reviewTurnFiles(project.root, turn));
  assert.equal(JSON.parse((await read()).review.chunk).diff.state, "unavailable");
  turn.status = "completed";
  console.log(
    "PASS effective precedence, native read/write/patch versions, fail-closed records and workspace independence",
  );
  turn.items = originalItems;
  const diff = JSON.parse((await read()).review.chunk).diff;
  assert.deepEqual(
    diff.files.map((f) => [f.path, f.hunks[0].lines.find((l) => l.kind === "add").text]),
    [
      ["z.txt", "Z content"],
      ["a.txt", "A content"],
    ],
  );
  assert.match(diff.notice, /Shell/);
  turn.items = [write("binary", "binary.dat", "hello\0binary\n")];
  assert.equal(
    JSON.parse((await read()).review.chunk).diff.state,
    "unavailable",
    "NUL-bearing native write is binary history",
  );
  for (const tool of ["run_command", "fs_rename", "fs_remove"]) {
    turn.items = [{ ...write("unsupported", "a.txt", "not evidence"), tool }];
    assert.equal(JSON.parse((await read()).review.chunk).diff.state, "unavailable");
  }
  turn.items = [{ ...write("missing-before", "a.txt", "next"), tool: "fs_write" }];
  assert.equal(JSON.parse((await read()).review.chunk).diff.state, "unavailable");
  turn.items = [{ id: "long", type: "agentMessage", text: "界".repeat(20000) }];
  let paged = "",
    cursor;
  do {
    const page = await read({ threadId: "t", turnId: "turn", ...(cursor ? { cursor } : {}) });
    assert.equal(page.review.offset, Buffer.byteLength(paged));
    assert.ok(Buffer.byteLength(page.review.chunk) <= 16384);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
    paged += page.review.chunk;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(JSON.parse(paged).result[0].text, "界".repeat(20000));
  const staleCursor = (await read()).nextCursor;
  turn.items[0].text = "changed";
  await assert.rejects(read({ threadId: "t", turnId: "turn", cursor: staleCursor }), {
    code: "TARGET_CHANGED",
  });
  await assert.rejects(read({ threadId: "t", turnId: "missing" }), {
    code: "RESOURCE_UNAVAILABLE",
  });
  await assert.rejects(read({ threadId: "t", turnId: "turn", itemId: "missing" }), {
    code: "RESOURCE_UNAVAILABLE",
  });
  await assert.rejects(read({ threadId: "t", turnId: "turn", url: "http://untrusted" }), {
    code: "INVALID_PARAMS",
  });
  grant.capabilities = ["observe"];
  await assert.rejects(read(), { code: "FORBIDDEN" });
  grant.capabilities = ["observe", "review"];
  afterRead = () => {
    grant.revision++;
  };
  await assert.rejects(read(), { code: "GRANT_CHANGED" });
  afterRead = undefined;
  grant.revision = 1;
  console.log(
    "PASS path-key historical hunks, unsupported history, UTF-8 pages, stale cursor and revoked authority",
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = createHash("sha256").update(png).digest("hex");
  turn = {
    id: "turn",
    status: "completed",
    items: [
      {
        id: "image",
        type: "agentMedia",
        modality: "image",
        media: { uri: `areal://blob/${digest}`, mimeType: "image/png", sizeBytes: png.length },
      },
    ],
  };
  const mediaPage = await read();
  assert.equal(mediaPage.artifacts.length, 1);
  const ref = mediaPage.artifacts[0].artifactRef;
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetches++;
    assert.equal(url.hostname, "native-fixture");
    assert.equal(options.redirect, "error");
    return new Response(png);
  };
  try {
    const chunk = await reviews.artifact(
      connection,
      "p",
      { artifactRef: ref, offset: 0, length: 48 * 1024 },
      (x) => x,
    );
    assert.deepEqual(Buffer.from(chunk.base64, "base64"), png);
    assert.deepEqual(chunk.raster, { mime: "image/png", width: 1, height: 1 });
    await assert.rejects(
      reviews.artifact(
        { ...connection, connectionId: "other" },
        "p",
        { artifactRef: ref, offset: 0, length: 1 },
        (x) => x,
      ),
    );
    assert.equal(fetches, 1);
    turn.id = "other-turn";
    await assert.rejects(
      reviews.artifact(connection, "p", { artifactRef: ref, offset: 0, length: 1 }, (x) => x),
    );
    assert.equal(fetches, 1);
    console.log("PASS same native blob is not authority for a different Turn/connection");
    turn.id = "turn";
    const artifact = (params = {}) =>
      reviews.artifact(
        connection,
        "p",
        { artifactRef: ref, offset: 0, length: 48 * 1024, ...params },
        (x) => x,
      );
    await assert.rejects(artifact({ length: 48 * 1024 + 1 }), { code: "INVALID_PARAMS" });
    await assert.rejects(artifact({ artifactRef: "areal://blob/" + digest }), {
      code: "RESOURCE_UNAVAILABLE",
    });
    await assert.rejects(
      reviews.artifact(
        connection,
        "other-project",
        { artifactRef: ref, offset: 0, length: 1 },
        (x) => x,
      ),
      { code: "FORBIDDEN" },
    );
    project.service.generation = "other";
    await assert.rejects(artifact(), { code: "RESYNC_REQUIRED" });
    project.service.generation = "g";
    const item = turn.items[0];
    item.media.sizeBytes = 16 * 1024 * 1024 + 1;
    assert.deepEqual((await read()).artifacts, []);
    await assert.rejects(artifact(), { code: "RESOURCE_UNAVAILABLE" });
    item.media.sizeBytes = png.length;
    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(artifact(), { code: "RESOURCE_UNAVAILABLE" });
    let cancelled = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(png.length + 1));
          },
          cancel() {
            cancelled++;
          },
        }),
      );
    await assert.rejects(artifact(), { code: "RESOURCE_UNAVAILABLE" });
    assert.equal(cancelled, 1);
    globalThis.fetch = async () => new Response(png.subarray(0, -1));
    await assert.rejects(artifact(), { code: "RESOURCE_UNAVAILABLE" });
    globalThis.fetch = async () => new Response(png, { headers: { "content-length": "9999" } });
    await assert.rejects(artifact(), { code: "RESOURCE_UNAVAILABLE" });
    globalThis.fetch = async () => {
      grant.revision++;
      return new Response(png);
    };
    await assert.rejects(artifact(), { code: "GRANT_CHANGED" });
    grant.revision = 1;
    let published = false;
    globalThis.fetch = async () => {
      turn.items = [];
      return new Response(png);
    };
    await assert.rejects(
      reviews.artifact(connection, "p", { artifactRef: ref, offset: 0, length: 1 }, () => {
        published = true;
      }),
      { code: "RESOURCE_UNAVAILABLE" },
    );
    assert.equal(published, false);
    afterRead = undefined;
    turn.items = [item];
    for (const [label, bytes, mime] of [
      ["fake PNG", Buffer.from("<html>untrusted body</html>"), "image/png"],
      ["fake SVG", Buffer.from("<svg width='1'></svg>"), "image/png"],
      ["dimension budget", Buffer.from(png), "image/png"],
    ]) {
      if (label === "dimension budget") bytes.writeUInt32BE(100000, 16);
      item.media = {
        uri: "areal://blob/" + createHash("sha256").update(bytes).digest("hex"),
        mimeType: mime,
        sizeBytes: bytes.length,
      };
      const badRef = (await read()).artifacts[0].artifactRef;
      globalThis.fetch = async () => new Response(bytes);
      await assert.rejects(
        artifact({ artifactRef: badRef }),
        { code: "RESOURCE_UNAVAILABLE" },
        label,
      );
    }
    item.media = { uri: `areal://blob/${digest}`, mimeType: "image/png", sizeBytes: png.length };
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(png.subarray(0, 5));
            grant.revision++;
          },
          cancel() {
            cancelled++;
          },
        }),
      );
    await assert.rejects(artifact(), { code: "GRANT_CHANGED" });
    grant.revision = 1;
    assert.ok(cancelled >= 2);
    console.log(
      "PASS native stream cancellation, size mismatch, vanished bytes, dimensional safety and post-await membership/revocation",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
} finally {
  observers.close();
}

const { test } = await import("node:test");
if (!process.env.RC12_TLS_HOME) {
  test("Rust review denial sources use the isolated process CA", { timeout: 240000 }, async () => {
    const { runWithIsolatedCA } = await import("./remote-native-push-fixture.mjs");
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "Rust Host rejects changed review cursors, foreign connection refs and invalid native images",
    { timeout: 180000 },
    async (t) => {
      const { nativeReviewNegatives } = await import("./remote-review-native-negative-fixture.mjs");
      await nativeReviewNegatives(t);
    },
  );
}
