import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, phone, until } from "./remote-native-push-fixture.mjs";

export async function nativeReviewNegatives(t) {
  const relay = await pushRelay(t);
  const f = await nativeHostFixture(t);
  const project = await nativeCoreProject(t, f);
  const proof = { owner: "Rust Host", sources: [], responses: [] };
  t.after(() =>
    writeFile(
      join(f.evidence.root, "native-review-negatives.json"),
      JSON.stringify(proof, null, 2),
    ),
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const largeDimensions = Buffer.from(png);
  largeDimensions.writeUInt32BE(100000, 16);
  const images = new Map([
    ["VALID_PNG", png],
    ["FAKE_PNG", Buffer.from("<html>untrusted body</html>")],
    ["FAKE_SVG", Buffer.from("<svg width='1'></svg>")],
    ["DIMENSION_BUDGET", largeDimensions],
  ]);
  const held = Promise.withResolvers();
  const model = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.stringify(JSON.parse(raw).input);
    const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    const complete = () => {
      emit({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
      });
      response.end();
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (input.includes("REVIEW_CURSOR_SOURCE")) {
      emit({ type: "response.output_text.delta", delta: "界".repeat(20000) });
      held.resolve(() => {
        emit({ type: "response.output_text.delta", delta: " continued original output" });
        complete();
      });
      return;
    }
    const marker = [...images.keys()].find((marker) => input.includes(marker));
    assert.ok(marker, "the actual Core request identifies its isolated image source");
    emit({
      type: "response.output_item.done",
      item: { type: "image_generation_call", result: images.get(marker).toString("base64") },
    });
    complete();
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  });
  await project.core.call("areal/provider/upsert", {
    provider: {
      id: "fixture-review-negative",
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
  await until(
    async () => (await f.remote.refresh()).connected,
    "negative review Host connects to Relay",
  );
  const first = await phone(t, f.remote, project.alias, undefined, true);
  const second = await phone(t, f.remote, project.alias, first.identity);
  const healthy = await phone(t, f.remote, project.alias, undefined, true);
  assert.notEqual(first.active.connectionId, second.active.connectionId);
  assert.equal(first.peer, second.peer);
  const rpc = async (device, method, params, projectId = project.alias) => {
    const journal = await f.client.journal(project.projectId).read();
    const threadIds = (await project.core.call("thread/list", { limit: 100 })).data
      .map((thread) => thread.id)
      .sort();
    const response = await device.rpc(method, params, undefined, { projectId });
    assert.deepEqual(await f.client.journal(project.projectId).read(), journal);
    assert.deepEqual(
      (await project.core.call("thread/list", { limit: 100 })).data
        .map((thread) => thread.id)
        .sort(),
      threadIds,
    );
    proof.responses.push({
      connectionId: device.active.connectionId,
      method,
      params,
      response,
      readWindow: { threadIds, journalUnchanged: true },
    });
    return response;
  };
  const denied = (response, code) => {
    assert.equal(response.error?.code, code, JSON.stringify(response));
    assert.equal(response.result, undefined);
  };
  const start = async (marker) => {
    const source = { marker, createRequestId: randomUUID(), turnRequestId: randomUUID() };
    proof.sources.push(source);
    const created = await project.core.call("areal/thread/start", {
      requestId: source.createRequestId,
      cwd: project.workspace,
    });
    source.threadId = created.thread.id;
    await project.core.call("areal/thread/configure", {
      threadId: source.threadId,
      expectedRevision: 1,
      model: { providerId: "fixture-review-negative", modelId: "fixture" },
    });
    const started = await project.core.call("areal/turn/start", {
      requestId: source.turnRequestId,
      threadId: source.threadId,
      expectedConfigRevision: 2,
      input: [{ type: "text", text: marker }],
    });
    source.turnId = started.turn.id;
    return source;
  };
  const readNative = async (source) =>
    (
      await project.core.call("thread/read", { threadId: source.threadId, includeTurns: true })
    ).thread.turns.find((turn) => turn.id === source.turnId);
  const completed = (source) =>
    until(
      async () => (await readNative(source)).status === "completed",
      "the original native review source completes",
    );
  const target = (source) => ({ threadId: source.threadId, turnId: source.turnId });

  const cursorSource = await start("REVIEW_CURSOR_SOURCE");
  const finish = await held.promise;
  await until(
    async () =>
      (await readNative(cursorSource)).items.some(
        (item) => item.type === "agentMessage" && Buffer.byteLength(item.text ?? "") > 16384,
      ),
    "the original model stream exposes a paged partial result",
  );
  const partial = await rpc(first, "review.read", target(cursorSource));
  assert.ok(partial.result?.nextCursor, JSON.stringify(partial));
  finish();
  await completed(cursorSource);
  denied(
    await rpc(first, "review.read", { ...target(cursorSource), cursor: partial.result.nextCursor }),
    "TARGET_CHANGED",
  );
  denied(
    await rpc(first, "review.read", { threadId: cursorSource.threadId, turnId: randomUUID() }),
    "RESOURCE_UNAVAILABLE",
  );
  denied(
    await rpc(first, "review.read", { ...target(cursorSource), itemId: randomUUID() }),
    "RESOURCE_UNAVAILABLE",
  );
  denied(
    await rpc(first, "review.read", { ...target(cursorSource), url: "http://untrusted" }),
    "INVALID_PARAMS",
  );

  const valid = await start("VALID_PNG");
  await completed(valid);
  const page = await rpc(first, "review.read", target(valid));
  assert.equal(page.result?.artifacts.length, 1, JSON.stringify(page));
  const artifactRef = page.result.artifacts[0].artifactRef;
  const params = { artifactRef, offset: 0, length: 48 * 1024 };
  const original = await rpc(first, "artifact.read", params);
  assert.deepEqual(Buffer.from(original.result.base64, "base64"), png);
  denied(await rpc(second, "artifact.read", params), "RESOURCE_UNAVAILABLE");
  const freshPage = await rpc(second, "review.read", target(valid));
  const fresh = await rpc(second, "artifact.read", {
    ...params,
    artifactRef: freshPage.result.artifacts[0].artifactRef,
  });
  assert.deepEqual(Buffer.from(fresh.result.base64, "base64"), png);
  denied(
    await rpc(first, "artifact.read", {
      ...params,
      artifactRef: `areal://blob/${createHash("sha256").update(png).digest("hex")}`,
    }),
    "RESOURCE_UNAVAILABLE",
  );

  denied(await rpc(first, "artifact.read", params, "other-project"), "FORBIDDEN");
  const originalTurn = await readNative(valid);
  const editRequestId = randomUUID();
  proof.edit = { requestId: editRequestId, threadId: valid.threadId, originalTurnId: valid.turnId };
  const edited = await project.core.call("areal/turn/submit", {
    requestId: editRequestId,
    threadId: valid.threadId,
    expectedConfigRevision: 2,
    intent: {
      type: "edit",
      expectedTurnId: valid.turnId,
      itemId: originalTurn.items.find((item) => item.type === "userMessage").id,
      input: [{ type: "text", text: "VALID_PNG" }],
    },
  });
  const replacement = { ...valid, turnId: edited.turn.id };
  proof.edit.replacementTurnId = replacement.turnId;
  assert.notEqual(replacement.turnId, valid.turnId);
  await completed(replacement);
  assert.equal(await readNative(valid), undefined);
  denied(await rpc(first, "artifact.read", params), "RESOURCE_UNAVAILABLE");
  const replacementPage = await rpc(first, "review.read", target(replacement));
  assert.equal(replacementPage.result?.artifacts.length, 1, JSON.stringify(replacementPage));
  const replacementArtifact = await rpc(first, "artifact.read", {
    ...params,
    artifactRef: replacementPage.result.artifacts[0].artifactRef,
  });
  assert.equal(replacementArtifact.result.turnId, replacement.turnId);
  assert.equal(replacementArtifact.result.itemId, replacementPage.result.artifacts[0].itemId);
  assert.deepEqual(Buffer.from(replacementArtifact.result.base64, "base64"), png);

  for (const marker of ["FAKE_PNG", "FAKE_SVG", "DIMENSION_BUDGET"]) {
    const source = await start(marker);
    await completed(source);
    const native = await readNative(source);
    const item = native.items.find((item) => item.type === "agentMedia");
    assert.ok(item, `${marker} has a real native media Item`);
    assert.equal(
      item.media.uri,
      `areal://blob/${createHash("sha256").update(images.get(marker)).digest("hex")}`,
    );
    const review = await rpc(first, "review.read", { ...target(source), itemId: item.id });
    assert.equal(review.result?.artifacts.length, 1, JSON.stringify(review));
    denied(
      await rpc(first, "artifact.read", {
        artifactRef: review.result.artifacts[0].artifactRef,
        offset: 0,
        length: 48 * 1024,
      }),
      "RESOURCE_UNAVAILABLE",
    );
  }
  await f.remote.control({ operation: "revoke", id: first.peer });
  await until(
    () => first.socket.readyState === 3 && second.socket.readyState === 3,
    "revocation closes both actual connections for the original peer",
  );
  const revoked = await phone(t, f.remote, project.alias, first.identity);
  assert.equal(revoked.active.error?.code, "FORBIDDEN");
  const stillReadable = await healthy.rpc("project.list");
  assert.ok(stillReadable.result.projects.some((entry) => entry.projectId === project.alias));
  proof.revocation = {
    originalPeer: first.peer,
    originalConnectionsClosed: true,
    reconnect: revoked.active.error.code,
    healthyProjectId: project.alias,
  };

  const state = await f.client.request("remote.read", {});
  const config = structuredClone(state.config);
  const grant = config.deviceGrants.find((grant) => grant.devicePeerId === healthy.peer);
  const previousGrantRevision = grant.revision;
  grant.capabilities = ["observe"];
  grant.revision++;
  const requestId = randomUUID();
  proof.observeOnly = {
    requestId,
    peer: healthy.peer,
    previousGrantRevision,
    grantRevision: grant.revision,
  };
  const receipt = await f.client.request("remote.gateway.replace", {
    requestId,
    sourceId: state.sourceId,
    expectedRevision: state.revision,
    expectedGeneration: f.evidence.host.generation,
    config,
  });
  proof.observeOnly.receipt = receipt;
  assert.equal(receipt.requestId, requestId);
  assert.equal(receipt.state, "completed");
  await until(
    () => healthy.socket.readyState === 3,
    "the saved legacy grant revision closes its original connection",
  );
  const observeOnly = await phone(t, f.remote, project.alias, healthy.identity);
  assert.equal(observeOnly.active.grantRevision, grant.revision);
  assert.ok(observeOnly.active.capabilities.includes("observe"));
  assert.ok(!observeOnly.active.capabilities.includes("review"));
  denied(await rpc(observeOnly, "review.read", target(replacement)), "FORBIDDEN");
  denied(await rpc(observeOnly, "artifact.read", params), "FORBIDDEN");
  const observable = await observeOnly.rpc("project.list");
  assert.ok(observable.result.projects.some((entry) => entry.projectId === project.alias));
}
