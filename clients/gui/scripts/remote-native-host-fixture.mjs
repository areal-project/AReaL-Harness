import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
  lstat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { HostClient } = require("../app/src/core/host-client.cjs");
const { GuiHostProjects } = require("../app/src/core/gui-host-projects.cjs");
const { HostRemote } = require("../app/src/core/host-remote.cjs");
const { NativeRemote } = require("../app/src/core/native-remote.cjs");
const { readHostReceipt, readOfflineHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function until(read, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timeout: ${label}`);
}

// 只提供真实 Host 的本地配置生产者；Remote 请求仍由原客户端进入 Rust owner。
export async function nativeHostFixture(t, { config } = {}) {
  assert.ok(
    process.platform !== "darwin" || process.env.AREAL_TEST_HOST_KEYCHAIN === "1",
    "Requires isolated synthetic Host vault authorization",
  );
  assert.ok(
    process.env.AREAL_CORE_BIN,
    "AREAL_CORE_BIN must identify the locked verification slot",
  );
  const binary = resolve(process.env.AREAL_CORE_BIN);
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-remote-host-")));
  const home = join(root, "registry");
  await mkdir(home, { mode: 0o700 });
  const host = new HostClient();
  const source = new GuiHostProjects({
    binary,
    home,
    singletonHeld: true,
    source: {
      profile: join(root, "profile"),
      coreHome: join(root, "core"),
      legacyServiceHome: join(root, "legacy"),
    },
    encryption: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "synthetic-source-fixture",
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString("utf8"),
    },
  });
  const backend = {
    host: source,
    home: source.source.coreHome,
    save: (name, value) =>
      writeFile(join(source.source.coreHome, name), JSON.stringify(value), { mode: 0o600 }),
  };
  const instances = [];
  const evidence = { root, binary, binarySha256: digest(await readFile(binary)), cleanup: [] };
  const log = await open(join(root, "host.log"), "a", 0o600);
  const child = spawn(binary, ["host", "run"], {
    env: {
      ...process.env,
      ...(process.env.RC12_TLS_HOME
        ? { SSL_CERT_FILE: join(process.env.RC12_TLS_HOME, "ca.pem") }
        : {}),
      AREAL_HARNESS_HOME: home,
      AREAL_HARNESS_SERVICE_HOME: home,
    },
    stdio: ["ignore", "ignore", log.fd],
  });
  await log.close();
  let identity;
  t.after(async () => {
    try {
      await Promise.all(instances.map((remote) => remote.close()));
      source.close();
      if (identity) {
        const reference = {
          kind: "stopHost",
          requestId: randomUUID(),
          home,
          hostId: identity.hostId,
          generation: identity.generation,
          strategy: "cancel",
        };
        const observation = { reference };
        evidence.cleanup.push(observation);
        let receipt;
        try {
          receipt = readHostReceipt(
            reference,
            await host.stop(reference.requestId, reference.generation, reference.strategy),
          );
        } catch (error) {
          observation.error = { code: error.code, message: error.message };
          host.close();
          receipt = await readOfflineHostReceipt(binary, reference);
        }
        observation.receipt = receipt ?? null;
        assert.ok(receipt, `UNKNOWN original fixture stop ${reference.requestId}; no replay`);
        assert.equal(receipt.state, "completed");
      }
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "owned Host natural exit",
      );
      assert.equal(child.exitCode, 0);
      const service = `org.areal.host.v1.${digest(home)}`;
      for (const directory of ["vault-operations", "remote-operations"]) {
        for (const name of await readdir(join(home, "host", directory)).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        })) {
          const receipt = JSON.parse(await readFile(join(home, "host", directory, name), "utf8"));
          assert.equal(name, `${receipt.requestId}.json`);
          if (!["vault.replace", "remote.replace"].includes(receipt.method) || !receipt.entryId)
            continue;
          if (process.platform === "darwin") {
            const removal = spawnSync(
              "/usr/bin/security",
              ["delete-generic-password", "-s", service, "-a", receipt.entryId],
              { encoding: "utf8" },
            );
            const absent = spawnSync(
              "/usr/bin/security",
              ["find-generic-password", "-s", service, "-a", receipt.entryId],
              { encoding: "utf8" },
            );
            assert.equal(absent.status, 44);
            evidence.cleanup.push({
              entryId: receipt.entryId,
              removal: removal.status,
              absent: true,
            });
          } else {
            const path = join(home, "host/vault", `${receipt.entryId}.json`);
            const stat = await lstat(path);
            assert.ok(stat.isFile() && stat.uid === process.getuid());
            assert.equal(stat.mode & 0o777, 0o600);
            await unlink(path);
            await assert.rejects(lstat(path), { code: "ENOENT" });
            evidence.cleanup.push({
              entryId: receipt.entryId,
              storage: "native file vault",
              absent: true,
            });
          }
        }
      }
      assert.equal(
        digest(await readFile(binary)),
        evidence.binarySha256,
        "fixed binary remained unchanged",
      );
    } finally {
      host.close();
      await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
      t.diagnostic(`native Host evidence: ${join(root, "evidence.json")}`);
    }
  });
  await until(async () => {
    assert.equal(child.exitCode, null, "owned Host must remain alive");
    try {
      await host.connect(home);
      return true;
    } catch {
      host.close();
      return false;
    }
  }, "owned Host authenticated startup");
  identity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
  evidence.host = identity;
  await source.init();
  if (config) {
    const storage = new HostRemote(backend, () => {});
    try {
      await storage.init();
      await storage.replace(config);
      await storage.drained();
    } finally {
      storage.close();
    }
  }
  const make = async () => {
    const remote = new NativeRemote({ backend, schedule() {} });
    instances.push(remote);
    await remote.init();
    return remote;
  };
  return {
    remote: await make(),
    make,
    home,
    source,
    client: host,
    evidence,
    persisted: async () => (await host.request("remote.read", {})).config,
  };
}
