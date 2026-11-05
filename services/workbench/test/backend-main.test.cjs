const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { mkdtemp, mkdir, readFile, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

async function fixture(t, retired) {
  const root = await mkdtemp(join(tmpdir(), "workbench-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "app"), home = join(root, "data");
  await mkdir(join(appRoot, "node_modules/@areal/workbench-service/src/desktop/core"), { recursive: true });
  await mkdir(home);
  await writeFile(join(appRoot, "package.json"), "{}");
  await writeFile(join(appRoot, "node_modules/@areal/workbench-service/package.json"), JSON.stringify({exports:{"./desktop/*":"./src/desktop/*"}}));
  // 夹具只替代业务装配，进程、Host 管道和元数据生命周期使用实际入口。
  await writeFile(join(appRoot, "node_modules/@areal/workbench-service/src/desktop/core/service-main.cjs"), `
    const fs = require('node:fs/promises');
    exports.createMainDesktop = async (options, lifetime) => {
      if (lifetime.hostManaged !== true) throw Error("Host ownership must precede backend initialization");
      if (options.sourceSingletonHeld !== false || options.applicationOwner) throw Error('wrong owner');
      return { backend: { cloud: {}, useHostLibrary: async () => {} }, adapter: { listen: async () => ({
        pid: process.pid, identity: 'fixture', desktopGeneration: 'generation', token: 'private-token'
      }) }, close: () => fs.writeFile(options.home + '/closed', 'closed') };
    };
  `);
  const child = spawn(process.execPath, [join(__dirname, "../src/backend-main.cjs")], {
    env: { PATH: process.env.PATH, HOME: root }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  return { home, child, lines, exited, start: () => child.stdin.write(JSON.stringify({
    version: 1, method: "backend.start", params: { appRoot, options: { home }, retired },
  }) + "\n") };
}

test("后台发布身份但不泄露票据，Host EOF 等待关闭并清理本代元数据", async (t) => {
  const f = await fixture(t);
  const ready = once(f.lines, "line");
  f.start();
  const [line] = await ready;
  const frame = JSON.parse(line);
  assert.equal(frame.service.pid, f.child.pid);
  assert.equal(frame.event, "ready");
  assert.ok(!line.includes("private-token"));
  assert.equal(JSON.parse(await readFile(join(f.home, "service.json"))).pid, f.child.pid);
  f.child.stdin.end();
  assert.deepEqual(await f.exited, [0, null]);
  assert.equal(await readFile(join(f.home, "closed"), "utf8"), "closed");
  await assert.rejects(readFile(join(f.home, "service.json")), { code: "ENOENT" });
});

test("后台拒绝覆盖未由 Host 确认退役的服务", async (t) => {
  const f = await fixture(t);
  const existing = JSON.stringify({ pid: 19, identity: "old", desktopGeneration: "old-generation" });
  await writeFile(join(f.home, "service.json"), existing);
  f.start();
  assert.deepEqual(await f.exited, [1, null]);
  assert.equal(await readFile(join(f.home, "service.json"), "utf8"), existing);
});

test("只清理 Host 确认已退出的同一后台代际", async (t) => {
  const retired = { pid: 19, identity: "old", desktopGeneration: "old-generation" };
  const f = await fixture(t, retired);
  await writeFile(join(f.home, "service.json"), JSON.stringify(retired));
  const ready = once(f.lines, "line");
  f.start();
  await ready;
  f.child.stdin.end();
  assert.deepEqual(await f.exited, [0, null]);
});
