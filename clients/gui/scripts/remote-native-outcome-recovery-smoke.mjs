import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, phone, until, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";
import { errorDetails, lldbBarrier } from "./remote-native-lldb-test-helper.mjs";

if (!process.env.RC12_TLS_HOME) {
  test("T22 wire uses isolated CA", async () => runWithIsolatedCA(import.meta.filename));
} else {
  test(
    "recover original creation after outcome write failure over Noise",
    { timeout: 270000 },
    async (t) => {
      const relay = await pushRelay(t);
      const fixture = await nativeHostFixture(t);
      const project = await nativeCoreProject(t, fixture);
      const proof = {
        passed: false,
        boundary:
          "single real Host/Noise outcome write fault; original JS response shape remains open",
        scriptSha256: createHash("sha256")
          .update(await readFile(import.meta.filename))
          .digest("hex"),
      };
      t.after(() =>
        writeFile(
          join(fixture.evidence.root, "t22-wire-outcome.json"),
          JSON.stringify(proof, null, 2),
          { mode: 0o600 },
        ),
      );
      await fixture.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await fixture.remote.refresh()).connected, "native Relay ready");
      const device = await phone(t, fixture.remote, project.alias, undefined, true);
      const identity = JSON.parse(await readFile(join(fixture.home, "host/host.json"), "utf8"));
      assert.equal(identity.pid, fixture.evidence.hostPid);
      const records = join(fixture.home, "host/journals/records");
      const filename = join(
        records,
        createHash("sha256").update(project.projectId).digest("hex") + ".json",
      );
      const commandId = randomUUID();
      const context = {
        projectId: project.alias,
        gatewayGeneration: device.active.gatewayGeneration,
        grantRevision: device.active.grantRevision,
        serviceGeneration: project.service.generation,
      };
      let barrier;
      let failure;
      let originalMode;
      let modeChanged = false;
      try {
        barrier = await lldbBarrier(identity.pid, fixture);
        const requestId = device.send("session.create", {}, commandId, context);
        const hit = await barrier.hit();
        const bytes = await readFile(filename);
        const frozen = JSON.parse(bytes);
        const pending = frozen.snapshot.pending.find((row) => row.remote?.commandId === commandId);
        assert.ok(pending);
        assert.equal(frozen.snapshot.outcomes[pending.operationId], undefined);
        let matches = [];
        await until(async () => {
          const receipt = await project.core.call("areal/request/read", {
            requestId: pending.operationId,
            creationAdmission: pending.params.creationAdmission,
          });
          matches = receipt.data.filter(
            (row) =>
              row.requestId === pending.operationId &&
              row.method === "areal/thread/start" &&
              row.digest === pending.nativeDigest &&
              row.identity === pending.params.creationAdmission.identity &&
              row.status === "completed",
          );
          return matches.length > 0;
        }, "original Core creation receipt");
        assert.equal(matches.length, 1);
        const threadId = matches[0].threadId ?? matches[0].result?.threadId;
        assert.ok(threadId);
        assert.equal(matches[0].operation.target.threadId, threadId);
        assert.deepEqual(await readFile(filename), bytes);
        Object.assign(proof, {
          hostPid: identity.pid,
          commandId,
          requestId,
          operationId: pending.operationId,
          threadId,
          pending,
          receipt: matches[0],
          lldb: { pid: barrier.pid, hit },
        });
        const stat = await lstat(records);
        assert.equal(stat.isDirectory(), true);
        assert.equal(stat.uid, process.getuid());
        originalMode = stat.mode & 0o777;
        assert.equal(originalMode, 0o700);
        await chmod(records, 0o500);
        modeChanged = true;
        assert.equal((await lstat(records)).mode & 0o777, 0o500);
        await barrier.cleanup();
        barrier = undefined;
        let response;
        do {
          response = await device.nextMessage();
        } while (response.id !== requestId);
        proof.response = response;
        assert.equal(response.id, requestId);
        assert.equal(response.result, undefined);
        assert.equal(response.error.code, "CORE_UNAVAILABLE");
        assert.equal(response.error.submissionUnknown, true);
        assert.equal(response.error.commandId, commandId);
        assert.deepEqual(await readFile(filename), bytes);
        await chmod(records, originalMode);
        modeChanged = false;
        assert.equal((await lstat(records)).mode & 0o777, originalMode);
        proof.modeRestored = originalMode;
        const recovered = await device.rpc("command.read", { commandId }, undefined, {
          projectId: project.alias,
        });
        assert.equal(recovered.result.admissionState, "accepted", JSON.stringify(recovered));
        assert.equal(recovered.result.operationId, pending.operationId);
        assert.equal(recovered.result.threadId, threadId);
        const before = (await project.core.call("thread/list", { limit: 100 })).data
          .map((row) => row.id)
          .sort();
        assert.deepEqual(before, [threadId]);
        const duplicate = await device.rpc("session.create", {}, commandId, context);
        assert.equal(duplicate.result.admissionState, "accepted");
        assert.equal(duplicate.result.operationId, pending.operationId);
        assert.equal(duplicate.result.threadId, threadId);
        assert.deepEqual(
          (await project.core.call("thread/list", { limit: 100 })).data.map((row) => row.id).sort(),
          before,
        );
        Object.assign(proof, {
          recovered: recovered.result,
          duplicate: duplicate.result,
          passed: true,
        });
      } catch (error) {
        proof.error = errorDetails(error);
        failure = error;
      } finally {
        const errors = [];
        if (modeChanged)
          try {
            await chmod(records, originalMode);
            assert.equal((await lstat(records)).mode & 0o777, originalMode);
            proof.modeRestored = originalMode;
          } catch (error) {
            errors.push(error);
          }
        try {
          await barrier?.cleanup();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) {
          proof.cleanupError = errors.map(errorDetails);
          failure = new AggregateError(
            [...(failure ? [failure] : []), ...errors],
            "T22 and cleanup failed",
          );
        }
      }
      if (failure) throw failure;
    },
  );
}
