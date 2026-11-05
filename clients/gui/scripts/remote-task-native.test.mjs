import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { taskQuestion, taskScenario } from "./remote-task-scenario.mjs";
import { until, pushRelay, phone, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { RemoteControl } = require("@areal/workbench-service/desktop/core/remote.cjs");

if (!process.env.RC12_TLS_HOME) {
  test("native Task controls use the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "old and native Task questions, pause and original receipt recovery",
    { timeout: 240000 },
    async (t) => {
      const relay = await pushRelay(t);
      const f = await nativeHostFixture(t, { deferNative: true });
      const native = await nativeCoreProject(t, f, { taskModel: true });
      const evidence = { responses: [] };
      const persist = () =>
        writeFile(
          join(f.evidence.root, "native-task-evidence.json"),
          JSON.stringify(evidence, null, 2),
          { mode: 0o600 },
        );
      t.after(persist);
      const backend = new CoreBackend({
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
      let legacy, drained;
      const drain = () =>
        (drained ??= (async () => {
          await legacy?.close();
          await backend.disconnect();
        })());
      t.after(drain);
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
      await until(() => legacy.connected, "old Task owner Relay ready");
      const oldPhone = await phone(t, legacy, native.alias, undefined, true);
      const otherOldPhone = await phone(t, legacy, native.alias, undefined, true);
      const rpcFor =
        (client, responses) =>
        async (method, params = {}, commandId = randomUUID()) => {
          const read = [
            "task.read",
            "task.question.read",
            "session.open",
            "subscription.close",
            "command.read",
          ].includes(method);
          const result = await client.rpc(
            method,
            params,
            read ? undefined : commandId,
            read
              ? { projectId: native.alias }
              : {
                  projectId: native.alias,
                  gatewayGeneration: client.active.gatewayGeneration,
                  grantRevision: client.active.grantRevision,
                  serviceGeneration: native.service.generation,
                },
          );
          if (["task.pause", "task.question.reply"].includes(method) && result.error) {
            assert.equal(result.error.commandId, commandId);
            if (
              ["INVALID_PARAMS", "TARGET_CHANGED", "REVIEW_INCOMPLETE"].includes(result.error.code)
            )
              assert.equal(result.error.submissionUnknown, false);
          }
          responses?.push({ method, params, commandId, result });
          return result;
        };
      const oldRpc = rpcFor(oldPhone, evidence.responses);
      try {
        evidence.old = await taskScenario({
          rpc: oldRpc,
          otherRpc: rpcFor(otherOldPhone),
          native: (method, params) => native.core.call(method, params),
          workspace: native.workspace,
          until,
        });
      } catch (error) {
        evidence.oldError = {
          name: error.name,
          code: error.code,
          message: error.message,
          stack: error.stack,
        };
        await persist();
        throw error;
      }
      const lost = [],
        suppressed = new Set();
      let withhold;
      const requestCore = oldProject.client.request.bind(oldProject.client);
      oldProject.client.request = async (method, params, ...rest) => {
        if (
          method === "areal/request/read" &&
          typeof params.requestId === "string" &&
          suppressed.has(params.requestId)
        )
          throw Object.assign(new Error("original Task receipt withheld until owner drain"), {
            submissionUnknown: true,
          });
        const result = await requestCore(method, params, ...rest);
        if (method !== withhold) return result;
        withhold = null;
        suppressed.add(params.requestId);
        lost.push({ method, params: structuredClone(params), result: structuredClone(result) });
        throw Object.assign(new Error("original Task response lost"), { submissionUnknown: true });
      };
      const journal = f.client.journal(native.projectId);
      const lose = async (method, params) => {
        withhold = method === "task.pause" ? "areal/task/pause" : "areal/channel/reply";
        const commandId = randomUUID();
        const response = await oldRpc(method, params, commandId);
        assert.equal(response.result?.admissionState, "unknown", JSON.stringify(response));
        const record = (await journal.read()).snapshot.pending.find(
          (row) => row.operationId === response.result.operationId,
        );
        assert.equal(record.remote.commandId, commandId);
        assert.equal(record.nativeDigest, undefined);
        assert.equal(record.coreScope, undefined);
        const receipts = (
          await native.core.call("areal/request/read", { requestId: record.operationId })
        ).data.filter((receipt) => receipt.method === record.method);
        assert.equal(receipts.length, 1);
        assert.deepEqual(receipts[0].operation.target, { kind: "task", taskId: params.taskId });
        lost.at(-1).record = record;
        lost.at(-1).response = response;
        lost.at(-1).receipts = receipts;
      };
      const question = await taskQuestion(
        (method, params) => native.core.call(method, params),
        native.workspace,
        until,
      );
      await lose("task.question.reply", {
        ...question.target,
        answers: { choice: "B", free: "legacy original answer" },
      });
      await question.release();
      await until(
        async () =>
          (await native.core.call("areal/task/read", { taskId: question.taskId })).runs[0]
            .status === "completed",
        "old lost-reply original Task finishes",
      );
      const keyRetries = [];
      const answers = { Z: "B", a: "original", 10: "ten", 2: "two" };
      for (const unknown of [true, false]) {
        const task = await taskQuestion(
          (method, params) => native.core.call(method, params),
          native.workspace,
          until,
          "RC08_KEYS",
        );
        const params = { ...task.target, answers };
        let record, response;
        if (unknown) {
          await lose("task.question.reply", params);
          ({ record, response } = lost.at(-1));
        } else {
          const commandId = randomUUID();
          response = await oldRpc("task.question.reply", params, commandId);
          assert.equal(response.result?.admissionState, "accepted", JSON.stringify(response));
          record = (await journal.read()).snapshot.outcomes[response.result.operationId];
          assert.equal(record.params, undefined);
        }
        keyRetries.push({ params, record, response, unknown });
        await task.release();
        await until(
          async () =>
            (await native.core.call("areal/task/read", { taskId: task.taskId })).runs[0].status ===
            "completed",
          "original keyed-answer Task completes once",
        );
      }
      evidence.keyRetries = keyRetries;
      const paused = await taskQuestion(
        (method, params) => native.core.call(method, params),
        native.workspace,
        until,
      );
      const pauseTask = await native.core.call("areal/task/read", { taskId: paused.taskId });
      await lose("task.pause", {
        taskId: paused.taskId,
        expectedRunId: paused.runId,
        expectedRevision: pauseTask.revision,
      });
      await until(async () => {
        const task = await native.core.call("areal/task/read", { taskId: paused.taskId });
        return (
          task.paused &&
          task.runs[0].status === "paused" &&
          task.runs[0].workers.every((worker) => worker.settled)
        );
      }, "old paused original Task settles before handoff");
      evidence.lost = lost;
      oldPhone.close();
      otherOldPhone.close();
      await drain();
      const remote = await f.make();
      await until(
        () => remote.refresh().then((state) => state.connected),
        "native Task owner Relay ready",
      );
      const client = await phone(t, remote, native.alias, oldPhone.identity);
      const other = await phone(t, remote, native.alias, otherOldPhone.identity);
      const rpc = rpcFor(client, evidence.responses);
      for (const retry of keyRetries) {
        const commandId = retry.record.remote.commandId;
        const before = await native.core.call("areal/task/read", { taskId: retry.params.taskId });
        const conflict = await rpc(
          "task.question.reply",
          { ...retry.params, answers: { ...retry.params.answers, a: "changed" } },
          commandId,
        );
        assert.equal(conflict.error?.code, "COMMAND_CONFLICT", JSON.stringify(conflict));
        retry.retried = await rpc("task.question.reply", retry.params, commandId);
        assert.equal(
          retry.retried.result?.admissionState,
          "accepted",
          JSON.stringify(retry.retried),
        );
        assert.equal(retry.retried.result.operationId, retry.record.operationId);
        const row = (await journal.read()).snapshot.outcomes[retry.record.operationId];
        assert.deepEqual(row.remote, retry.record.remote);
        assert.equal(row.nativeDigest, undefined);
        assert.equal(row.coreScope, undefined);
        assert.equal(row.legacyReceiptProof.receipt.taskId, retry.params.taskId);
        assert.equal(row.legacyReceiptProof.source.sourceId, f.source.sourceId);
        const receipts = (
          await native.core.call("areal/request/read", { requestId: retry.record.operationId })
        ).data.filter((value) => value.method === "areal/channel/reply");
        assert.equal(receipts.length, 1);
        assert.equal(row.legacyReceiptProof.receipt.digest, receipts[0].digest);
        retry.proof = row.legacyReceiptProof;
        assert.equal(
          (await rpc("task.question.reply", retry.params, commandId)).result.operationId,
          retry.record.operationId,
        );
        assert.deepEqual(
          await native.core.call("areal/task/read", { taskId: retry.params.taskId }),
          before,
        );
      }
      for (const loss of lost) {
        const before = await native.core.call("areal/task/read", { taskId: loss.params.taskId });
        loss.recovered = await rpc("command.read", { commandId: loss.record.remote.commandId });
        assert.equal(
          loss.recovered.result?.admissionState,
          "accepted",
          JSON.stringify(loss.recovered),
        );
        assert.equal(loss.recovered.result.operationId, loss.record.operationId);
        const row = (await journal.read()).snapshot.outcomes[loss.record.operationId];
        assert.deepEqual(row.remote, loss.record.remote);
        assert.equal(row.nativeDigest, undefined);
        assert.equal(row.coreScope, undefined);
        assert.equal(row.legacyReceiptProof.source.sourceId, f.source.sourceId);
        assert.equal(row.legacyReceiptProof.source.migrationId, f.source.migrationId);
        assert.equal(row.legacyReceiptProof.receipt.taskId, loss.params.taskId);
        assert.equal(row.legacyReceiptProof.receipt.threadId, undefined);
        assert.equal(row.legacyReceiptProof.receipt.digest, loss.receipts[0].digest);
        assert.deepEqual(
          await native.core.call("areal/task/read", { taskId: loss.params.taskId }),
          before,
        );
        loss.proof = row.legacyReceiptProof;
      }
      evidence.native = await taskScenario({
        rpc,
        otherRpc: rpcFor(other),
        native: (method, params) => native.core.call(method, params),
        workspace: native.workspace,
        until,
      });
    },
  );
}
