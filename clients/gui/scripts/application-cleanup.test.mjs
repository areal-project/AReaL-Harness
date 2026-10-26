import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertApplicationStopped, closeRecordedSmokeApplication } from "./application-cleanup.mjs";

test("recorded cleanup starts native quit before a blocked recorder drain", async () => {
  const child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit("exit", null, signal)); };
  const events = [];
  let releaseDrain;
  const nativeQuitStarted = new Promise(resolve => { releaseDrain = resolve; });
  await closeRecordedSmokeApplication({
    process: () => child,
    evaluate: callback => callback({ app: { quit() { events.push("native-quit"); releaseDrain(); } } }),
    close: async () => {
      events.push("recorder-drain");
      // 录像前置等待只有收到 native quit 后才释放，确定性地暴露串行关闭死锁。
      await nativeQuitStarted;
      events.push("recorder-finished");
      child.exitCode = 0;
      child.emit("exit", 0, null);
    },
  }, 250, async () => { events.push("prepare"); });
  assert.deepEqual(events, ["prepare", "native-quit", "recorder-drain", "recorder-finished"]);
  assert.equal(child.signalCode, null);
});

test("recorded cleanup preserves its deadline when native quit never completes", async () => {
  const child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  let killed = 0;
  child.kill = signal => { killed++; child.signalCode = signal; queueMicrotask(() => child.emit("exit", null, signal)); };
  await assert.rejects(closeRecordedSmokeApplication({
    process: () => child,
    evaluate: callback => callback({ app: { quit() {} } }),
    close: () => new Promise(() => {}),
  }, 250), /Electron cleanup timed out after 250ms/);
  assert.equal(killed, 1);
  assert.equal(child.signalCode, "SIGKILL");
});

test(
  "cleanup inventory uses the native launcher without blocking the fixture server",
  { skip: process.platform === "win32", timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "areal-cleanup-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      response.end(JSON.stringify([{ state: "stopped", hostPid: null, corePid: null }]));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const binary = join(root, "inventory");
    await writeFile(
      binary,
      `#!/usr/bin/python3
import os,sys,urllib.request
assert sys.argv[1:]==['service','list','--json']
with urllib.request.urlopen(os.environ['AREAL_CLEANUP_TEST_URL'],timeout=2) as response:
    print(response.read().decode())
`,
    );
    await chmod(binary, 0o700);
    await assertApplicationStopped(
      binary,
      {
        ...process.env,
        AREAL_CLEANUP_TEST_URL: `http://127.0.0.1:${server.address().port}/inventory`,
        NO_PROXY: [process.env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(","),
        no_proxy: [process.env.no_proxy, "127.0.0.1"].filter(Boolean).join(","),
      },
      null,
    );
    assert.equal(calls, 1);
  },
);
