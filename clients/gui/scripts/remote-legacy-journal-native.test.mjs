import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { recoverSentEffect } from "./remote-send-recovery-scenario.mjs";
import {
  hash,
  until,
  observeNone,
  pushRelay,
  phone,
  grant,
  privateFree,
  runWithIsolatedCA,
} from "./remote-native-push-fixture.mjs";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { RemoteControl } = require("../app/src/core/remote.cjs");

function oldRecord(snapshot, commandId) {
  const records = [...snapshot.pending, ...Object.values(snapshot.outcomes)].filter(
    (entry) => entry.remote?.commandId === commandId,
  );
  assert.equal(records.length, 1, "the original JS writer persisted one command record");
  const record = records[0];
  assert.equal(record.nativeDigest, undefined);
  assert.equal(record.coreScope, undefined);
  assert.equal(record.remote.method, "session.send");
  return record;
}
function recordEvidence(record) {
  return {
    operationId: record.operationId,
    commandId: record.remote.commandId,
    peer: record.remote.devicePeerId,
    method: record.method,
    admissionState: record.admissionState ?? "unknown",
    threadId: record.threadId ?? record.params.threadId,
    turnId: record.turnId ?? null,
    queueItemId: record.receipt?.queueItemId ?? null,
    paramsSha256: record.params ? hash(JSON.stringify(record.params)) : null,
    lacksNativeBindingFields: record.nativeDigest === undefined && record.coreScope === undefined,
  };
}
async function originalCoreReceipt(native, record) {
  const result = await native.core.call("areal/request/read", {
    threadId: record.threadId ?? record.params.threadId,
    requestId: record.operationId,
  });
  const rows = result.data.filter(
    (receipt) => receipt.requestId === record.operationId && receipt.method === record.method,
  );
  assert.equal(rows.length, 1, "the real original Core has one matching receipt");
  return {
    requestId: rows[0].requestId,
    method: rows[0].method,
    identity: rows[0].identity,
    digest: rows[0].digest,
    turnId: rows[0].result.turn?.id ?? null,
    queueItemId: rows[0].result.queueItemId ?? null,
  };
}

if (!process.env.RC12_TLS_HOME) {
  test("legacy JS journal native handoff uses the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "post-import original JS send journal recovers and completes on the same native Core",
    {
      timeout: 240000,
    },
    async (t) => {
      let backend, legacy, drain;
      const drainLegacy = () =>
        (drain ??= (async () => {
          await legacy?.close();
          await backend?.disconnect();
        })());
      t.after(drainLegacy);
      const token = "e".repeat(64);
      const relay = await pushRelay(t);
      const f = await nativeHostFixture(t, { deferNative: true });
      assert.equal(f.remote, null);
      const native = await nativeCoreProject(t, f, { holdModel: true, effectModel: true });
      const proof = {
        storageClass:
          "original JS HostJournal writes after source import and before native gateway handoff",
        sourceId: f.source.sourceId,
        migrationId: f.source.migrationId,
        checks: [],
      };
      f.evidence.legacyJournal = proof;
      t.after(() => {
        proof.relay = relay.evidence();
        proof.modelResponses = native.modelResponseEvidence();
        privateFree(proof, [token]);
        return writeFile(
          join(f.evidence.root, "legacy-journal-evidence.json"),
          JSON.stringify(proof, null, 2),
          { mode: 0o600 },
        );
      });
      const journal = f.client.journal(native.projectId);
      const initial = await journal.read();
      assert.equal(initial.snapshot.pending.length, 0);
      assert.equal(Object.keys(initial.snapshot.outcomes).length, 0);
      proof.initialJournalRevision = initial.revision;
      backend = new CoreBackend({
        binary: f.evidence.binary,
        home: f.source.source.coreHome,
        hostHome: f.home,
        guiProfile: f.source.source.profile,
        harnessHome: f.source.source.legacyServiceHome,
        sourceSingletonHeld: true,
        userHome: join(f.evidence.root, "user"),
        configHome: join(f.evidence.root, "configuration"),
        encryption: f.source.options.encryption,
      });
      backend.host = f.source;
      await backend.init();
      const project = await backend.start(native.alias);
      assert.equal(
        backend.providers.manages(project),
        false,
        "the original backend attaches the existing foreign Core without configuring it",
      );
      assert.equal(project.service.serviceId, native.service.serviceId);
      assert.equal(project.service.generation, native.service.generation);
      assert.equal(project.service.corePid, native.service.corePid);
      const originalIdentity = {
        serviceId: project.service.serviceId,
        generation: project.service.generation,
        corePid: project.service.corePid,
      };
      const dispatches = [];
      let loseResponse = false,
        lostOperationId;
      const requestCore = project.client.request.bind(project.client);
      project.client.request = async (method, params, ...options) => {
        if (method === "areal/request/read" && params.requestId === lostOperationId)
          throw Object.assign(
            new Error("original JS receipt response withheld until owner drain"),
            { submissionUnknown: true },
          );
        if (["areal/turn/start", "areal/turn/enqueue"].includes(method))
          dispatches.push({ method, requestId: params.requestId });
        const result = await requestCore(method, params, ...options);
        if (method === "areal/turn/start" && loseResponse) {
          loseResponse = false;
          lostOperationId = params.requestId;
          throw Object.assign(new Error("fixture lost response"), { submissionUnknown: true });
        }
        return result;
      };
      legacy = new RemoteControl({ backend, schedule() {} });
      await legacy.init();
      assert.equal(legacy.storage.leased, true);
      assert.equal(legacy.storage.nativeOwned, false);
      await legacy.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(() => legacy.connected, "the original JS owner connects to production Relay");
      const oldPhone = await phone(t, legacy, native.alias, undefined, true);
      const registered = await oldPhone.rpc(
        "device.push.register",
        {
          platform: "apns",
          token,
          environment: "development",
        },
        randomUUID(),
      );
      assert.equal(registered.result?.registered === true, true);
      const peer = oldPhone.peer;
      let activePhone = oldPhone;
      const context = (client) => ({
        projectId: native.alias,
        gatewayGeneration: client.active.gatewayGeneration,
        grantRevision: client.active.grantRevision,
        serviceGeneration: native.service.generation,
      });
      const a = {
        rpc: (method, params, commandId) =>
          activePhone.rpc(
            method,
            params,
            method === "command.read" ? undefined : commandId,
            method === "command.read" ? { projectId: native.alias } : context(activePhone),
          ),
      };
      const createThread = async () =>
        (
          await native.core.call("areal/thread/start", {
            requestId: randomUUID(),
            cwd: native.workspace,
            agentProfile: { id: "fixture", revision: "v1" },
          })
        ).thread.id;
      const readThread = async (threadId) =>
        (
          await native.core.call("thread/read", {
            threadId,
            includeTurns: true,
          })
        ).thread;
      const threadId = await createThread();
      let accepted, queued, heldAccepted, nativeRemote, absentRecord;
      const acceptedText = `PRIVATE_LEGACY_ACCEPTED_${randomUUID()}`;
      const queuedText = `PRIVATE_LEGACY_QUEUE_${randomUUID()}`;
      const scenario = await recoverSentEffect({
        a,
        threadId,
        workspace: native.workspace,
        control: async (method, value) => {
          assert.equal(method, "fault");
          assert.equal(value, "lost-native-response");
          loseResponse = true;
        },
        settled: (id) =>
          until(
            async () => (await readThread(id)).status.type === "idle",
            "the original effect Turn settles after native handoff",
          ),
        afterUnknown: async ({ effect, sendId, params }) => {
          const heldEffect = await native.waitForModel(params.text);
          const completionThread = await createThread();
          const acceptedId = randomUUID(),
            queueId = randomUUID();
          const sent = await a.rpc(
            "session.send",
            { threadId: completionThread, expectedConfigRevision: 1, text: acceptedText },
            acceptedId,
          );
          assert.equal(sent.result?.admissionState, "accepted");
          heldAccepted = await native.waitForModel(acceptedText);
          const enqueued = await a.rpc(
            "session.send",
            {
              threadId: completionThread,
              expectedConfigRevision: 1,
              text: queuedText,
              enqueue: true,
              expectedTurnId: sent.result.turnId,
            },
            queueId,
          );
          assert.equal(enqueued.result?.admissionState, "accepted");
          const original = await journal.read();
          assert.equal(original.revision > initial.revision, true);
          const pending = oldRecord(original.snapshot, sendId);
          assert.equal(pending.admissionState, undefined);
          assert.equal(pending.params.requestId, pending.operationId);
          accepted = oldRecord(original.snapshot, acceptedId);
          queued = oldRecord(original.snapshot, queueId);
          assert.equal(accepted.admissionState, "accepted");
          assert.equal(queued.admissionState, "accepted");
          assert.equal(accepted.params, undefined);
          assert.equal(queued.params, undefined);
          assert.equal(typeof queued.receipt.queueItemId, "string");
          assert.equal(
            (await readThread(completionThread)).turns.find((turn) => turn.id === accepted.turnId)
              ?.status,
            "inProgress",
          );
          proof.beforeHandoff = {
            journalRevision: original.revision,
            pending: recordEvidence(pending),
            accepted: recordEvidence(accepted),
            queued: recordEvidence(queued),
            receipts: await Promise.all(
              [pending, accepted, queued].map((record) => originalCoreReceipt(native, record)),
            ),
            sourceIdentity: originalIdentity,
          };
          oldPhone.close();
          await drainLegacy();
          const drained = await journal.read();
          assert.deepEqual(oldRecord(drained.snapshot, sendId), pending);
          assert.deepEqual(oldRecord(drained.snapshot, acceptedId), accepted);
          assert.deepEqual(oldRecord(drained.snapshot, queueId), queued);
          nativeRemote = await f.make();
          assert.equal(nativeRemote.storage.nativeOwned, true);
          const status = await f.client.status();
          const same = status.projects.find(
            (entry) => entry.registration.projectId === native.projectId,
          ).service;
          assert.deepEqual(
            { serviceId: same.serviceId, generation: same.generation, corePid: same.corePid },
            originalIdentity,
          );
          await until(
            async () => (await nativeRemote.refresh()).connected,
            "the native Relay owner is connected before reconnecting the original phone",
          );
          activePhone = await phone(t, nativeRemote, native.alias, oldPhone.identity);
          proof.handoff = {
            sameCore: true,
            sourceId: f.source.sourceId,
            originalJsDrained: true,
            legacyExecutionLeaseReleased: legacy.storage.leased === false,
          };
          assert.equal(proof.handoff.legacyExecutionLeaseReleased, true);
          const coreBeforeFaults = await originalCoreReceipt(native, pending);
          const threadBeforeFaults = await readThread(threadId);
          const faultCommits = [];
          const pendingRow = async (operationId = pending.operationId) => {
            const { snapshot } = await journal.read();
            const rows = snapshot.pending.filter((row) => row.operationId === operationId);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].legacyReceiptProof, undefined);
            assert.equal(snapshot.outcomes[operationId], undefined);
            return rows[0];
          };
          const changeRow = async (transform) => {
            const receipt = await journal.change((snapshot) => {
              const index = snapshot.pending.findIndex(
                (row) => row.operationId === pending.operationId,
              );
              assert.notEqual(index, -1);
              snapshot.pending[index] = transform(snapshot.pending[index]);
              return snapshot;
            });
            assert.equal(receipt.state, "completed");
            faultCommits.push(receipt.requestId);
          };
          const replaceIdentity = async (row) => {
            const removed = await journal.change((snapshot) => {
              const matching = snapshot.pending.filter(
                (entry) => entry.operationId === pending.operationId,
              );
              assert.equal(matching.length, 1);
              snapshot.pending = snapshot.pending.filter(
                (entry) => entry.operationId !== pending.operationId,
              );
              return snapshot;
            });
            assert.equal(removed.state, "completed");
            const inserted = await journal.change((snapshot) => {
              assert.equal(
                snapshot.pending.some((entry) => entry.operationId === pending.operationId),
                false,
              );
              assert.equal(snapshot.outcomes[pending.operationId], undefined);
              snapshot.pending.push(structuredClone(row));
              return snapshot;
            });
            assert.equal(inserted.state, "completed");
            faultCommits.push(removed.requestId, inserted.requestId);
          };
          const staysUnknown = async (commandId) => {
            const response = await a.rpc("command.read", { commandId });
            assert.equal(response.error, undefined);
            assert.equal(response.result.admissionState, "unknown");
            assert.equal(response.result.submissionUnknown, true);
          };
          assert.deepEqual(await pendingRow(), pending);
          await changeRow((row) => ({ ...row, nativeDigest: null }));
          await staysUnknown(sendId);
          assert.equal((await pendingRow()).nativeDigest, null);
          await changeRow(() => structuredClone(pending));
          const changedInput = structuredClone(pending);
          changedInput.params.input[0].text = "PRIVATE_LEGACY_WRONG_ORIGINAL_INPUT";
          await replaceIdentity(changedInput);
          await staysUnknown(sendId);
          await pendingRow();
          assert.deepEqual(await originalCoreReceipt(native, pending), coreBeforeFaults);
          await replaceIdentity(pending);
          const wrongHost = structuredClone(pending);
          assert.notEqual(oldPhone.peer, pending.remote.hostId);
          wrongHost.remote.hostId = oldPhone.peer;
          await replaceIdentity(wrongHost);
          const wrongSource = await a.rpc("command.read", { commandId: sendId });
          assert.equal(wrongSource.error, undefined);
          assert.equal(["notFound", "unknown"].includes(wrongSource.result.admissionState), true);
          assert.equal(wrongSource.result.submissionUnknown, true);
          await pendingRow();
          await replaceIdentity(pending);
          assert.deepEqual(await pendingRow(), pending);
          const nonce = randomUUID(),
            nonceCommand = randomUUID();
          absentRecord = {
            ...structuredClone(pending),
            operationId: nonce,
            params: { ...structuredClone(pending.params), requestId: nonce },
            remote: { ...pending.remote, commandId: nonceCommand },
          };
          const absentCommit = await journal.change((snapshot) => {
            assert.equal(
              snapshot.pending.some((row) => row.operationId === nonce),
              false,
            );
            snapshot.pending.push(absentRecord);
            return snapshot;
          });
          assert.equal(absentCommit.state, "completed");
          await staysUnknown(nonceCommand);
          assert.deepEqual(await pendingRow(nonce), absentRecord);
          const noReceipt = await native.core.call("areal/request/read", {
            threadId,
            requestId: nonce,
          });
          assert.equal(noReceipt.data.length, 0);
          assert.deepEqual(await originalCoreReceipt(native, pending), coreBeforeFaults);
          const threadAfterFaults = await readThread(threadId);
          assert.equal(threadAfterFaults.turns.length, threadBeforeFaults.turns.length);
          assert.equal(
            threadAfterFaults.desktop.receipts.length,
            threadBeforeFaults.desktop.receipts.length,
          );
          proof.negativeFaults = {
            boundary:
              "explicit reversible journal-row faults after original JS drain; not normal writer output",
            identityChangeBoundary:
              "remove and reinsert through serial CAS to preserve the production immutable-pending guard",
            faultCommitRequestIds: faultCommits,
            mixedNativeFieldStayedUnknown: true,
            wrongInputDigestStayedUnknown: true,
            wrongHostNotAdopted: true,
            originalCoreReceipt: coreBeforeFaults,
            before: {
              turns: threadBeforeFaults.turns.length,
              receipts: threadBeforeFaults.desktop.receipts.length,
            },
            after: {
              turns: threadAfterFaults.turns.length,
              receipts: threadAfterFaults.desktop.receipts.length,
            },
            retainedUndispatched: {
              commandId: nonceCommand,
              operationId: nonce,
              stageRequestId: absentCommit.requestId,
              coreReceiptCount: 0,
            },
          };
          heldEffect.release();
          proof.effect = {
            effect,
            commandId: sendId,
            operationId: pending.operationId,
            threadId,
            originalNativeDispatches: dispatches.filter(
              (entry) => entry.requestId === pending.operationId,
            ).length,
          };
          assert.equal(proof.effect.originalNativeDispatches, 1);
        },
      });
      assert.equal(scenario.receipt.operationId, proof.effect.operationId);
      const recovered = await journal.read();
      const recoveredPending = Object.values(recovered.snapshot.outcomes).find(
        (record) => record.remote?.commandId === scenario.sendId,
      );
      assert.equal(recoveredPending.admissionState, "accepted");
      assert.equal(recoveredPending.turnId, scenario.receipt.turnId);
      const originalReceipt = await originalCoreReceipt(native, recoveredPending);
      assert.equal(originalReceipt.turnId, scenario.receipt.turnId);
      proof.recovered = {
        commandId: scenario.sendId,
        operationId: scenario.receipt.operationId,
        turnId: scenario.receipt.turnId,
        core: originalReceipt,
        runtimeEffect: await readFile(join(native.workspace, "effects", scenario.effect), "utf8"),
      };
      for (const record of [accepted, queued]) {
        const read = await a.rpc("command.read", { commandId: record.remote.commandId });
        assert.equal(read.result?.admissionState, "accepted");
        assert.equal(read.result.operationId, record.operationId);
      }
      const readyProofs = await until(async () => {
        const { snapshot } = await journal.read();
        const originalProofs = [accepted, queued].map(
          (record) => snapshot.outcomes[record.operationId]?.legacyReceiptProof,
        );
        return originalProofs.every((value) => value?.version === 1) ? originalProofs : null;
      }, "the original accepted and queue records have source-bound observation proofs");
      proof.completionProofs = readyProofs.map((value) => hash(JSON.stringify(value)));
      activePhone.close();
      await until(
        async () => (await grant(nativeRemote, peer)).online === false,
        "the original paired phone is offline after native handoff",
      );
      assert.equal(relay.frames.length, 0);
      const matching = (record) =>
        relay.frames.filter(
          ({ message }) =>
            message.collapseId ===
            hash(JSON.stringify([native.alias, peer, record.remote.commandId])),
        );
      heldAccepted.release();
      const heldQueue = await native.waitForModel(queuedText);
      await until(
        () => matching(accepted).length === 1,
        "old JS accepted in-progress Turn completion reaches production Relay",
      );
      assert.equal(
        matching(queued).length,
        0,
        "the old JS queue does not complete on the preceding Turn",
      );
      const running = await readThread(accepted.threadId);
      const queueItem = running.desktop.queue.items.find(
        (item) => item.id === queued.receipt.queueItemId,
      );
      assert.equal(typeof queueItem.turnId, "string");
      assert.notEqual(queueItem.turnId, accepted.turnId);
      heldQueue.release();
      await until(
        async () =>
          (await readThread(accepted.threadId)).turns.find((turn) => turn.id === queueItem.turnId)
            ?.status === "completed",
        "the exact old JS queued Turn completes on the original Core",
      );
      await until(
        () => matching(queued).length === 1,
        "old JS queue completion reaches production Relay",
      );
      for (const record of [accepted, queued]) {
        const frame = matching(record)[0].message;
        assert.equal(frame.kind, "turnCompleted");
        assert.equal(frame.token === token, true);
        assert.equal(frame.count, 1);
        assert.equal(frame.target.projectId, native.alias);
        assert.equal(frame.target.threadId, accepted.threadId);
        assert.equal(
          [acceptedText, queuedText, "NATIVE_REMOTE_FIXTURE"].some((text) =>
            JSON.stringify(frame).includes(text),
          ),
          false,
        );
      }
      await until(() => relay.records.length === 2, "original JS command APNs deliveries");
      assert.equal(
        relay.records.every((record) => record.token === token && record.replied),
        true,
      );
      const finalPhone = await phone(t, nativeRemote, native.alias, oldPhone.identity);
      for (const record of [accepted, queued]) {
        const result = await finalPhone.rpc(
          "command.read",
          {
            commandId: record.remote.commandId,
          },
          undefined,
          { projectId: native.alias },
        );
        assert.equal(result.result.operationId, record.operationId);
      }
      finalPhone.close();
      await observeNone(
        () => relay.frames.length - 2,
        "original receipt reads do not replay old completion pushes",
      );
      assert.equal(await readFile(join(native.workspace, "effects", scenario.effect), "utf8"), "x");
      const finalJournal = await journal.read();
      const retainedUnknown = finalJournal.snapshot.pending.find(
        (record) => record.operationId === absentRecord.operationId,
      );
      assert.deepEqual(retainedUnknown, absentRecord);
      assert.equal(retainedUnknown.legacyReceiptProof, undefined);
      assert.equal(
        (
          await native.core.call("areal/request/read", {
            threadId,
            requestId: absentRecord.operationId,
          })
        ).data.length,
        0,
      );
      proof.completion = {
        acceptedCommandId: accepted.remote.commandId,
        queueCommandId: queued.remote.commandId,
        originalTurnId: accepted.turnId,
        queuedTurnId: queueItem.turnId,
        queueItemId: queued.receipt.queueItemId,
        frames: relay.frames.length,
        apnsRequests: relay.records.length,
      };
      proof.dispatches = dispatches;
      proof.checks.push(
        "original JS submitRemote persisted post-import HostJournal pending/outcomes without native bindings",
        "original send recovery assertions preserve one Runtime append through same-Core native handoff",
        "mixed native fields, changed input, wrong source and undispatched nonce do not gain legacy proof",
        "original accepted in-progress and queue records complete through real Relay/APNs after JS owner drain",
      );
    },
  );
}
