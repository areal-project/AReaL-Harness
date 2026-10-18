import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = join(gui, "app/src/core/core-process.cjs");
const require = createRequire(import.meta.url);
const { executeCore } = require(modulePath);
const scratch = await mkdtemp("/private/tmp/areal-core-process-");
const fixture = join(scratch, "fixture.py");
await writeFile(
  fixture,
  `import os,sys,signal,time
from pathlib import Path
mode,pidfile=sys.argv[1:]
Path(pidfile).write_text(str(os.getpid()))
if mode=='success': print(os.getcwd()+':'+os.environ['AREAL_PROCESS_FIXTURE']+':'+sys.stdin.read()); print('fixture stderr',file=sys.stderr)
elif mode=='failure': print('fixture rejected',file=sys.stderr); sys.exit(7)
elif mode=='signal': os.kill(os.getpid(),signal.SIGTERM)
elif mode=='flood':
    while True: os.write(1,b'x'*4096)
else:
    if mode=='ignore': signal.signal(signal.SIGTERM,signal.SIG_IGN)
    while True: time.sleep(1)
`,
);
const checks = [];
let index = 0;
async function waitFor(read, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout: ${label}`);
}
async function pidOf(path) {
  return waitFor(
    async () => Number(await readFile(path, "utf8").catch(() => "")),
    "fixture child PID",
  );
}
async function gone(pid) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      return true;
    }
  }, "child reaped");
}
async function invoke(mode, options = {}, cancel) {
  const pidfile = join(scratch, `${index++}.pid`);
  const promise = executeCore("/usr/bin/python3", [fixture, mode, pidfile], {
    cwd: scratch,
    env: { ...process.env, AREAL_PROCESS_FIXTURE: "kept" },
    ...options,
  });
  // 尽早观察拒绝，取消/超时发生在 PID 文件回取期间也不形成未处理拒绝。
  const outcome = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const pid = await pidOf(pidfile);
  if (cancel) await cancel(promise);
  const result = await outcome;
  await gone(pid);
  return result;
}
const success = await invoke("success", { input: "stdin preserved" });
assert.equal(success.value.stdout, `${scratch}:kept:stdin preserved\n`);
assert.equal(success.value.stderr, "fixture stderr\n");
checks.push("argv, cwd, environment, stdin/stdout/stderr preserved");
const failed = await invoke("failure");
assert.equal(failed.error.code, 7);
assert.equal(failed.error.signal, null);
checks.push("nonzero Core exit and stderr preserved");
const signaled = await invoke("signal");
assert.equal(signaled.error.signal, "SIGTERM");
assert.equal(signaled.error.killed, false);
checks.push("native signal exit remains a signal");
const timeout = await invoke("wait", { timeout: 400 });
assert.equal(timeout.error.timedOut, true);
assert.equal(timeout.error.signal, "SIGTERM");
checks.push("timeout terminates and reaps the actual child");
const forced = await invoke("ignore", { timeout: 400 });
assert.equal(forced.error.timedOut, true);
assert.equal(forced.error.signal, "SIGKILL");
checks.push("ignored TERM escalates and reaps the child");
const controller = new AbortController();
const aborted = await invoke("wait", { signal: controller.signal }, () => controller.abort());
assert.equal(aborted.error.code, "ABORT_ERR");
checks.push("AbortSignal cancels and reaps the actual child");
const killed = await invoke("wait", {}, (promise) => promise.child.kill("SIGKILL"));
assert.equal(killed.error.signal, "SIGKILL");
checks.push("explicit kill targets Core without orphaning it");
const overflow = await invoke("flood", { maxBuffer: 8192 });
assert.equal(overflow.error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
assert.ok(Buffer.byteLength(overflow.error.stdout) <= 8192);
checks.push("bounded output fails and cleans up Core");
if (process.platform === "darwin") {
  const handshake = executeCore(
    "/usr/bin/python3",
    [fixture, "wait", join(scratch, "handshake.pid")],
    { timeout: 100 },
  );
  const started = Date.now();
  process.kill(handshake.child.pid, "SIGSTOP");
  const early = await handshake.then(
    () => assert.fail("stopped bridge must not succeed"),
    (error) => error,
  );
  assert.equal(early.timedOut, true);
  assert.ok(Date.now() - started < 3000, "timeout is bounded before the PID handshake");
  const earlyPid = Number(await readFile(join(scratch, "handshake.pid"), "utf8").catch(() => ""));
  if (earlyPid) await gone(earlyPid);
  await gone(handshake.child.pid);
  checks.push("pre-handshake timeout terminates a stopped bridge and any spawned Core");
  const pidfile = join(scratch, "parent-death.pid");
  const source = `const {executeCore}=require(process.argv[1]);executeCore('/usr/bin/python3',process.argv.slice(2)).catch(()=>{});setTimeout(()=>process.exit(0),400);`;
  const owner = spawn(process.execPath, ["-e", source, modulePath, fixture, "ignore", pidfile], {
    stdio: "ignore",
  });
  const closed = new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.once("exit", resolve);
  });
  const pid = await pidOf(pidfile);
  await closed;
  await gone(pid);
  checks.push("adapter death leaves no running or zombie child");
  const bridgeDeath = await invoke("wait", {}, (promise) =>
    process.kill(promise.child.pid, "SIGKILL"),
  );
  assert.equal(bridgeDeath.error.signal, "SIGKILL");
  checks.push("unexpected bridge death terminates its Core child");
}
const report = { passed: true, scratch, node: process.execPath, version: process.version, checks };
await writeFile(join(scratch, "manifest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
