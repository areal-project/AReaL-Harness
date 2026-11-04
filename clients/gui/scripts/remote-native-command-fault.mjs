import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lldbBarrier } from "./remote-native-lldb-test-helper.mjs";

export function nativeCommandFault(fixture, projectId, native) {
  const records = join(fixture.home, "host/journals/records");
  const record = join(records, `${createHash("sha256").update(projectId).digest("hex")}.json`);
  let active;
  async function clear() {
    if (!active) return;
    const current = active;
    try {
      await current.work;
    } finally {
      try {
        await current.barrier.cleanup();
      } finally {
        if (current.modeChanged) {
          await chmod(records, current.mode);
          assert.equal((await lstat(records)).mode & 0o777, current.mode);
          current.modeChanged = false;
        }
        active = undefined;
      }
    }
  }
  return {
    clear,
    async arm(kind) {
      assert.equal(kind, "outcome-write", "Unsupported native command fault");
      assert.equal(active, undefined, "Original fault must settle before another is armed");
      const root = join(fixture.evidence.root, `command-fault-${randomUUID()}`);
      await mkdir(root, { mode: 0o700 });
      const barrier = await lldbBarrier(fixture.evidence.hostPid, {
        evidence: { ...fixture.evidence, root },
      });
      const current = { barrier, modeChanged: false };
      active = current;
      current.work = (async () => {
        const hit = await barrier.hit();
        const bytes = await readFile(record);
        const snapshot = JSON.parse(bytes).snapshot;
        assert.equal(snapshot.pending.length, 1);
        const pending = snapshot.pending[0];
        assert.equal(pending.method, "areal/thread/start");
        assert.equal(snapshot.outcomes[pending.operationId], undefined);
        const receipt = await native("areal/request/read", {
          requestId: pending.operationId,
          creationAdmission: pending.params.creationAdmission,
        });
        const original = receipt.data.filter(
          (row) =>
            row.requestId === pending.operationId &&
            row.method === pending.method &&
            row.digest === pending.nativeDigest &&
            row.identity === pending.params.creationAdmission.identity &&
            row.status === "completed",
        );
        assert.equal(original.length, 1);
        await writeFile(join(root, "before.bin"), bytes, { mode: 0o600 });
        await writeFile(
          join(root, "fault.json"),
          JSON.stringify({ kind, hit, pending, receipt: original[0] }, null, 2),
          { mode: 0o600 },
        );
        const stat = await lstat(records);
        assert.ok(stat.isDirectory());
        assert.equal(stat.uid, process.getuid());
        current.mode = stat.mode & 0o777;
        assert.equal(current.mode, 0o700);
        await chmod(records, 0o500);
        current.modeChanged = true;
        await barrier.cleanup();
        current.bytes = bytes;
        current.root = root;
      })();
      current.work.catch(() => {});
      return true;
    },
    async release() {
      assert.ok(active, "No original native fault");
      const current = active;
      try {
        await current.work;
        assert.deepEqual(await readFile(record), current.bytes);
        return { evidence: current.root, pendingUnchanged: true };
      } finally {
        await clear();
      }
    },
  };
}
