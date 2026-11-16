"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const { readFile, writeFile, mkdir, access } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { trackedMkdtemp } = require("./support/host-cleanup.cjs");
const { HostClient } = require("../packages/client/node/host-client.cjs");
const {
  ensureDesktopHost,
  desktopBuildIdentity,
} = require("../packages/client/node/desktop-upgrade.cjs");
const binary = resolve(process.env.AREAL_CORE_BIN || "../../target/debug/areal");

test("packaged build identity uses its sealed manifest without reading source trees", async () => {
  const home = await trackedMkdtemp(join(tmpdir(), "areal-build-identity-"));
  const manifest = join(home, "desktop-build.json");
  await writeFile(manifest, JSON.stringify({ version: 1, identity: "a".repeat(64) }));
  const first = await desktopBuildIdentity("service-a", [join(home, "absent")], manifest);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, await desktopBuildIdentity("service-b", [], manifest));
  await writeFile(manifest, JSON.stringify({ version: 1, identity: "b".repeat(64) }));
  assert.notEqual(first, await desktopBuildIdentity("service-a", [], manifest));
  await writeFile(manifest, JSON.stringify({ version: 1, identity: "invalid" }));
  await assert.rejects(desktopBuildIdentity("service-a", [], manifest), /构建清单/);
});

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

for (const changed of ["build identity", "Core digest"]) {
  test(`reinstalling with a changed ${changed} settles the interrupted handoff`, async (t) => {
    const f = await fixture(t);
    let closed = false;
    const stop = f.client.stop.bind(f.client);
    f.client.stop = async (...args) => {
      const receipt = await stop(...args);
      closed = true;
      return receipt;
    };
    await assert.rejects(
      ensureDesktopHost(f.client, { ...f.options, closed: () => closed }),
      /交接/,
    );
    f.client.close();
    const path = join(f.home, "host/desktop-upgrade.json");
    const original = JSON.parse(await readFile(path));
    const options = { ...f.options };
    if (changed === "build identity") options.buildIdentity = "reinstalled-build";
    else
      await writeFile(path, JSON.stringify({ ...original, targetDigest: "0".repeat(64) }), {
        mode: 0o600,
      });
    f.client.stop = async () => {
      throw new Error("must not dispatch a second stop");
    };
    await (
      await ensureDesktopHost(f.client, options)
    )();
    assert.equal(alive(f.original.pid), false);
    assert.equal((await f.client.operation(original.requestId)).operation.state, "completed");
    assert.equal(
      JSON.parse(await readFile(join(f.home, "host/desktop-build.json"))).identity,
      options.buildIdentity,
    );
    await assert.rejects(access(path), { code: "ENOENT" });
  });
}

test("a changed install preserves an unconfirmed original handoff", async (t) => {
  const f = await fixture(t);
  await ensureDesktopHost(f.client, f.options);
  const successor = { generation: f.client.generation, pid: f.client.identity.pid };
  f.client.close();
  const path = join(f.home, "host/desktop-upgrade.json");
  const record = JSON.parse(await readFile(path));
  record.requestId = randomUUID();
  const before = JSON.stringify(record);
  await writeFile(path, before, { mode: 0o600 });
  f.client.stop = async () => {
    throw new Error("must not replace an unconfirmed handoff");
  };
  await assert.rejects(
    ensureDesktopHost(f.client, { ...f.options, buildIdentity: "reinstalled-build" }),
    /应用交接结果尚未确认/,
  );
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(alive(successor.pid), true);
  assert.equal(f.client.generation, successor.generation);
});

test("a changed install replaces an already published successor using a new stop request", async (t) => {
  const f = await fixture(t);
  await ensureDesktopHost(f.client, f.options);
  const path = join(f.home, "host/desktop-upgrade.json");
  const original = JSON.parse(await readFile(path));
  const successor = { generation: f.client.generation, pid: f.client.identity.pid };
  await writeFile(
    join(f.home, "host/desktop-build.json"),
    JSON.stringify({ generation: successor.generation, identity: f.options.buildIdentity }),
    { mode: 0o600 },
  );
  f.client.close();
  const stops = [];
  const stop = f.client.stop.bind(f.client);
  f.client.stop = async (...args) => {
    stops.push(args);
    return stop(...args);
  };
  const options = { ...f.options, buildIdentity: "reinstalled-build" };
  await (
    await ensureDesktopHost(f.client, options)
  )();
  assert.equal(stops.length, 1);
  assert.notEqual(stops[0][0], original.requestId);
  assert.equal(stops[0][1], successor.generation);
  assert.equal((await f.client.operation(original.requestId)).operation.state, "completed");
  assert.equal(alive(successor.pid), false);
  assert.notEqual(f.client.generation, successor.generation);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("an intervening Host build is checked independently of the settled original handoff", async (t) => {
  const f = await fixture(t);
  await ensureDesktopHost(f.client, f.options);
  const path = join(f.home, "host/desktop-upgrade.json");
  const original = JSON.parse(await readFile(path));
  const successor = { generation: f.client.generation, pid: f.client.identity.pid };
  f.client.close();
  const connectOrStart = f.client.connectOrStart.bind(f.client);
  let injected = false;
  f.client.connectOrStart = async (...args) => {
    await connectOrStart(...args);
    if (f.client.generation === successor.generation && !injected) {
      // 在真实后继 Host 的握手边界注入不同构建摘要；后续停止与代际切换仍由真实进程完成。
      f.client.hello.executableDigest = "0".repeat(64);
      injected = true;
    }
  };
  const stops = [];
  const stop = f.client.stop.bind(f.client);
  f.client.stop = async (...args) => {
    stops.push(args);
    return stop(...args);
  };
  await (
    await ensureDesktopHost(f.client, f.options)
  )();
  assert.equal(injected, true);
  assert.equal(stops.length, 1);
  assert.notEqual(stops[0][0], original.requestId);
  assert.equal(stops[0][1], successor.generation);
  assert.equal(alive(successor.pid), false);
  assert.notEqual(f.client.generation, successor.generation);
  assert.equal((await f.client.operation(original.requestId)).operation.state, "completed");
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("a malformed target digest is still rejected without retiring the handoff", async (t) => {
  const f = await fixture(t);
  await ensureDesktopHost(f.client, f.options);
  f.client.close();
  const path = join(f.home, "host/desktop-upgrade.json");
  const record = JSON.parse(await readFile(path));
  const before = JSON.stringify({ ...record, targetDigest: 42 });
  await writeFile(path, before, { mode: 0o600 });
  await assert.rejects(ensureDesktopHost(f.client, f.options), /应用交接记录无效/);
  assert.equal(await readFile(path, "utf8"), before);
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

for (const denied of [false, true]) {
  test(`handoff recovery ignores a reused PID${denied ? " even when probing it would deny permission" : ""}`, async (t) => {
    const f = await fixture(t);
    await ensureDesktopHost(f.client, f.options);
    const generation = f.client.generation;
    f.client.close();
    const path = join(f.home, "host/desktop-upgrade.json");
    const record = JSON.parse(await readFile(path));
    // 原 Host 已退出；历史 PID 现在指向另一个仍存活的进程。
    record.pid = process.pid;
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    const kill = process.kill;
    t.after(() => {
      process.kill = kill;
    });
    if (denied)
      process.kill = (pid, signal) => {
        if (pid === record.pid && signal === 0)
          throw Object.assign(new Error("fixture probe denied"), { code: "EPERM" });
        return kill(pid, signal);
      };
    await (
      await ensureDesktopHost(f.client, f.options)
    )();
    assert.equal(f.client.generation, generation);
    await assert.rejects(access(path), { code: "ENOENT" });
  });
}
