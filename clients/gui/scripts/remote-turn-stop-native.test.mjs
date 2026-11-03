import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, phone, until, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";
import { stopSettlement, assertStopSettlement } from "./remote-stop-settlement-scenario.mjs";

if (!process.env.RC12_TLS_HOME) {
  test("native T24 uses the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "original T24 preserves targeted Runtime termination or UNKNOWN",
    { timeout: 240000 },
    async (t) => {
      const expectedUnknownSettlement = {};
      const relay = await pushRelay(t);
      const f = await nativeHostFixture(t, { expectedUnknownSettlement });
      const project = await nativeCoreProject(t, f, { holdModel: true, stopModel: true });
      const settlementEvidence = {},
        taskOwnershipEvidence = {};
      const proof = {
        owner: "Rust Host",
        settlementEvidence,
        taskOwnershipEvidence,
        expectedUnknownSettlement,
      };
      t.after(() =>
        writeFile(join(f.evidence.root, "native-t24.json"), JSON.stringify(proof, null, 2)),
      );
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await f.remote.refresh()).connected, "native Relay connected");
      const device = await phone(t, f.remote, project.alias, undefined, true);
      const a = {
        rpc: (method, params = {}, commandId = randomUUID()) =>
          device.rpc(
            method,
            params,
            commandId,
            method === "command.read"
              ? { projectId: project.alias }
              : {
                  projectId: project.alias,
                  gatewayGeneration: device.active.gatewayGeneration,
                  grantRevision: device.active.grantRevision,
                  serviceGeneration: project.service.generation,
                },
          ),
      };
      const native = (method, params = {}) => project.core.call(method, params);
      const journal = async (accepted) => {
        const { snapshot } = await f.client.journal(project.projectId).read();
        const rows = [...snapshot.pending, ...Object.values(snapshot.outcomes)].filter(
          (row) =>
            row.remote?.devicePeerId === device.peer &&
            row.remote?.commandId === accepted.commandId,
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].operationId, accepted.operationId);
        assert.equal(rows[0].method, "turn/interrupt");
        assert.equal(rows[0].admissionState, "accepted");
        assert.equal(rows[0].remote.method, "turn.stop");
        assert.deepEqual(rows[0].remote.target, settlementEvidence.target);
        return rows[0];
      };
      const offline = async (evidence) => {
        const terminal = (
          await native("thread/read", { threadId: evidence.target.threadId, includeTurns: true })
        ).thread.turns.find((turn) => turn.id === evidence.target.expectedTurnId);
        const outcome = assertStopSettlement(evidence.original, terminal);
        assert.equal(outcome, evidence.outcome);
        let status;
        await until(async () => {
          status = await native("areal/server/status");
          evidence.runtimeCleanupFirst ??= status;
          evidence.runtimeCleanupLatest = status;
          return (
            status.runtime?.activeProcesses === 0 &&
            status.activeTasks === 0 &&
            status.pendingQueueItems === 0 &&
            ["activeTurns", "activeGoals", "resources", "compactions", "workgroups"].every(
              (key) => status[key].length === 0,
            )
          );
        }, "original Runtime resources released before UNKNOWN guard cleanup");
        if (outcome === "terminated") {
          assert.deepEqual(status.unresolvedTools, []);
          assert.equal(status.restartSafe, true);
          evidence.runtimeResourcesConfirmedReleased = true;
          const reference = {
            requestId: randomUUID(),
            projectId: project.projectId,
            serviceId: project.service.serviceId,
            serviceGeneration: project.service.generation,
          };
          evidence.offline = { reference };
          await writeFile(
            join(f.evidence.root, "offline-reference.json"),
            JSON.stringify(reference, null, 2),
          );
          try {
            evidence.offline.receipt = await f.client.stopProject(
              reference.requestId,
              reference.projectId,
              reference.serviceGeneration,
              "ifIdle",
              true,
            );
          } catch (error) {
            evidence.offline.error = { code: error.code, message: error.message };
            evidence.offline.receipt = (await f.client.operation(reference.requestId)).operation;
          }
          assert.equal(evidence.offline.receipt.state, "completed");
          for (const key of ["requestId", "projectId", "serviceId", "serviceGeneration"])
            assert.equal(evidence.offline.receipt[key], reference[key]);
          return;
        }
        const tool = evidence.original.items.find((item) => item.tool === "run_command");
        assert.deepEqual(status.unresolvedTools, [
          { threadId: evidence.target.threadId, itemId: tool.id },
        ]);
        assert.equal(status.restartSafe, false);
        assert.equal(status.runtime.activeProcesses, 0);
        assert.equal(status.activeTasks, 0);
        assert.equal(status.pendingQueueItems, 0);
        for (const key of ["activeTurns", "activeGoals", "resources", "compactions", "workgroups"])
          assert.deepEqual(status[key], []);
        evidence.runtimeResourcesConfirmedReleased = true;
        const reference = {
          kind: "stopHost",
          requestId: randomUUID(),
          home: f.home,
          hostId: f.client.hostId,
          generation: f.client.generation,
          strategy: "cancel",
        };
        Object.assign(expectedUnknownSettlement, {
          reference,
          status,
          terminal,
          target: evidence.target,
          service: project.service,
        });
        const path = join(f.evidence.root, "expected-unknown-stop.json");
        await writeFile(path, JSON.stringify(expectedUnknownSettlement, null, 2));
        try {
          expectedUnknownSettlement.stopReceipt = await f.client.stop(
            reference.requestId,
            reference.generation,
            reference.strategy,
          );
        } catch (error) {
          expectedUnknownSettlement.stopReplyError = { code: error.code, message: error.message };
          expectedUnknownSettlement.stopReceipt = (
            await f.client.operation(reference.requestId)
          ).operation;
        }
        const receipt = expectedUnknownSettlement.stopReceipt;
        assert.equal(receipt.requestId, reference.requestId);
        assert.equal(receipt.hostId, reference.hostId);
        assert.equal(receipt.generation, reference.generation);
        assert(["blocked", "settlementIncomplete"].includes(receipt.state));
        assert.equal(receipt.projects.length, 1);
        const target = receipt.projects[0];
        assert.equal(target.serviceId, project.service.serviceId);
        assert.equal(target.serviceGeneration, project.service.generation);
        assert.equal(target.receipt.lifecycle.executionOutcomes.uninspectedUnknown, 1);
        assert.equal(target.receipt.lifecycle.settled.allowed, false);
        const current = JSON.parse(
          await readFile(
            join(f.home, "services", project.service.serviceId, "service.json"),
            "utf8",
          ),
        );
        assert.equal(current.hostPid, project.service.hostPid);
        assert.equal(current.corePid, project.service.corePid);
        assert.equal(current.generation, project.service.generation);
        const command = execFileSync("/bin/ps", ["-p", String(current.hostPid), "-o", "command="], {
          encoding: "utf8",
        }).trim();
        assert(command.startsWith(`${f.evidence.binary} service-host`));
        project.core.close();
        expectedUnknownSettlement.coreHarnessTermination = {
          pid: current.hostPid,
          signal: "SIGTERM",
          productDrain: false,
          unknownAcknowledged: false,
        };
        await writeFile(path, JSON.stringify(expectedUnknownSettlement, null, 2));
        process.kill(current.hostPid, "SIGTERM");
        for (const pid of [current.hostPid, current.corePid])
          await until(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if (error.code === "ESRCH") return true;
              throw error;
            }
          }, "exact owned Core and service-host exit");
        await writeFile(path, JSON.stringify(expectedUnknownSettlement, null, 2));
      };
      await stopSettlement({
        a,
        native,
        workspace: project.workspace,
        settled: (threadId) =>
          until(
            async () =>
              (await native("thread/read", { threadId, includeTurns: true })).thread.status.type ===
              "idle",
            "original Thread idle",
          ),
        startTurn: async (threadId, text) =>
          (
            await native("areal/turn/start", {
              requestId: randomUUID(),
              threadId,
              input: [{ type: "text", text }],
              expectedConfigRevision: 1,
            })
          ).turn.id,
        waitForModel: () => project.waitForModel("RC05_HOLD"),
        offline,
        journal,
        settlementEvidence,
        taskOwnershipEvidence,
      });
      expectedUnknownSettlement.businessAssertionsPassed = true;
      proof.passed = true;
      proof.notCovered = [
        "physical dispatch count",
        "physical phone",
        "browser",
        "successful product drain of UNKNOWN",
      ];
    },
  );
}
