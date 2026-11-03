import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MobileClient } from "../renderer/src/mobile/mobile-client.mjs";
import { MobileWorkspace } from "../renderer/src/mobile/mobile-workspace.mjs";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, until } from "./remote-native-push-fixture.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
const keys = (value) =>
  Object.fromEntries(
    ["connectionId", "gatewayGeneration", "serviceGeneration", "subscriptionId", "projectId"].map(
      (key) => [key, value[key]],
    ),
  );
const visibleIds = (workspace) =>
  workspace.state.turns.flatMap((turn) => turn.items.map((item) => item.id));
const nativeIds = (thread) =>
  thread.turns.flatMap((turn) =>
    turn.items.filter((item) => item.type !== "modelContext").map((item) => item.id),
  );

export async function nativeMobileWorkspace(t) {
  const relay = await pushRelay(t);
  const f = await nativeHostFixture(t);
  const project = await nativeCoreProject(t, f);
  const proof = {
    owner: "Rust Host",
    client: "production MobileClient + RemoteConnection",
    phases: [],
    events: [],
  };
  t.after(() =>
    writeFile(
      join(f.evidence.root, "native-mobile-workspace.json"),
      JSON.stringify(proof, null, 2),
    ),
  );
  let stored = null;
  const client = new MobileClient({
    clientKind: "ios",
    socket: (url) => new WebSocket(url, { origin: relay.origin }),
    keychain: {
      load: async () => ({ value: stored }),
      save: async ({ value }) => {
        stored = value;
      },
      clear: async () => {
        stored = null;
      },
      deviceName: async () => ({ name: "Native mobile workspace fixture" }),
    },
  });
  t.after(() => client.setActive(false));
  await f.remote.control({
    operation: "enable",
    relay: relay.origin,
    code: relay.enrollment(),
    confirmed: true,
  });
  await until(
    async () => (await f.remote.refresh()).connected,
    "mobile workspace Host Relay connected",
  );
  await client.setActive(true);
  assert.equal(client.snapshot().kind, "unpaired");
  const invitation = await f.remote.control({ operation: "pair", transport: "relay" });
  const pairing = client.pair(invitation.payload, "Native mobile workspace fixture");
  await until(
    () => client.snapshot().kind === "pairing",
    "production MobileClient reaches real Host pairing",
  );
  await f.remote.control({
    operation: "approve",
    id: client.snapshot().fingerprint,
    projects: [project.alias],
    preset: "Observer",
  });
  await pairing;
  assert.equal(client.snapshot().kind, "connected");
  proof.connection = {
    ...keys(client.snapshot().ready),
    hostId: client.snapshot().ready.hostId,
    grantRevision: client.snapshot().ready.grantRevision,
  };

  const created = await project.core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: project.workspace,
  });
  const threadId = created.thread.id;
  const read = async () =>
    (await project.core.call("thread/read", { threadId, includeTurns: true })).thread;
  let sent = 0;
  const send = async () => {
    const requestId = randomUUID();
    const submission = { requestId, index: sent + 1 };
    proof.submissions ??= [];
    proof.submissions.push(submission);
    const started = await project.core.call("areal/turn/start", {
      requestId,
      threadId,
      expectedConfigRevision: 1,
      input: [{ type: "text", text: `MOBILE_HOST_HISTORY_${++sent}` }],
    });
    submission.turnId = started.turn.id;
    return until(async () => {
      const thread = await read();
      return thread.turns.find((turn) => turn.id === started.turn.id)?.status === "completed"
        ? thread
        : null;
    }, "the original public Core Turn completes");
  };
  let native = await read();
  while (nativeIds(native).length <= 100 && sent < 52) native = await send();
  assert.ok(nativeIds(native).length > 100 && nativeIds(native).length <= 110);
  assert.ok(
    native.turns.every((turn) =>
      turn.items.every((item) =>
        ["userMessage", "agentMessage", "modelContext"].includes(item.type),
      ),
    ),
  );
  proof.seed = { threadId, turns: sent, itemIds: nativeIds(native) };
  const beforeJournal = await f.client.journal(project.projectId).read();
  const beforeThreads = (await project.core.call("thread/list", { limit: 100 })).data
    .map((thread) => thread.id)
    .sort();
  const open = async () => {
    const workspace = new MobileWorkspace(client);
    t.after(() => workspace.dispose());
    workspace.publish({ page: { kind: "session", projectId: project.alias, threadId } });
    const accept = client.onSession;
    client.onSession = (event) => {
      proof.events.push({ ...keys(event), event: event.event, sequence: event.sequence });
      accept(event);
    };
    await workspace.refresh();
    assert.equal(workspace.state.error, false);
    assert.equal(workspace.state.detail.sequence, 0);
    assert.equal(workspace.state.detail.connectionId, client.snapshot().ready.connectionId);
    assert.equal(
      workspace.state.detail.gatewayGeneration,
      client.snapshot().ready.gatewayGeneration,
    );
    assert.equal(workspace.state.detail.serviceGeneration, project.service.generation);
    assert.equal(workspace.state.detail.projectId, project.alias);
    assert.equal(workspace.state.detail.snapshot.threadId, threadId);
    assert.ok(workspace.state.detail.snapshot.history.nextCursor);
    return workspace;
  };
  for (const historyFirst of [false, true]) {
    const workspace = await open();
    const identity = keys(workspace.state.detail);
    if (historyFirst) await workspace.older();
    native = await send();
    const expected = nativeIds(native);
    await until(() => {
      const live =
        workspace.state.detail?.snapshot.turns.flatMap((turn) =>
          turn.items.map((item) => item.id),
        ) ?? [];
      return live.includes(expected.at(-1));
    }, "the real Rust event advances the mobile live tail");
    if (!historyFirst) await workspace.older();
    assert.deepEqual(visibleIds(workspace), expected);
    assert.equal(new Set(visibleIds(workspace)).size, expected.length);
    assert.equal(workspace.historyView().complete, true);
    assert.deepEqual(keys(workspace.state.detail), identity);
    proof.phases.push({
      historyFirst,
      identity,
      itemIds: expected,
      historyComplete: workspace.historyView().complete,
    });
    workspace.dispose();
  }

  const workspace = await open();
  const originalIdentity = keys(workspace.state.detail);
  const request = client.request.bind(client);
  const historyReceived = Promise.withResolvers();
  const releaseHistory = Promise.withResolvers();
  const reopened = Promise.withResolvers();
  t.after(() => releaseHistory.resolve());
  let holdHistory = true;
  client.request = async (envelope, onResult) => {
    const response = await request(envelope, onResult);
    if (envelope.method === "session.open") reopened.resolve(response);
    if (holdHistory && envelope.method === "session.history") {
      holdHistory = false;
      historyReceived.resolve(response);
      await releaseHistory.promise;
    }
    return response;
  };
  const loading = workspace.older();
  void loading.catch(() => {});
  const oldHistory = await historyReceived.promise;
  assert.deepEqual(keys(oldHistory), originalIdentity);
  assert.equal(workspace.state.loadingOlder, true);
  const accept = client.onSession;
  let missing;
  let gapDelivered = false;
  client.onSession = (event) => {
    if (
      !gapDelivered &&
      event.event === "session.updated" &&
      event.subscriptionId === originalIdentity.subscriptionId
    ) {
      if (!missing) {
        missing = event;
        return;
      }
      gapDelivered = true;
      proof.gap = {
        held: { ...keys(missing), sequence: missing.sequence },
        delivered: { ...keys(event), sequence: event.sequence },
      };
    }
    accept(event);
  };
  native = await send();
  await until(
    () =>
      workspace.state.detail?.subscriptionId !== originalIdentity.subscriptionId &&
      workspace.state.detail &&
      !workspace.state.loading &&
      visibleIds(workspace).includes(nativeIds(native).at(-1)),
    "a real sequence gap opens a new atomic Host observation",
  );
  assert.ok(gapDelivered);
  const replacement = workspace.state.detail;
  const replacementIds = visibleIds(workspace);
  const baseline = await reopened.promise;
  assert.equal(baseline.sequence, 0);
  assert.deepEqual(keys(baseline), keys(replacement));
  assert.equal(replacement.connectionId, originalIdentity.connectionId);
  assert.equal(replacement.serviceGeneration, originalIdentity.serviceGeneration);
  assert.equal(replacement.gatewayGeneration, originalIdentity.gatewayGeneration);
  assert.equal(replacement.projectId, originalIdentity.projectId);
  assert.equal(workspace.state.loadingOlder, false);
  releaseHistory.resolve();
  await loading;
  assert.equal(workspace.state.loadingOlder, false);
  assert.deepEqual(visibleIds(workspace), replacementIds);
  assert.deepEqual(keys(workspace.state.detail), keys(replacement));
  client.request = request;
  await workspace.older();
  assert.deepEqual(visibleIds(workspace), nativeIds(native));
  assert.equal(new Set(visibleIds(workspace)).size, nativeIds(native).length);
  assert.equal(workspace.historyView().complete, true);
  assert.deepEqual(await f.client.journal(project.projectId).read(), beforeJournal);
  assert.deepEqual(
    (await project.core.call("thread/list", { limit: 100 })).data.map((thread) => thread.id).sort(),
    beforeThreads,
  );
  proof.phases.push({
    kind: "late history after resync",
    originalIdentity,
    replacementIdentity: keys(replacement),
    baselineSequence: baseline.sequence,
    lateHistoryIdentity: keys(oldHistory),
    itemIds: nativeIds(native),
    loadingOlder: workspace.state.loadingOlder,
  });
  workspace.dispose();
}
