import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, phone, until } from "./remote-native-push-fixture.mjs";

export async function nativeReviewTransport(t) {
  const relay = await pushRelay(t);
  const f = await nativeHostFixture(t);
  const project = await nativeCoreProject(t, f);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = createHash("sha256").update(png).digest("hex");
  const text = "partial <script> result " + "界".repeat(20000);
  const proof = { owner: "Rust Host", projectId: project.projectId, responses: [] };
  t.after(() =>
    writeFile(
      join(f.evidence.root, "native-review-transport.json"),
      JSON.stringify(proof, null, 2),
    ),
  );
  let held = false;
  let wrote = false;
  const model = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (JSON.stringify(body.input).includes("REVIEW_RUNNING_TASK")) {
      held = true;
      return;
    }
    if (JSON.stringify(body.input).includes("REVIEW_HISTORY_TOOL")) {
      const events = wrote
        ? [{ type: "response.output_text.delta", delta: "Original Runtime write complete" }]
        : [
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: randomUUID(),
                call_id: randomUUID(),
                name: "fs_create",
                arguments: JSON.stringify({
                  path: "review-native.txt",
                  text: "Original Runtime text\n",
                }),
              },
            },
          ];
      wrote = true;
      events.push({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      [
        { type: "response.output_text.delta", delta: text },
        {
          type: "response.output_item.done",
          item: { type: "image_generation_call", result: png.toString("base64") },
        },
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: {
              type: "invalid_request_error",
              code: "invalid_request_error",
              message: "partial model error",
            },
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  });
  await project.core.call("areal/provider/upsert", {
    provider: {
      id: "fixture-review",
      revision: 0,
      endpoint: `http://127.0.0.1:${model.address().port}/v1/responses`,
      protocol: "responses",
      models: ["fixture"],
      parameters: {},
    },
    expectedRevision: 0,
  });
  await f.remote.control({
    operation: "enable",
    relay: relay.origin,
    code: relay.enrollment(),
    confirmed: true,
  });
  await until(async () => (await f.remote.refresh()).connected, "native review Relay connected");
  const connectedAfter = Date.now();
  const device = await phone(t, f.remote, project.alias, undefined, true);
  const ready = device.active;
  const connectedGrant = await until(async () => {
    await f.remote.refresh();
    const grant = f.remote.state().deviceGrants.find((grant) => grant.devicePeerId === device.peer);
    return grant?.online === true ? grant : null;
  }, "the original review phone is online");
  assert.equal(typeof connectedGrant.lastSeenAt, "number");
  assert.ok(connectedGrant.lastSeenAt >= connectedAfter);
  proof.presence = {
    connected: { online: connectedGrant.online, lastSeenAt: connectedGrant.lastSeenAt },
  };
  assert.ok(ready.capabilities.includes("review"));
  assert.ok(
    ready.capabilities.includes("pauseTask"),
    "Operator receives its implemented pauseTask capability",
  );
  assert.ok(ready.methods.includes("artifact.read"));
  assert.equal(ready.limits.artifactChunkBytes, 48 * 1024);
  const rpc = async (method, params = {}, projectId = project.alias) => {
    const response = await device.rpc(method, params, undefined, { projectId });
    proof.responses.push({ method, response });
    return response;
  };
  const history = await project.core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: project.workspace,
    agentProfile: { id: "fixture", revision: "v1" },
  });
  await project.core.call("areal/thread/configure", {
    threadId: history.thread.id,
    expectedRevision: 1,
    model: { providerId: "fixture-review", modelId: "fixture" },
  });
  const written = await project.core.call("areal/turn/start", {
    requestId: randomUUID(),
    threadId: history.thread.id,
    expectedConfigRevision: 2,
    input: [{ type: "text", text: "REVIEW_HISTORY_TOOL" }],
  });
  await until(async () => {
    const current = await project.core.call("thread/read", {
      threadId: history.thread.id,
      includeTurns: true,
    });
    return current.thread.turns.find((turn) => turn.id === written.turn.id)?.status === "completed";
  }, "native Runtime file creation completes");
  const original = await rpc("review.read", {
    threadId: history.thread.id,
    turnId: written.turn.id,
  });
  assert.ok(original.result, JSON.stringify(original));
  const originalDiff = JSON.parse(original.result.review.chunk).diff;
  assert.equal(originalDiff.state, "available");
  assert.equal(originalDiff.provenance, "verified-runtime-file-writes");
  assert.equal(originalDiff.files[0].path, "review-native.txt");
  assert.ok(
    originalDiff.files[0].hunks[0].lines.some(
      (line) => line.kind === "add" && line.text === "Original Runtime text",
    ),
  );
  await writeFile(join(project.workspace, "review-native.txt"), "Current workspace replacement\n");
  const afterWorkspaceEdit = await rpc("review.read", {
    threadId: history.thread.id,
    turnId: written.turn.id,
  });
  assert.deepEqual(JSON.parse(afterWorkspaceEdit.result.review.chunk).diff, originalDiff);
  proof.history = { threadId: history.thread.id, turnId: written.turn.id, diff: originalDiff };
  const created = await project.core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: project.workspace,
  });
  const threadId = created.thread.id;
  await project.core.call("areal/thread/configure", {
    threadId,
    expectedRevision: 1,
    model: { providerId: "fixture-review", modelId: "fixture" },
  });
  const started = await project.core.call("areal/turn/start", {
    requestId: randomUUID(),
    threadId,
    expectedConfigRevision: 2,
    input: [{ type: "text", text: "REVIEW_FAILED_TURN" }],
  });
  const turnId = started.turn.id;
  await until(async () => {
    const current = await project.core.call("thread/read", { threadId, includeTurns: true });
    return current.thread.turns.find((turn) => turn.id === turnId)?.status === "failed";
  }, "native partial model Turn fails");
  const task = await project.core.call("areal/goal/create", {
    requestId: randomUUID(),
    threadId,
    expectedRevision: 0,
    objective: "REVIEW_RUNNING_TASK",
    maxTurns: 3,
  });
  await until(() => held, "a later native Task model request remains running");
  const observed = await rpc("session.open", { threadId });
  assert.equal(observed.result.snapshot.ownership.runId, task.runId);
  const currentRun = await rpc("task.read", { taskId: task.taskId, runId: task.runId });
  assert.equal(currentRun.result.runStatus, "running");
  const beforeThreads = await project.core.call("thread/list", { limit: 100 });
  const beforeJournal = await f.client.journal(project.projectId).read();
  let cursor;
  let body = "";
  const artifacts = [];
  let pages = 0;
  do {
    const reviewed = await rpc("review.read", { threadId, turnId, ...(cursor ? { cursor } : {}) });
    assert.ok(!reviewed.error, JSON.stringify(reviewed));
    assert.equal(reviewed.result.review.offset, Buffer.byteLength(body));
    assert.ok(Buffer.byteLength(reviewed.result.review.chunk) <= 16384);
    assert.ok(Buffer.byteLength(JSON.stringify(reviewed)) < 256 * 1024);
    assert.equal(JSON.stringify(reviewed).includes(digest), false);
    artifacts.push(...reviewed.result.artifacts);
    body += reviewed.result.review.chunk;
    cursor = reviewed.result.nextCursor;
    pages++;
  } while (cursor);
  const content = JSON.parse(body);
  assert.equal(content.turnStatus, "failed");
  assert.equal(content.partial, true);
  assert.ok(content.error);
  assert.ok(content.result.some((item) => item.text === text));
  assert.equal(
    content.taskRunStatus,
    null,
    "historical Turn A must not inherit current Task Run B status",
  );
  assert.ok(pages > 1, "original UTF-8 content crosses review page boundaries");
  assert.equal(artifacts.length, 1);
  const artifactRef = artifacts[0].artifactRef;
  const image = await rpc("artifact.read", { artifactRef, offset: 0, length: 48 * 1024 });
  assert.ok(!image.error, JSON.stringify(image));
  assert.deepEqual(Buffer.from(image.result.base64, "base64"), png);
  assert.deepEqual(image.result.raster, { mime: "image/png", width: 1, height: 1 });
  for (const [method, params] of [
    ["review.read", { threadId, turnId, path: "/secret" }],
    ["artifact.read", { artifactRef, offset: 0, length: 1, uri: `areal://blob/${digest}` }],
    ["artifact.read", { artifactRef, offset: 0, length: 48 * 1024 + 1 }],
  ])
    assert.equal((await rpc(method, params)).error.code, "INVALID_PARAMS");
  assert.equal(
    (await rpc("artifact.read", { artifactRef: "fake", offset: 0, length: 1 })).error.code,
    "RESOURCE_UNAVAILABLE",
  );
  assert.equal(
    (await rpc("review.read", { threadId, turnId }, "other-project")).error.code,
    "FORBIDDEN",
  );
  const afterThreads = await project.core.call("thread/list", { limit: 100 });
  const stableThreads = [beforeThreads, afterThreads].map((snapshot) => structuredClone(snapshot));
  const elapsed = stableThreads.map((snapshot) => {
    const usage = snapshot.data.find((thread) => thread.id === threadId).goals.goal.usage;
    const seconds = usage.timeUsedSeconds;
    delete usage.timeUsedSeconds;
    return seconds;
  });
  assert.equal(typeof elapsed[0], "number");
  assert.equal(typeof elapsed[1], "number");
  assert.ok(
    elapsed[1] >= elapsed[0],
    "the running Task clock advances independently of review reads",
  );
  assert.deepEqual(stableThreads[1], stableThreads[0]);
  proof.readWindowTime = { before: elapsed[0], after: elapsed[1] };
  assert.deepEqual(await f.client.journal(project.projectId).read(), beforeJournal);
  proof.original = {
    threadId,
    turnId,
    taskId: task.taskId,
    runId: task.runId,
    pages,
    content,
    artifact: artifacts[0],
  };
  device.close();
  const disconnectedGrant = await until(async () => {
    await f.remote.refresh();
    const grant = f.remote.state().deviceGrants.find((grant) => grant.devicePeerId === device.peer);
    return grant?.online === false ? grant : null;
  }, "the original review phone is offline");
  assert.equal(typeof disconnectedGrant.lastSeenAt, "number");
  assert.ok(disconnectedGrant.lastSeenAt >= connectedGrant.lastSeenAt);
  proof.presence.disconnected = {
    online: disconnectedGrant.online,
    lastSeenAt: disconnectedGrant.lastSeenAt,
  };
}
