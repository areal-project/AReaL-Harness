import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { fastPreservation } from "./remote-configure-scenario.mjs";
import { sessionControls } from "./remote-controls-scenario.mjs";
import { until, pushRelay, phone, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { RemoteControl } = require("../app/src/core/remote.cjs");
const { nativeControl } = require("../app/src/core/remote-session-controls.cjs");

if (!process.env.RC12_TLS_HOME) {
  test("native configure uses the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "native controls preserve original settings and goal/queue ownership",
    { timeout: 240000 },
    async (t) => {
      let backend, legacy, drained;
      const drain = () =>
        (drained ??= (async () => {
          await legacy?.close();
          await backend?.disconnect();
        })());
      t.after(drain);
      const relay = await pushRelay(t);
      const f = await nativeHostFixture(t, { deferNative: true });
      const native = await nativeCoreProject(t, f, { holdModel: true });
      const evidence = { responses: [] };
      t.after(() =>
        writeFile(
          join(f.evidence.root, "native-configure-evidence.json"),
          JSON.stringify(evidence, null, 2),
          {
            mode: 0o600,
          },
        ),
      );
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
      await backend.command("providers", { operation: "list" });
      const oldProject = await backend.start(native.alias);
      assert.equal(oldProject.service.serviceId, native.service.serviceId);
      assert.equal(oldProject.service.generation, native.service.generation);
      legacy = new RemoteControl({ backend, schedule() {} });
      await legacy.init();
      await legacy.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(() => legacy.connected, "original JS owner connected");
      const oldPhone = await phone(t, legacy, native.alias, undefined, true);
      const oldContext = {
        projectId: native.alias,
        gatewayGeneration: oldPhone.active.gatewayGeneration,
        grantRevision: oldPhone.active.grantRevision,
        serviceGeneration: native.service.generation,
      };
      const oldResult = await fastPreservation({
        rpc: (method, params = {}) => oldPhone.rpc(method, params, randomUUID(), oldContext),
        native: (method, params) => native.core.call(method, params),
      });
      const otherOldPhone = await phone(t, legacy, native.alias, undefined, true);
      const oldRpc =
        (client) =>
        (method, params = {}, commandId = randomUUID()) =>
          client.rpc(
            method,
            params,
            ["session.open", "command.read"].includes(method) ? undefined : commandId,
            ["session.open", "command.read"].includes(method)
              ? { projectId: native.alias }
              : {
                  ...oldContext,
                  gatewayGeneration: client.active.gatewayGeneration,
                  grantRevision: client.active.grantRevision,
                },
          );
      try {
        evidence.oldControls = await sessionControls({
          rpc: oldRpc(oldPhone),
          otherRpc: oldRpc(otherOldPhone),
          native: (method, params) => native.core.call(method, params),
          waitForModel: (text) => native.waitForModel(text),
          writeRequestsPerSecond: oldPhone.active.limits.writeRequestsPerSecond,
          until,
        });
      } catch (error) {
        evidence.oldControlsError = {
          name: error.name,
          code: error.code,
          message: error.message,
          stack: error.stack,
        };
        await writeFile(
          join(f.evidence.root, "native-configure-evidence.json"),
          JSON.stringify(evidence, null, 2),
          { mode: 0o600 },
        );
        throw error;
      }
      const dispatches = [],
        losses = [],
        suppressedReads = new Set();
      let originalOperation,
        lossMethod = "areal/thread/configure";
      const requestCore = oldProject.client.request.bind(oldProject.client);
      oldProject.client.request = async (method, params, ...rest) => {
        if (
          method === "areal/request/read" &&
          typeof params.requestId === "string" &&
          suppressedReads.has(params.requestId)
        )
          throw Object.assign(new Error("original receipt withheld until owner drain"), {
            submissionUnknown: true,
          });
        if (method !== lossMethod) return requestCore(method, params, ...rest);
        lossMethod = null;
        await requestCore(method, params, ...rest);
        losses.push({ method, params: structuredClone(params) });
        if (typeof params.requestId === "string") suppressedReads.add(params.requestId);
        if (method === "areal/thread/configure") {
          dispatches.push(params.requestId);
          originalOperation = params.requestId;
        }
        throw Object.assign(new Error("original control reply lost"), { submissionUnknown: true });
      };
      const originalId = randomUUID();
      const lost = await oldPhone.rpc(
        "session.control",
        {
          threadId: oldResult.fastThread,
          operation: "configure",
          values: { parameters: { reasoningEffort: "low" } },
          expectedRevision: oldResult.configuration.revision,
        },
        originalId,
        oldContext,
      );
      assert.equal(lost.result.admissionState, "unknown");
      assert.equal(dispatches.length, 1);
      const journal = f.client.journal(native.projectId);
      const old = (await journal.read()).snapshot.pending.find(
        (row) => row.operationId === originalOperation,
      );
      assert.equal(old.remote.commandId, originalId);
      assert.equal(old.nativeDigest, undefined);
      assert.equal(old.coreScope, undefined);
      evidence.legacy = { oldResult, lost, original: old, dispatches };
      const callOld = async (...args) => {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.ceil(1000 / oldPhone.active.limits.writeRequestsPerSecond) + 10),
        );
        return oldRpc(oldPhone)(...args);
      };
      const newOldThread = async () => {
        const created = await callOld("session.create");
        assert.equal(created.result?.admissionState, "accepted", JSON.stringify(created));
        return created.result.threadId;
      };
      const lostControls = [];
      const lose = async (threadId, operation, expectedRevision, values) => {
        const params = { threadId, operation, expectedRevision, values },
          commandId = randomUUID();
        lossMethod = nativeControl(params).method;
        const response = await callOld("session.control", params, commandId);
        assert.equal(response.result?.admissionState, "unknown", JSON.stringify(response));
        const record = (await journal.read()).snapshot.pending.find(
          (row) => row.remote?.commandId === commandId,
        );
        assert.equal(record.operationId, response.result.operationId);
        assert.equal(record.nativeDigest, undefined);
        assert.equal(record.coreScope, undefined);
        const receipts = (
          await native.core.call("areal/request/read", { threadId, requestId: record.operationId })
        ).data.filter((receipt) => receipt.method === record.method);
        if (operation === "steer") assert.equal(receipts.length, 0);
        else assert.ok(receipts.length >= 1);
        if (operation === "queueSteer")
          assert.ok(receipts.length >= 2, "both management and typed Thread receipts exist");
        lostControls.push({ params, commandId, response, record, receipts });
      };
      const pauseThread = await newOldThread();
      await lose(
        pauseThread,
        "queuePause",
        (await native.core.call("areal/queue/list", { threadId: pauseThread })).revision,
        {},
      );
      const goalThread = await newOldThread(),
        objective = `LEGACY_CONTROL_GOAL_${randomUUID()}`;
      const goalCreated = await callOld("session.control", {
        threadId: goalThread,
        operation: "goalCreate",
        expectedRevision: 0,
        values: { objective },
      });
      assert.equal(goalCreated.result?.admissionState, "accepted", JSON.stringify(goalCreated));
      await native.waitForModel(objective);
      await lose(
        goalThread,
        "goalPause",
        (await native.core.call("areal/goal/get", { threadId: goalThread })).revision,
        { goalId: goalCreated.result.receipt.goalId },
      );
      await until(
        async () =>
          !(await native.core.call("areal/goal/get", { threadId: goalThread })).goal.settling,
        "old Goal pause settles with the original response withheld",
      );
      for (const operation of ["queueSteer", "steer"]) {
        const threadId = await newOldThread(),
          text = `LEGACY_${operation}_${randomUUID()}`;
        const started = await callOld("session.send", {
          threadId,
          text,
          expectedConfigRevision: 1,
        });
        assert.equal(started.result?.admissionState, "accepted", JSON.stringify(started));
        await native.waitForModel(text);
        const turnId = started.result.turnId;
        if (operation === "queueSteer") {
          const queued = await callOld("session.send", {
            threadId,
            text: `QUEUED_${text}`,
            expectedConfigRevision: 1,
            enqueue: true,
            expectedTurnId: turnId,
          });
          assert.equal(queued.result?.admissionState, "accepted", JSON.stringify(queued));
          await lose(
            threadId,
            operation,
            (await native.core.call("areal/queue/list", { threadId })).revision,
            { queueItemId: queued.result.receipt.queueItemId, expectedTurnId: turnId },
          );
        } else
          await lose(threadId, operation, 0, { text: `ADDED_${text}`, expectedTurnId: turnId });
        await native.core.call("turn/interrupt", { threadId, turnId });
        await until(
          async () =>
            (
              await native.core.call("thread/read", { threadId, includeTurns: true })
            ).thread.turns.find((turn) => turn.id === turnId)?.status !== "inProgress",
          "the exact old steered Turn settles before handoff",
        );
        lostControls.at(-1).history = (
          await native.core.call("thread/read", { threadId, includeTurns: true })
        ).thread;
      }
      evidence.legacy.lostControls = lostControls;
      evidence.legacy.realDispatches = losses;
      oldPhone.close();
      otherOldPhone.close();
      await drain();
      const remote = await f.make();
      await until(async () => (await remote.refresh()).connected, "native Relay connected");
      const client = await phone(t, remote, native.alias, oldPhone.identity);
      const revisionBeforeRead = (
        await native.core.call("areal/thread/inspect", { threadId: oldResult.fastThread })
      ).configuration.revision;
      const recovered = await client.rpc("command.read", { commandId: originalId }, undefined, {
        projectId: native.alias,
      });
      assert.equal(recovered.result.admissionState, "accepted", JSON.stringify(recovered));
      assert.equal(recovered.result.operationId, originalOperation);
      assert.equal(
        (await native.core.call("areal/thread/inspect", { threadId: oldResult.fastThread }))
          .configuration.revision,
        revisionBeforeRead,
      );
      const retained = (
        await client.rpc(
          "command.read",
          { commandId: oldResult.effortSaved.result.commandId },
          undefined,
          { projectId: native.alias },
        )
      ).result;
      assert.equal(retained.operationId, oldResult.effortSaved.result.operationId);
      assert.equal(retained.admissionState, "accepted");
      const proved = (await journal.read()).snapshot.outcomes[originalOperation];
      assert.deepEqual(proved.remote, old.remote);
      assert.equal(proved.nativeDigest, undefined);
      assert.equal(proved.coreScope, undefined);
      assert.equal(proved.legacyReceiptProof.source.sourceId, f.source.sourceId);
      assert.equal(proved.legacyReceiptProof.source.migrationId, f.source.migrationId);
      evidence.legacy.recovered = recovered;
      evidence.legacy.proof = proved.legacyReceiptProof;
      for (const loss of lostControls) {
        const response = await client.rpc(
          "command.read",
          { commandId: loss.commandId },
          undefined,
          { projectId: native.alias },
        );
        assert.equal(response.result?.operationId, loss.record.operationId);
        assert.equal(
          response.result.admissionState,
          loss.params.operation === "steer" ? "unknown" : "accepted",
          JSON.stringify(response),
        );
        const snapshot = (await journal.read()).snapshot;
        const row =
          loss.params.operation === "steer"
            ? snapshot.pending.find((row) => row.operationId === loss.record.operationId)
            : snapshot.outcomes[loss.record.operationId];
        if (loss.params.operation === "steer") {
          assert.deepEqual(row, loss.record);
          assert.equal(response.result.nativeRequestId, undefined);
          assert.deepEqual(
            (
              await native.core.call("thread/read", {
                threadId: loss.params.threadId,
                includeTurns: true,
              })
            ).thread.turns,
            loss.history.turns,
          );
          const again = await client.rpc("command.read", { commandId: loss.commandId }, undefined, {
            projectId: native.alias,
          });
          assert.equal(again.result.admissionState, "unknown");
        } else {
          assert.deepEqual(row.remote, loss.record.remote);
          assert.equal(row.nativeDigest, undefined);
          assert.equal(row.coreScope, undefined);
          assert.equal(row.legacyReceiptProof.source.sourceId, f.source.sourceId);
          assert.equal(row.legacyReceiptProof.source.migrationId, f.source.migrationId);
          assert.ok(
            loss.receipts.some(
              (receipt) => receipt.digest === row.legacyReceiptProof.receipt.digest,
            ),
          );
          loss.proof = row.legacyReceiptProof;
        }
        loss.recovered = response;
      }
      const pausedGoal = await native.core.call("areal/goal/get", { threadId: goalThread });
      await native.core.call("areal/goal/clear", {
        requestId: randomUUID(),
        threadId: goalThread,
        goalId: pausedGoal.goal.id,
        expectedRevision: pausedGoal.revision,
      });
      const project = (await client.rpc("project.list")).result.projects.find(
        (project) => project.projectId === native.alias,
      );
      const context = {
        projectId: native.alias,
        gatewayGeneration: client.active.gatewayGeneration,
        grantRevision: client.active.grantRevision,
        serviceGeneration: project.serviceGeneration,
      };
      const rpc = async (method, params = {}, commandId = randomUUID()) => {
        const read = ["session.open", "command.read"].includes(method);
        const response = await client.rpc(
          method,
          params,
          read ? undefined : commandId,
          read ? { projectId: native.alias } : context,
        );
        evidence.responses.push({ method, commandId, response });
        return response;
      };
      const result = await fastPreservation({
        rpc,
        native: (method, params) => native.core.call(method, params),
      });
      const other = await phone(t, remote, native.alias, otherOldPhone.identity);
      const otherRpc = (method, params = {}, commandId = randomUUID()) =>
        other.rpc(
          method,
          params,
          method === "session.open" ? undefined : commandId,
          method === "session.open"
            ? { projectId: native.alias }
            : { ...context, grantRevision: other.active.grantRevision },
        );
      evidence.nativeControls = await sessionControls({
        rpc,
        otherRpc,
        native: (method, params) => native.core.call(method, params),
        waitForModel: (text) => native.waitForModel(text),
        writeRequestsPerSecond: client.active.limits.writeRequestsPerSecond,
        until,
      });
      assert.deepEqual(
        evidence.nativeControls.commands.map((command) => command.params.operation),
        evidence.oldControls.commands.map((command) => command.params.operation),
      );
      for (const command of evidence.oldControls.commands) {
        const read = await rpc("command.read", { commandId: command.result.commandId });
        assert.equal(read.result.operationId, command.result.operationId);
        assert.equal(read.result.admissionState, "accepted");
      }
      evidence.result = result;
      const original = result.effortSaved.result;
      assert.equal(
        (await rpc("command.read", { commandId: original.commandId })).result.operationId,
        original.operationId,
      );
    },
  );
}
