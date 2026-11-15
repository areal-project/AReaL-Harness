"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const { readFile, writeFile, mkdir, access } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { trackedMkdtemp } = require("./support/host-cleanup.cjs");
const { HostClient } = require("../packages/client/node/host-client.cjs");
const { ensureDesktopHost } = require("../packages/client/node/desktop-upgrade.cjs");
const binary = resolve(process.env.AREAL_CORE_BIN || "../../target/debug/areal");

async function waitFor(read, message) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await read()) return;
    await delay(50);
  }
  throw new Error(message);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function fixture(t) {
  const home = await trackedMkdtemp("/private/tmp/areal-upgrade-");
  await mkdir(join(home, "user"), { mode: 0o700 });
  const old = new HostClient();
  await old.connectOrStart(home, process.env.AREAL_UPGRADE_OLD_BIN || binary);
  const original = { ...old.identity, generation: old.generation };
  old.close();
  const client = new HostClient();
  t.after(async () => {
    client.close();
    const cleanup = new HostClient();
    try {
      await cleanup.connect(home);
      const pid = cleanup.identity.pid;
      const requestId = randomUUID();
      await cleanup.stop(requestId, cleanup.generation, "ifIdle").catch(() => {});
      cleanup.close();
      await waitFor(() => !alive(pid), "fixture Host did not exit");
    } finally {
      cleanup.close();
    }
  });
  const options = {
    home,
    binary,
    serviceIdentity: "fixture-service",
    buildIdentity: "fixture-build",
  };
  // 旧版缺少构建指纹；同一版本的工作台变更也必须触发整套切换。
  await writeFile(
    join(home, "host/desktop-build.json"),
    JSON.stringify({
      generation: original.generation,
      identity: "previous-build",
    }),
    { mode: 0o600 },
  );
  return { home, original, client, options };
}

test("a changed desktop build replaces the actual Host and matching reconnect reuses it", async (t) => {
  const f = await fixture(t);
  const complete = await ensureDesktopHost(f.client, f.options);
  assert.notEqual(f.client.generation, f.original.generation);
  assert.equal(alive(f.original.pid), false);
  const record = JSON.parse(await readFile(join(f.home, "host/desktop-upgrade.json")));
  assert.equal(record.phase, "checking");
  const receipt = await f.client.operation(record.requestId);
  assert.equal(receipt.operation.state, "completed");
  assert.equal(receipt.operation.strategy, "cancel");
  await complete();
  await assert.rejects(access(join(f.home, "host/desktop-upgrade.json")), { code: "ENOENT" });
  const generation = f.client.generation;
  f.client.close();
  await (
    await ensureDesktopHost(f.client, f.options)
  )();
  assert.equal(f.client.generation, generation);
});

test("closing after stop resumes the original receipt without a second stop", async (t) => {
  const f = await fixture(t);
  let closed = false;
  const stop = f.client.stop.bind(f.client);
  f.client.stop = async (...args) => {
    const receipt = await stop(...args);
    closed = true;
    return receipt;
  };
  await assert.rejects(ensureDesktopHost(f.client, { ...f.options, closed: () => closed }), /交接/);
  const before = JSON.parse(await readFile(join(f.home, "host/desktop-upgrade.json")));
  f.client.close();
  f.client.stop = async () => {
    throw new Error("must not dispatch a second stop");
  };
  await (
    await ensureDesktopHost(f.client, f.options)
  )();
  assert.equal(alive(f.original.pid), false);
  assert.equal((await f.client.operation(before.requestId)).operation.state, "completed");
});

test("a lost stop response is recovered through the original receipt", async (t) => {
  const f = await fixture(t);
  const stop = f.client.stop.bind(f.client);
  let stops = 0;
  f.client.stop = async (...args) => {
    stops++;
    await stop(...args);
    f.client.close();
    throw new Error("fixture lost response");
  };
  await (
    await ensureDesktopHost(f.client, f.options)
  )();
  assert.equal(stops, 1);
  assert.equal(alive(f.original.pid), false);
});

test("an unfinished health check resumes the replacement instead of replacing it again", async (t) => {
  const f = await fixture(t);
  await ensureDesktopHost(f.client, f.options);
  const generation = f.client.generation;
  f.client.close();
  await (
    await ensureDesktopHost(f.client, f.options)
  )();
  assert.equal(f.client.generation, generation);
});
