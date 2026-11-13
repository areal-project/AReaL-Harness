const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const { RelayDeployment } = require("@areal/workbench-service/desktop/core/relay-deployment.cjs");
const valid = {
  target: "root@relay.example",
  port: 22,
  address: "https://relay.example",
  ownerId: "a".repeat(32),
  room: "b".repeat(64),
};

test("SSH boundary refuses command injection and requires explicit removal data policy", async () => {
  const relay = new RelayDeployment({ home: "/tmp", bundleDir: "/missing" });
  for (const target of ["-oProxyCommand=sh", "root@a;id", "root@a\nsh", "root@a$(id)", "root@a..b"])
    await assert.rejects(relay.deploy({ ...valid, target }), /INVALID_SSH_TARGET/);
  await assert.rejects(relay.deploy({ ...valid, port: 0 }), /INVALID_SSH_PORT/);
  await assert.rejects(
    relay.deploy({ ...valid, address: "http://relay.example" }),
    /INVALID_RELAY_ADDRESS/,
  );
  assert.throws(() => relay.remove(valid), /REMOVE_DATA_REQUIRED/);
});

test("transport disconnect is UNKNOWN, never replayed, and a later inspect reconciles", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-deployment-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "deploy"));
  const installer = join(__dirname, "../../../services/remote-relay/deploy/managed-install.sh");
  await writeFile(join(dir, "deploy/managed-install.sh"), await readFile(installer));
  const log = join(dir, "calls");
  const ssh = join(dir, "ssh");
  await writeFile(
    ssh,
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(255));\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => (process.env.PATH = before));
  const relay = new RelayDeployment({ home: dir, bundleDir: dir });
  await assert.rejects(relay.deploy(valid), { code: "SSH_MUTATION_UNKNOWN" });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.length, 1);
  const argv = JSON.parse(calls[0]);
  assert.ok(argv.includes("BatchMode=yes"));
  assert.ok(argv.includes("StrictHostKeyChecking=yes"));
  assert.equal(argv.at(-2), "root@relay.example");
  await writeFile(
    ssh,
    `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ownerId:'${valid.ownerId}',installed:true,active:false,version:'${"c".repeat(64)}'})));\n`,
    { mode: 0o755 },
  );
  assert.deepEqual(await relay.inspect(valid), {
    ownerId: valid.ownerId,
    installed: true,
    active: false,
    version: "c".repeat(64),
  });
  await writeFile(
    ssh,
    `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({ownerId:'${valid.ownerId}',installed:true,active:true,absent:true,dataRetained:false})));\n`,
    { mode: 0o755 },
  );
  await assert.rejects(relay.inspect(valid), { code: "SSH_INSPECT_FAILED" });
  await writeFile(
    ssh,
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(dir, "started"))},'yes');process.stdin.resume();setInterval(()=>{},1000);\n`,
    { mode: 0o755 },
  );
  const mutation = relay.upgrade(valid);
  const rejected = assert.rejects(mutation, { code: "SSH_MUTATION_UNKNOWN" });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await readFile(join(dir, "started"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await relay.close();
  await rejected;
  assert.equal(relay.children.size, 0);
  await assert.rejects(relay.inspect(valid), /RELAY_DEPLOYMENT_CLOSED/);
});

test("managed installer is valid bash", () => {
  execFileSync("bash", [
    "-n",
    join(__dirname, "../../../services/remote-relay/deploy/managed-install.sh"),
  ]);
});
