import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import {
  hash,
  NEGATIVE_MS,
  until,
  observeNone,
  pushRelay,
  phone,
  grant,
  privateFree,
  runWithIsolatedCA,
} from "./remote-native-push-fixture.mjs";

const { sessionCommand } = createRequire(import.meta.url)(
  "../../../services/workbench/src/desktop/core/remote-session-commands.cjs",
);

function accepted(response, commandId, threadId) {
  assert.equal(response.error === undefined, true, "the original command has a result");
  const result = response.result;
  assert.equal(result.admissionState, "accepted");
  assert.equal(result.submissionUnknown, false);
  assert.equal(result.commandId, commandId);
  assert.equal(result.method, "session.send");
  assert.equal(result.threadId, threadId);
  assert.equal(typeof result.operationId, "string");
  assert.equal(result.nativeRequestId, result.operationId);
  return result;
}

async function nativeReceipt(native, command, method) {
  const result = await native.core.call("areal/request/read", {
    threadId: command.threadId,
    requestId: command.nativeRequestId,
  });
  const receipts = result.data.filter(
    (entry) => entry.requestId === command.nativeRequestId && entry.method === method,
  );
  assert.equal(receipts.length, 1, "one original Core admission receipt exists");
  const receipt = receipts[0];
  if (method === "areal/turn/start") assert.equal(receipt.result.turn.id, command.turnId);
  else assert.equal(receipt.result.queueItemId, command.receipt.queueItemId);
  return {
    requestId: receipt.requestId,
    method: receipt.method,
    turnId: receipt.result.turn?.id ?? null,
    queueItemId: receipt.result.queueItemId ?? null,
  };
}

async function journalCommand(f, native, peer, commandId) {
  const { snapshot } = await f.client.journal(native.projectId).read();
  const entries = [...snapshot.pending, ...Object.values(snapshot.outcomes)].filter(
    (record) => record.remote?.devicePeerId === peer && record.remote?.commandId === commandId,
  );
  assert.equal(entries.length, 1, "the original peer and command have one Host journal entry");
  const entry = entries[0];
  assert.equal(entry.remote.method, "session.send");
  assert.equal(entry.remote.projectId, native.alias);
  return {
    commandId,
    operationId: entry.operationId,
    method: entry.method,
    admissionState: entry.admissionState ?? "unknown",
    threadId: entry.threadId ?? entry.params?.threadId,
    turnId: entry.turnId ?? null,
    queueItemId: entry.receipt?.queueItemId ?? null,
  };
}

function completion(relay, projectId, peer, commandId) {
  const collapseId = hash(JSON.stringify([projectId, peer, commandId]));
  return relay.frames.filter(({ message }) => message.collapseId === collapseId);
}

function verifyCompletion(relay, native, peer, command, token, privateTexts) {
  const frames = completion(relay, native.alias, peer, command.commandId);
  assert.equal(frames.length, 1, "the exact original command produces one completion frame");
  const message = frames[0].message;
  assert.equal(message.type, "push");
  assert.equal(message.kind, "turnCompleted");
  assert.equal(message.count, 1);
  assert.equal(message.environment, "development");
  assert.equal(message.token === token, true, "the original registered token owns completion");
  assert.equal(message.target.projectId, native.alias);
  assert.equal(message.target.threadId, command.threadId);
  assert.equal(
    privateTexts.some((text) => JSON.stringify(message).includes(text)),
    false,
    "completion contains opaque references without prompt or model content",
  );
  return message;
}

if (!process.env.RC12_TLS_HOME) {
  test("native session send uses the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "native send journals one Core admission and queued completion survives unread reply and phone close",
    { timeout: 240000 },
    async (t) => {
      const token = "d".repeat(64);
      const relay = await pushRelay(t);
      const f = await nativeHostFixture(t);
      const native = await nativeCoreProject(t, f, { holdModel: true });
      const proof = { negativeObservationMs: NEGATIVE_MS, checks: [] };
      f.evidence.nativeSessionSend = proof;
      t.after(() => {
        proof.relay = relay.evidence();
        proof.modelResponses = native.modelResponseEvidence();
        privateFree(proof, [token]);
        return writeFile(
          join(f.evidence.root, "native-session-send-evidence.json"),
          JSON.stringify(proof, null, 2),
          { mode: 0o600 },
        );
      });
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await f.remote.refresh()).connected, "native Relay connected");
      const first = await phone(t, f.remote, native.alias, undefined, true);
      const second = await phone(t, f.remote, native.alias, first.identity);
      assert.equal(first.active.methods.includes("session.send"), true);
      assert.equal(first.active.capabilities.includes("push"), true);
      await until(() => relay.ready.includes(true), "actual Relay ready push capability");
      const registered = await first.rpc(
        "device.push.register",
        { platform: "apns", token, environment: "development" },
        randomUUID(),
      );
      assert.equal(registered.result?.registered === true, true);
      const projects = await first.rpc("project.list");
      const project = projects.result.projects.find((entry) => entry.projectId === native.alias);
      assert.equal(typeof project.serviceGeneration, "string");
      const context = (client) => ({
        projectId: native.alias,
        gatewayGeneration: client.active.gatewayGeneration,
        grantRevision: client.active.grantRevision,
        serviceGeneration: project.serviceGeneration,
      });
      const created = await native.core.call("areal/thread/start", {
        requestId: randomUUID(),
        cwd: native.workspace,
        agentProfile: { id: "fixture", revision: "v1" },
      });
      const threadId = created.thread.id;
      const readThread = async () =>
        (await native.core.call("thread/read", { threadId, includeTurns: true })).thread;
      const opened = await first.rpc("session.open", { threadId }, undefined, {
        projectId: native.alias,
      });
      assert.equal(opened.result.snapshot.threadId, threadId);
      const expectedConfigRevision = (await readThread()).desktop.configuration.revision;
      const text = `PRIVATE_NATIVE_SEND_${randomUUID()}`;
      const params = { threadId, expectedConfigRevision, text };
      for (const optional of [{ enqueue: null }, { expectedTurnId: null }]) {
        const commandId = randomUUID();
        const invalid = { ...params, ...optional };
        await assert.rejects(
          sessionCommand(
            {},
            {},
            {
              id: randomUUID(),
              method: "session.send",
              commandId,
              context: context(first),
              params: invalid,
            },
            () => assert.fail("invalid legacy input must not publish"),
          ),
          { code: "INVALID_PARAMS" },
        );
        const response = await first.rpc("session.send", invalid, commandId, context(first));
        assert.equal(response.error?.code, "INVALID_PARAMS");
        assert.equal((await readThread()).turns.length, 0);
        assert.equal((await readThread()).desktop.queue.items.length, 0);
      }
      const stale = await first.rpc(
        "session.send",
        { ...params, expectedConfigRevision: expectedConfigRevision - 1 },
        randomUUID(),
        context(first),
      );
      assert.equal(stale.error?.code, "TARGET_CHANGED");
      assert.equal((await readThread()).turns.length, 0);
      const commandId = randomUUID();
      const replies = await Promise.all([
        first.rpc("session.send", params, commandId, context(first)),
        second.rpc("session.send", params, commandId, context(second)),
      ]);
      const original = accepted(replies[0], commandId, threadId);
      const overlap = accepted(replies[1], commandId, threadId);
      assert.equal(overlap.operationId, original.operationId);
      assert.equal(overlap.turnId, original.turnId);
      const held = await native.waitForModel(text);
      assert.equal((await readThread()).turns.length, 1);
      proof.overlap = {
        commandId,
        operationId: original.operationId,
        nativeRequestId: original.nativeRequestId,
        turnId: original.turnId,
        journal: await journalCommand(f, native, first.peer, commandId),
        core: await nativeReceipt(native, original, "areal/turn/start"),
      };
      assert.equal(proof.overlap.journal.operationId, original.operationId);
      const nativeParams = {
        admissionGuard: { configRevision: expectedConfigRevision, ordinarySession: true },
        interactionMode: null,
        requestId: original.operationId,
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        expectedConfigRevision,
      };
      const journal = f.client.journal(native.projectId);
      const stage = await journal.change((snapshot) => {
        const record = snapshot.outcomes[original.operationId];
        assert.equal(record?.admissionState, "accepted");
        assert.equal(record.remote.commandId, commandId);
        assert.equal(record.remote.devicePeerId, first.peer);
        assert.equal(record.turnId, original.turnId);
        assert.equal(record.method, "areal/turn/start");
        assert.equal(typeof record.coreScope?.storeBinding?.identity, "string");
        assert.equal(typeof record.coreScope?.storeBinding?.journalEpoch, "string");
        assert.equal(
          hash(JSON.stringify(nativeParams)) === record.nativeDigest,
          true,
          "independent typed TurnStart field order matches the original native digest",
        );
        assert.equal(
          snapshot.pending.some((entry) => entry.operationId === original.operationId),
          false,
        );
        const pending = { ...record, params: nativeParams };
        for (const key of ["admissionState", "accepted", "turnId", "receipt", "error"])
          delete pending[key];
        delete snapshot.outcomes[original.operationId];
        snapshot.pending.push(pending);
        return snapshot;
      });
      assert.equal(stage.state, "completed");
      const staged = await journal.read();
      assert.equal(staged.snapshot.outcomes[original.operationId], undefined);
      assert.equal(
        staged.snapshot.pending.filter(
          (entry) =>
            entry.operationId === original.operationId && entry.admissionState === undefined,
        ).length,
        1,
      );
      const reconciled = accepted(
        await first.rpc("command.read", { commandId }, undefined, { projectId: native.alias }),
        commandId,
        threadId,
      );
      assert.equal(reconciled.operationId, original.operationId);
      assert.equal(reconciled.turnId, original.turnId);
      assert.equal((await readThread()).turns.length, 1);
      proof.reconcileSend = {
        boundary:
          "Host terminal journal loss injected through original journal CAS; no crash or generation change",
        stageRequestId: stage.requestId,
        commandId,
        operationId: reconciled.operationId,
        turnId: reconciled.turnId,
        nativeDigestMatched: true,
        journal: await journalCommand(f, native, first.peer, commandId),
        core: await nativeReceipt(native, reconciled, "areal/turn/start"),
      };
      assert.deepEqual(proof.reconcileSend.core, proof.overlap.core);
      const conflict = await first.rpc(
        "session.send",
        { ...params, text: "PRIVATE_NATIVE_CHANGED" },
        commandId,
        context(first),
      );
      assert.equal(conflict.error?.code, "COMMAND_CONFLICT");
      const busy = await second.rpc("session.send", params, randomUUID(), context(second));
      assert.equal(busy.error?.code, "TURN_BUSY");
      const queuedText = `PRIVATE_NATIVE_QUEUE_${randomUUID()}`;
      const queueParams = {
        threadId,
        expectedConfigRevision,
        text: queuedText,
        enqueue: true,
        expectedTurnId: original.turnId,
      };
      const staleQueue = await first.rpc(
        "session.send",
        { ...queueParams, expectedTurnId: randomUUID() },
        randomUUID(),
        context(first),
      );
      assert.equal(staleQueue.error?.code, "TARGET_CHANGED");
      assert.equal((await readThread()).desktop.queue.items.length, 0);
      const queuedCommandId = randomUUID();
      const unreadRpcId = first.send("session.send", queueParams, queuedCommandId, context(first));
      const pending = await until(
        async () =>
          (await readThread()).desktop.queue.items.find((item) => item.status === "pending"),
        "the original unread queue command is admitted by Core",
      );
      first.close();
      second.close();
      await until(
        async () => (await grant(f.remote, first.peer)).online === false,
        "both original phone connections are closed",
      );
      const recovered = await phone(t, f.remote, native.alias, first.identity);
      const read = await until(async () => {
        const response = await recovered.rpc(
          "command.read",
          { commandId: queuedCommandId },
          undefined,
          { projectId: native.alias },
        );
        assert.equal(response.error === undefined, true, "original command.read remains available");
        return response.result?.admissionState === "accepted" ? response : null;
      }, "original unread queue command settlement without replay");
      const queued = accepted(read, queuedCommandId, threadId);
      assert.equal(queued.turnId, undefined);
      assert.equal(queued.receipt.queueItemId, pending.id);
      assert.notEqual(queued.operationId, original.operationId);
      proof.unreadReply = {
        boundary: "phone did not consume the queue RPC response; no Host crash injected",
        unreadRpcId,
        commandId: queuedCommandId,
        operationId: queued.operationId,
        queueItemId: pending.id,
        journal: await journalCommand(f, native, first.peer, queuedCommandId),
        core: await nativeReceipt(native, queued, "areal/turn/enqueue"),
      };
      assert.equal((await readThread()).turns.length, 1);
      assert.equal((await readThread()).desktop.queue.items.length, 1);
      recovered.close();
      await until(
        async () => (await grant(f.remote, first.peer)).online === false,
        "completion owner is offline after readonly recovery",
      );
      assert.equal(relay.frames.length, 0);
      held.release();
      const nextHeld = await native.waitForModel(queuedText);
      const running = await readThread();
      assert.equal(running.turns.find((turn) => turn.id === original.turnId).status, "completed");
      const queueItem = running.desktop.queue.items.find((item) => item.id === pending.id);
      assert.equal(typeof queueItem.turnId, "string");
      assert.notEqual(queueItem.turnId, original.turnId);
      await until(
        () => completion(relay, native.alias, first.peer, commandId).length === 1,
        "original send completion reaches the real Relay",
      );
      assert.equal(
        completion(relay, native.alias, first.peer, queuedCommandId).length,
        0,
        "the queue watcher does not complete on the preceding Turn",
      );
      nextHeld.release();
      await until(
        async () =>
          (await readThread()).turns.find((turn) => turn.id === queueItem.turnId)?.status ===
          "completed",
        "the exact queued Turn completes in Core",
      );
      await until(
        () => completion(relay, native.alias, first.peer, queuedCommandId).length === 1,
        "the exact queue command completion reaches the real Relay",
      );
      const privateTexts = [text, queuedText, "NATIVE_REMOTE_FIXTURE"];
      const frame = verifyCompletion(relay, native, first.peer, original, token, privateTexts);
      const queueFrame = verifyCompletion(relay, native, first.peer, queued, token, privateTexts);
      assert.notEqual(frame.collapseId, queueFrame.collapseId);
      await until(() => relay.records.length === 2, "both production Relay APNs requests");
      assert.equal(
        relay.records.every((record) => record.token === token),
        true,
      );
      assert.equal(
        relay.records.every((record) => record.replied),
        true,
      );
      for (const value of [frame, queueFrame]) {
        assert.equal(
          relay.records.filter((record) => record.collapseId === value.collapseId).length,
          1,
        );
      }
      const finalPhone = await phone(t, f.remote, native.alias, first.identity);
      for (const originalCommand of [original, queued]) {
        const result = await finalPhone.rpc(
          "command.read",
          {
            commandId: originalCommand.commandId,
          },
          undefined,
          { projectId: native.alias },
        );
        assert.equal(result.result.operationId, originalCommand.operationId);
      }
      finalPhone.close();
      await until(
        async () => (await grant(f.remote, first.peer)).online === false,
        "recovered phone closed before unrelated completion",
      );
      const unrelatedText = `PRIVATE_LOCAL_TURN_${randomUUID()}`;
      const unrelated = await native.core.call("areal/turn/start", {
        requestId: randomUUID(),
        threadId,
        input: [{ type: "text", text: unrelatedText }],
        expectedConfigRevision,
      });
      (await native.waitForModel(unrelatedText)).release();
      await until(
        async () =>
          (await readThread()).turns.find((turn) => turn.id === unrelated.turn.id)?.status ===
          "completed",
        "unrelated local Turn completes in the same real Core thread",
      );
      await observeNone(
        () => relay.frames.length - 2,
        "unrelated completion and readonly original-ID queries do not invent or replay pushes",
      );
      assert.equal((await readThread()).turns.length, 3);
      assert.equal((await readThread()).desktop.queue.items.length, 1);
      assert.equal(native.modelResponseEvidence().length, 3);
      const idle = await readThread();
      assert.equal(idle.status.type, "idle");
      assert.equal(
        idle.turns.every((turn) => turn.status === "completed"),
        true,
      );
      const beforePending = {
        turns: idle.turns.length,
        queueItems: idle.desktop.queue.items.length,
        receipts: idle.desktop.receipts.length,
      };
      const pendingOperationId = randomUUID(),
        pendingCommandId = randomUUID();
      const unsubmittedParams = { ...nativeParams, requestId: pendingOperationId };
      const pendingStage = await journal.change((snapshot) => {
        const source = snapshot.outcomes[original.operationId];
        assert.equal(source?.admissionState, "accepted");
        assert.equal(source.nativeDigest === hash(JSON.stringify(nativeParams)), true);
        assert.equal(snapshot.pending.length, 0);
        const entry = {
          ...source,
          operationId: pendingOperationId,
          params: unsubmittedParams,
          nativeDigest: hash(JSON.stringify(unsubmittedParams)),
          remote: { ...source.remote, commandId: pendingCommandId },
        };
        for (const key of ["admissionState", "accepted", "turnId", "receipt", "error"])
          delete entry[key];
        snapshot.pending.push(entry);
        return snapshot;
      });
      assert.equal(pendingStage.state, "completed");
      const guardedPhone = await phone(t, f.remote, native.alias, first.identity);
      const blockedId = randomUUID();
      const blocked = await guardedPhone.rpc(
        "session.send",
        params,
        blockedId,
        context(guardedPhone),
      );
      assert.equal(blocked.error?.code, "SUBMISSION_UNKNOWN");
      assert.equal(blocked.error.submissionUnknown, true);
      const unknown = await guardedPhone.rpc(
        "command.read",
        {
          commandId: pendingCommandId,
        },
        undefined,
        { projectId: native.alias },
      );
      assert.equal(unknown.result?.admissionState, "unknown");
      assert.equal(unknown.result.submissionUnknown, true);
      assert.equal(unknown.result.operationId, pendingOperationId);
      const absent = await native.core.call("areal/request/read", {
        threadId,
        requestId: pendingOperationId,
      });
      assert.equal(absent.data.length, 0, "the injected pending was never dispatched to Core");
      const pendingConflict = await guardedPhone.rpc(
        "session.send",
        { ...params, text: "PRIVATE_NATIVE_PENDING_CHANGED" },
        pendingCommandId,
        context(guardedPhone),
      );
      assert.equal(pendingConflict.error?.code, "COMMAND_CONFLICT");
      const afterIdle = await readThread();
      const afterPending = {
        turns: afterIdle.turns.length,
        queueItems: afterIdle.desktop.queue.items.length,
        receipts: afterIdle.desktop.receipts.length,
      };
      assert.deepEqual(afterPending, beforePending);
      assert.equal(native.modelResponseEvidence().length, 3);
      const retained = await journal.read();
      assert.equal(retained.snapshot.pending.length, 1);
      assert.equal(retained.snapshot.pending[0].operationId, pendingOperationId);
      assert.equal(retained.snapshot.pending[0].remote.commandId, pendingCommandId);
      assert.equal(retained.snapshot.pending[0].admissionState, undefined);
      assert.equal(retained.snapshot.outcomes[pendingOperationId], undefined);
      assert.equal(
        [...retained.snapshot.pending, ...Object.values(retained.snapshot.outcomes)].some(
          (entry) => entry.remote?.commandId === blockedId,
        ),
        false,
      );
      proof.undispatchedPending = {
        boundary:
          "Host accepted-before-dispatch durable-stage injection; no crash or lost Core reply",
        stageRequestId: pendingStage.requestId,
        commandId: pendingCommandId,
        operationId: pendingOperationId,
        retainedPending: true,
        coreReceiptCountForOriginalId: 0,
        before: beforePending,
        after: afterPending,
      };
      guardedPhone.close();
      proof.checks.push(
        "same-peer overlapping send has one Host operation, Core receipt and Turn",
        "Host terminal journal loss recovers the original Core receipt through command.read only",
        "changed text conflicts and stale/busy guards preserve Core state",
        "unread original queue reply is recovered by command.read without replay",
        "exact send and queue completion survive phone close and reach Relay/APNs once",
        "unrelated local completion and original-ID reads do not create another push",
        "undispatched pending remains UNKNOWN and fences same-thread submission without Core mutation",
      );
      proof.completion = {
        turnId: original.turnId,
        queuedTurnId: queueItem.turnId,
        queueItemId: pending.id,
        turnCount: 3,
        pushes: relay.frames.length,
        apnsRequests: relay.records.length,
      };
    },
  );
}
