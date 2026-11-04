import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceDirectory = join(repository, ".scratch/shared-host");
await fs.mkdir(evidenceDirectory, { recursive: true });
const root = await fs.realpath(await fs.mkdtemp("/tmp/ah-retirement-"));
const require = createRequire(import.meta.url);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, value) => fs.writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
const checks = [];
let afterTemporarySync;
const originalOpen = fs.open;
fs.open = async (...args) => {
  const file = await originalOpen(...args);
  if (String(args[0]).includes(".host-retirement-")) {
    const sync = file.sync.bind(file);
    file.sync = async () => {
      await sync();
      const action = afterTemporarySync;
      afterTemporarySync = undefined;
      if (action) await action();
    };
  }
  return file;
};
const { GuiSourceAdapter, prepareGuiSource } = require("../app/src/core/gui-source.cjs");
const { HostClient } = createRequire(new URL("../app/package.json", import.meta.url))(
  "@areal/client/node",
);
fs.open = originalOpen;

async function fixture(name, { large = false, provider = false } = {}) {
  const directory = join(root, name);
  await fs.mkdir(directory, { mode: 0o700 });
  const hostHome = join(directory, "home");
  const source = Object.fromEntries(
    ["profile", "coreHome", "legacyServiceHome"].map((key) => [key, join(directory, key)]),
  );
  for (const path of [hostHome, ...Object.values(source)]) await fs.mkdir(path, { mode: 0o700 });
  const migrationId = randomUUID(),
    planId = randomUUID(),
    backupId = randomUUID();
  const imported = join(hostHome, "host/imports", migrationId);
  const backups = join(imported, "backups"),
    derivatives = join(imported, "retirement", planId);
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  await fs.mkdir(derivatives, { recursive: true, mode: 0o700 });
  const relativeName = provider ? "provider-credentials.json" : "subscription-transport.json";
  const original = Buffer.from(
    provider
      ? '{ "keys":{"AREAL_CREDENTIAL_dummy":"synthetic-ciphertext"}, "migrated":[], "extension":true }\n'
      : `{ "port":43821, "token":"synthetic-token", "extension":${JSON.stringify(large ? "x".repeat(2 * 1024 * 1024) : { preserved: true })} }\n`,
  );
  const sanitized = Buffer.from(
    provider
      ? '{ "keys":{}, "migrated":[], "extension":true }\n'
      : original.toString().replace('"token":"synthetic-token", ', ""),
  );
  const sourcePath = join(source.coreHome, relativeName),
    backupPath = join(backups, backupId + ".bytes");
  const derivativePath = join(derivatives, backupId + ".bytes");
  const providerFence = Buffer.from("AREAL_HOST_MIGRATED\nsynthetic permanent fence\n");
  await fs.writeFile(sourcePath, provider ? providerFence : original, { mode: 0o600 });
  await fs.writeFile(backupPath, original, { mode: 0o600 });
  await fs.writeFile(derivativePath, sanitized, { mode: 0o600 });
  const target = {
    relativeName,
    backupId,
    beforeDigest: sha(original),
    afterDigest: sha(sanitized),
    byteLength: sanitized.length,
  };
  const targets = [
    ...(provider ? [] : [{ ...target, site: "source" }]),
    { ...target, site: "backup" },
  ];
  const paths = { source: sourcePath, backup: backupPath };
  const generation = randomUUID(),
    hostId = randomUUID(),
    socketPath = join(root, randomUUID() + ".sock");
  const state = {
    requestId: undefined,
    completed: false,
    applied: new Set(),
    calls: [],
    drop: undefined,
    locked: false,
    nextOverride: undefined,
    importKind: "ready",
    prepareHook: undefined,
  };
  const progress = (next = null) => ({
    requestId: state.requestId,
    migrationId,
    planId,
    state: state.completed ? "completed" : "applying",
    next,
  });
  const reconcile = async () => {
    for (const entry of targets)
      if (sha(await fs.readFile(paths[entry.site])) === entry.afterDigest)
        state.applied.add(entry.site);
    state.completed = state.applied.size === targets.length;
  };
  const serverErrors = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = "";
    async function respond(request) {
      const { method, params } = request;
      state.calls.push({ method, params });
      let result;
      if (method === "hello") {
        assert.equal(params.authToken, "synthetic-auth");
        result = { version: 1, generation, hostId, capabilities: ["guiImport"] };
      } else if (method === "gui.attachSource") {
        assert.deepEqual(params.source, source);
        result = { attached: true };
      } else if (method === "gui.import") {
        assert.equal(params.expectedGeneration, generation);
        result = {
          kind: state.importKind,
          phase: state.importKind === "ready" ? "committed" : "discovered",
          migrationId,
          pendingSecrets: [],
        };
      } else if (method === "gui.retirementStatus") {
        assert.deepEqual(params, { migrationId });
        result = state.requestId ? progress() : null;
      } else if (method === "host.operation") {
        result = {
          operation:
            params.requestId === state.requestId
              ? {
                  method: "gui.retirementPrepare",
                  state: state.completed ? "completed" : "acceptedPending",
                  result: progress(),
                }
              : null,
        };
      } else if (method === "gui.retirementPrepare" || method === "gui.retirementConfirm") {
        assert.equal(params.expectedGeneration, generation);
        assert.equal(params.migrationId, migrationId);
        if (state.requestId) assert.equal(params.requestId, state.requestId);
        else state.requestId = params.requestId;
        if (method === "gui.retirementPrepare" && state.locked) {
          socket.write(
            JSON.stringify({
              version: 1,
              id: request.id,
              error: { code: "storageLocked", message: "synthetic vault locked" },
            }) + "\n",
          );
          return;
        }
        if (method === "gui.retirementConfirm") assert.equal(params.planId, planId);
        if (state.drop === method) {
          state.drop = undefined;
          socket.destroy();
          return;
        }
        await reconcile();
        if (method === "gui.retirementPrepare" && state.prepareHook) await state.prepareHook();
        const next =
          method === "gui.retirementPrepare" && !state.completed
            ? (state.nextOverride ?? targets.find((entry) => !state.applied.has(entry.site)))
            : null;
        result = progress(next);
      } else throw Error("Unexpected fake Host method " + method);
      const wire = JSON.stringify({ version: 1, id: request.id, result }) + "\n";
      assert(wire.length < 1024 * 1024, "control response stays below 1 MiB for large source");
      socket.write(wire.slice(0, 7));
      socket.write(wire.slice(7));
    }
    socket.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        void respond(request).catch((error) => {
          serverErrors.push(error);
          socket.destroy();
        });
      }
    });
  });
  await new Promise((done) => server.listen(socketPath, done));
  await fs.chmod(socketPath, 0o600);
  await save(join(hostHome, "host/auth.json"), "synthetic-auth");
  await save(join(hostHome, "host/host.json"), {
    version: 1,
    generation,
    hostId,
    socketPath,
    authFile: join(hostHome, "host/auth.json"),
  });
  const adapter = new GuiSourceAdapter({
    source,
    hostHome,
    singletonHeld: true,
    encryption: {
      decryptString() {
        throw Error("retirement must not decrypt");
      },
      isEncryptionAvailable() {
        throw Error("retirement must not access secure storage");
      },
    },
  });
  return {
    adapter,
    state,
    migrationId,
    source,
    hostHome,
    sourcePath,
    backupPath,
    derivativePath,
    original,
    sanitized,
    providerFence,
    directory,
    async status(requestId) {
      const client = new HostClient();
      try {
        await client.connect(hostHome);
        return {
          status: await client.retirementStatus(migrationId),
          operation: (await client.operation(requestId)).operation,
        };
      } finally {
        client.close();
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
      assert.deepEqual(serverErrors, []);
      afterTemporarySync = undefined;
    },
  };
}

async function scenario(name, run, options) {
  const test = await fixture(name, options);
  try {
    await run(test);
    checks.push(name);
  } finally {
    await test.close();
  }
}

try {
  await scenario(
    "large-source-and-backup",
    async (test) => {
      const result = await test.adapter.retire(test.migrationId, randomUUID());
      assert.equal(result.state, "completed");
      for (const path of [test.sourcePath, test.backupPath]) {
        assert.deepEqual(await fs.readFile(path), test.sanitized);
        assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
      }
      assert.equal(
        test.state.calls.filter((call) => call.method === "gui.retirementPrepare").length,
        2,
      );
      assert.equal((await test.adapter.retire(test.migrationId)).state, "completed");
    },
    { large: true },
  );
  await scenario(
    "provider-source-fence",
    async (test) => {
      await test.adapter.retire(test.migrationId);
      assert.deepEqual(await fs.readFile(test.sourcePath), test.providerFence);
      assert.deepEqual(await fs.readFile(test.backupPath), test.sanitized);
    },
    { provider: true },
  );
  await scenario("lost-prepare-response", async (test) => {
    test.state.drop = "gui.retirementPrepare";
    const requestId = randomUUID();
    await assert.rejects(
      test.adapter.retire(test.migrationId, requestId),
      (error) => error.requestId === requestId,
    );
    assert.deepEqual(await fs.readFile(test.sourcePath), test.original);
    const receipt = await test.status(requestId);
    assert.equal(receipt.status.requestId, requestId);
    assert.equal(receipt.operation.state, "acceptedPending");
    assert.equal(receipt.operation.result.next, null);
    assert(!JSON.stringify(receipt).includes("synthetic-token"));
    assert.equal(
      test.state.calls.filter((call) => call.method === "gui.retirementPrepare").length,
      1,
    );
    assert.equal((await test.adapter.retire(test.migrationId)).requestId, requestId);
  });
  await scenario("lost-confirm-response-and-partial-recovery", async (test) => {
    test.state.drop = "gui.retirementConfirm";
    await assert.rejects(
      test.adapter.retire(test.migrationId),
      (error) => error.requestId === test.state.requestId,
    );
    assert.deepEqual(await fs.readFile(test.sourcePath), test.sanitized);
    assert.deepEqual(await fs.readFile(test.backupPath), test.original);
    const inode = (await fs.stat(test.sourcePath)).ino;
    assert.equal((await test.adapter.retire(test.migrationId)).state, "completed");
    assert.equal((await fs.stat(test.sourcePath)).ino, inode);
    assert.deepEqual(await fs.readFile(test.backupPath), test.sanitized);
  });
  await scenario("vault-lock-pauses-unapplied-target", async (test) => {
    afterTemporarySync = async () => {
      test.state.locked = true;
    };
    await assert.rejects(
      test.adapter.retire(test.migrationId),
      (error) => error.code === "storageLocked",
    );
    assert.deepEqual(await fs.readFile(test.sourcePath), test.sanitized);
    assert.deepEqual(await fs.readFile(test.backupPath), test.original);
    test.state.locked = false;
    assert.equal((await test.adapter.retire(test.migrationId)).state, "completed");
  });
  await scenario("changed-target-before-prepare-response", async (test) => {
    test.state.prepareHook = () => fs.writeFile(test.sourcePath, "changed source", { mode: 0o600 });
    await assert.rejects(
      test.adapter.retire(test.migrationId),
      (error) => error.code === "sourceChanged",
    );
    assert.equal(await fs.readFile(test.sourcePath, "utf8"), "changed source");
    assert.deepEqual(await fs.readFile(test.backupPath), test.original);
  });
  await scenario("changed-target-after-temporary-fsync", async (test) => {
    afterTemporarySync = () =>
      fs.writeFile(test.sourcePath, "changed during copy", { mode: 0o600 });
    await assert.rejects(
      test.adapter.retire(test.migrationId),
      (error) => error.code === "sourceChanged",
    );
    assert.equal(await fs.readFile(test.sourcePath, "utf8"), "changed during copy");
    assert(!(await fs.readdir(test.source.coreHome)).some((name) => name.endsWith(".tmp")));
    assert.deepEqual(await fs.readFile(test.backupPath), test.original);
  });
  for (const site of ["source", "derivative"]) {
    await scenario("symlink-" + site, async (test) => {
      const path = site === "source" ? test.sourcePath : test.derivativePath;
      const outside = join(test.directory, "outside.bytes");
      await fs.rename(path, outside);
      await fs.symlink(outside, path);
      await assert.rejects(test.adapter.retire(test.migrationId));
      assert.deepEqual(
        await fs.readFile(outside),
        site === "source" ? test.original : test.sanitized,
      );
    });
    await scenario("nonprivate-" + site, async (test) => {
      await fs.chmod(site === "source" ? test.sourcePath : test.derivativePath, 0o644);
      await assert.rejects(test.adapter.retire(test.migrationId), /private/);
      assert.deepEqual(await fs.readFile(test.sourcePath), test.original);
    });
  }
  await scenario("changed-derivative", async (test) => {
    const changed = Buffer.from(test.sanitized);
    changed[0] = 33;
    await fs.writeFile(test.derivativePath, changed);
    await assert.rejects(test.adapter.retire(test.migrationId), /digest mismatch/);
    assert.deepEqual(await fs.readFile(test.sourcePath), test.original);
  });
  await scenario("symlink-derivative-directory", async (test) => {
    const directory = dirname(test.derivativePath);
    const outside = join(test.directory, "outside-directory");
    await fs.rename(directory, outside);
    await fs.symlink(outside, directory);
    await assert.rejects(test.adapter.retire(test.migrationId), /without symlinks/);
    assert.deepEqual(await fs.readFile(test.sourcePath), test.original);
  });
  await scenario("missing-target-after-prepare", async (test) => {
    test.state.prepareHook = () => fs.unlink(test.sourcePath);
    await assert.rejects(test.adapter.retire(test.migrationId), (error) => error.code === "ENOENT");
    assert.deepEqual(await fs.readFile(test.backupPath), test.original);
  });
  await scenario("original-request-id-required", async (test) => {
    test.state.drop = "gui.retirementPrepare";
    await assert.rejects(test.adapter.retire(test.migrationId));
    await assert.rejects(test.adapter.retire(test.migrationId, randomUUID()), /original requestId/);
    assert.equal(
      test.state.calls.filter((call) => call.method === "gui.retirementPrepare").length,
      1,
    );
  });
  await scenario("fixed-target-boundary", async (test) => {
    test.state.nextOverride = {
      site: "source",
      relativeName: "provider-credentials.json",
      backupId: randomUUID(),
      beforeDigest: sha(test.original),
      afterDigest: sha(test.sanitized),
      byteLength: test.sanitized.length,
    };
    await assert.rejects(test.adapter.retire(test.migrationId), /Invalid Host retirement target/);
    test.state.nextOverride.relativeName = "subscription-transport.json";
    test.state.nextOverride.backupId = "../outside";
    await assert.rejects(test.adapter.retire(test.migrationId), /Invalid Host retirement target/);
    assert.deepEqual(await fs.readFile(test.sourcePath), test.original);
  });
  for (const kind of ["blocked", "ready"]) {
    await scenario("controlled-import-" + kind, async (test) => {
      test.state.importKind = kind;
      const requestPath = join(test.directory, "request.json"),
        resultPath = join(test.directory, "result.json");
      await save(requestPath, {
        source: test.source,
        hostHome: test.hostHome,
        requestId: test.migrationId,
        resultPath,
      });
      process.argv.push("--areal-host-import-source=" + requestPath);
      try {
        const result = await prepareGuiSource({
          app: { whenReady: async () => {} },
          guiUserData: test.source.profile,
          coreHome: test.source.coreHome,
          legacyServiceHome: test.source.legacyServiceHome,
          encryption: test.adapter.encryption,
        });
        assert.equal(result.kind, kind);
        assert.deepEqual(
          await fs.readFile(test.sourcePath),
          kind === "ready" ? test.sanitized : test.original,
        );
        assert.equal(
          test.state.calls.some((call) => call.method === "gui.retirementPrepare"),
          kind === "ready",
        );
      } finally {
        process.argv.pop();
      }
    });
  }
  await save(join(evidenceDirectory, "h2-retirement-gui-result.json"), {
    state: "passed",
    scope: "Node GUI adapter with authenticated fake Host socket and synthetic isolated files",
    root,
    checks,
    source: {
      guiSource: sha(
        await fs.readFile(join(repository, "clients/gui/app/src/core/gui-source.cjs")),
      ),
      hostClient: sha(
        await fs.readFile(join(repository, "clients/gui/packages/client/node/host-client.cjs")),
      ),
      script: sha(await fs.readFile(fileURLToPath(import.meta.url))),
    },
    excluded: [
      "real Rust Host",
      "real secure store or credentials",
      "Electron UI/singleton acquisition",
      "foreign UID fixture",
      "power-loss durability",
      "package",
    ],
  });
  console.log(
    `PASS ${checks.length} GUI retirement scenarios. Evidence ${join(evidenceDirectory, "h2-retirement-gui-result.json")}`,
  );
} catch (error) {
  await save(join(evidenceDirectory, "h2-retirement-gui-failure.json"), {
    state: "failed",
    checks,
    root,
    message: error.message,
    stack: error.stack,
  });
  throw error;
}
