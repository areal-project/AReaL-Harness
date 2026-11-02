import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("../app/src/core/host-client.cjs");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { GuiSourceAdapter, assertLegacySourceWritable } = require("../app/src/core/gui-source.cjs");
const WebSocket = require("ws");
const { CoreClient } = await import(join(gui, "packages/runtime-client/core.js"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = await realpath(await mkdtemp("/tmp/ah-gui-source-"));
const save = async (path, value) => writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function optional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function tree(path, prefix = "") {
  const result = {};
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (item.name === ".service-user-data" || item.name === "diagnostics") continue;
    const name = prefix + item.name;
    if (item.isDirectory()) Object.assign(result, await tree(join(path, item.name), name + "/"));
    if (item.isFile()) result[name] = sha(await readFile(join(path, item.name)));
  }
  return result;
}
async function unit() {
  const hostHome = join(root, "host-home"),
    storage = join(hostHome, "host");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const socketPath = join(root, "host.sock"),
    generation = randomUUID(),
    hostId = randomUUID();
  const originalId = randomUUID();
  let snapshot = {
    version: 1,
    pending: [
      {
        requestId: originalId,
        params: { text: "x".repeat(1024 * 1024 + 10) },
        unknownField: "preserve",
      },
    ],
    outcomes: {},
  };
  let revision = 1,
    prepareConflict = true,
    commitConflict = true,
    blockedCommit = false,
    loseCommit = false;
  const slots = new Map(),
    operations = new Map();
  const credentialSlot = {
    kind: "subscriptionAccount",
    sourceId: randomUUID(),
    providerId: "openai",
  };
  let credentialRevision = 1,
    credentialValue = { token: "dummy-original" },
    credentialWrites = 0,
    loseCredentialReply = false;
  const server = createServer((socket) => {
    let bytes = "";
    async function respond(request) {
      const params = request.params;
      let result;
      if (request.method === "hello") {
        assert.equal(params.authToken, "synthetic-test-token");
        result = {
          version: 1,
          hostId,
          generation,
          capabilities: ["guiImport", "submissionJournal", "credentialVault"],
        };
      } else if (request.method === "host.operation") {
        result = { operation: operations.get(params.requestId) ?? null };
      } else if (request.method === "vault.read") {
        assert.deepEqual(params.slot, credentialSlot);
        result = { revision: credentialRevision, value: credentialValue };
      } else if (request.method === "vault.replace") {
        assert.deepEqual(params.slot, credentialSlot);
        assert.equal(params.expectedGeneration, generation);
        credentialWrites++;
        if (params.expectedRevision !== credentialRevision) {
          socket.write(
            JSON.stringify({
              version: 1,
              id: request.id,
              error: { code: "revisionConflict", message: "vault revision changed" },
            }) + "\n",
          );
          return;
        }
        result = {
          requestId: params.requestId,
          method: "vault.replace",
          slot: credentialSlot,
          previousRevision: params.expectedRevision,
        };
        credentialValue = params.value;
        credentialRevision++;
        result = {
          ...result,
          state: "completed",
          revision: credentialRevision,
          entryId: randomUUID(),
        };
        operations.set(params.requestId, result);
        if (loseCredentialReply) {
          socket.destroy();
          return;
        }
      } else if (request.method === "journal.read") {
        const snapshotPath = join(storage, randomUUID() + ".snapshot");
        const content = Buffer.from(JSON.stringify(snapshot));
        await writeFile(snapshotPath, content, { mode: 0o600 });
        result = { revision, snapshotPath, sha256: sha(content), byteLength: content.length };
      } else if (request.method === "journal.prepare") {
        if (prepareConflict) {
          prepareConflict = false;
          revision++;
          result = {
            requestId: params.requestId,
            projectId: params.projectId,
            method: "journal.commit",
            state: "blocked",
            error: { code: "revisionConflict", revision },
          };
        } else {
          const slotId = randomUUID(),
            writePath = join(storage, slotId + ".staging");
          await writeFile(writePath, "", { mode: 0o600 });
          slots.set(slotId, { ...params, socket, writePath });
          result = { requestId: params.requestId, state: "prepared", slotId, writePath };
        }
      } else if (request.method === "journal.commit") {
        const slot = slots.get(params.slotId);
        assert.equal(
          slot.socket,
          socket,
          "staging and commit must use the same authenticated connection",
        );
        assert.equal(slot.requestId, params.requestId);
        if (commitConflict || blockedCommit) {
          const code = commitConflict ? "revisionConflict" : "slotExpired";
          commitConflict = false;
          revision++;
          socket.write(
            JSON.stringify({
              version: 1,
              id: request.id,
              result: {
                requestId: params.requestId,
                projectId: slot.projectId,
                method: "journal.commit",
                state: "blocked",
                error: { code, revision },
              },
            }) + "\n",
          );
          return;
        }
        const content = await readFile(slot.writePath);
        assert.equal(content.length, slot.byteLength);
        assert.equal(sha(content), slot.sha256);
        snapshot = JSON.parse(content);
        revision++;
        result = {
          requestId: params.requestId,
          projectId: params.projectId,
          revision,
          state: "completed",
        };
        operations.set(params.requestId, result);
        if (loseCommit) {
          socket.destroy();
          return;
        }
      } else throw new Error("Unexpected method " + request.method);
      const response = JSON.stringify({ version: 1, id: request.id, result }) + "\n";
      socket.write(response.slice(0, 8));
      socket.write(response.slice(8));
    }
    socket.on("data", (chunk) => {
      bytes += chunk;
      for (;;) {
        const end = bytes.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(bytes.slice(0, end));
        bytes = bytes.slice(end + 1);
        void respond(request).catch((error) => socket.destroy(error));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((done) => server.listen(socketPath, done));
  await chmod(socketPath, 0o600);
  await save(join(storage, "auth.json"), "synthetic-test-token");
  await save(join(storage, "host.json"), {
    version: 1,
    hostId,
    generation,
    socketPath,
    authFile: join(storage, "auth.json"),
  });
  const client = new HostClient();
  try {
    await client.connect(hostHome);
    const requestId = randomUUID();
    assert.equal((await client.operation(requestId)).operation, null);
    assert.deepEqual(await client.vaultRead(credentialSlot), {
      revision: 1,
      value: { token: "dummy-original" },
    });
    const logout = await client.vaultReplace(randomUUID(), credentialSlot, 1, null);
    assert.equal(logout.state, "completed");
    assert.equal(logout.revision, 2);
    await assert.rejects(
      client.vaultReplace(randomUUID(), credentialSlot, 1, { token: "dummy-stale-refresh" }),
      (error) => error.code === "revisionConflict",
    );
    assert.equal(credentialWrites, 2, "SDK must not retry a stale refresh");
    assert.equal((await client.vaultRead(credentialSlot)).value, null);
    loseCredentialReply = true;
    const lostCredentialId = randomUUID();
    await assert.rejects(
      client.vaultReplace(lostCredentialId, credentialSlot, 2, { token: "dummy-new-login" }),
      (error) => error.requestId === lostCredentialId && error.operation === "vault.replace",
    );
    client.close();
    await client.connect(hostHome);
    const recoveredCredential = (await client.operation(lostCredentialId)).operation;
    assert.equal(recoveredCredential.state, "completed");
    assert.equal(recoveredCredential.requestId, lostCredentialId);
    assert.equal(credentialWrites, 3, "lost response must not replay a credential write");
    assert.equal(JSON.stringify(recoveredCredential).includes("dummy-new-login"), false);
    loseCredentialReply = false;
    await assert.rejects(
      client.request("oversized", { value: "x".repeat(1024 * 1024) }),
      /exceeds 1 MiB/,
    );
    const journal = client.journal("synthetic-project");
    let mutations = 0;
    await journal.change((current) => {
      mutations++;
      current.outcomes[originalId] = { requestId: originalId, state: "unknown" };
      return current;
    });
    assert.equal(mutations, 3, "prepare and commit CAS conflicts reread and rerun closure");
    assert.equal(snapshot.pending[0].requestId, originalId);
    assert.equal(snapshot.pending[0].params.text.length, 1024 * 1024 + 10);
    assert.equal(snapshot.pending[0].unknownField, "preserve");
    blockedCommit = true;
    await assert.rejects(
      journal.change((current) => {
        mutations++;
        return current;
      }),
      /not complete/,
    );
    assert.equal(mutations, 4, "other blocked receipts must not replay mutation closure");
    blockedCommit = false;
    loseCommit = true;
    let lostId;
    await assert.rejects(
      journal.change((current) => {
        mutations++;
        return current;
      }),
      (error) => {
        lostId = error.requestId;
        return error.operation === "journal.commit" && typeof lostId === "string";
      },
    );
    assert.equal(mutations, 5, "lost response must not replay mutation closure");
    const recovered = new HostClient();
    try {
      await recovered.connect(hostHome);
      assert.equal((await recovered.operation(lostId)).operation.state, "completed");
    } finally {
      recovered.close();
    }
  } finally {
    client.close();
    await new Promise((done) => server.close(done));
  }
  const source = {
    profile: join(root, "profile"),
    coreHome: join(root, "core"),
    legacyServiceHome: join(root, "legacy"),
  };
  for (const path of Object.values(source)) await mkdir(path, { mode: 0o700 });
  const value = {
    keys: { AREAL_CREDENTIAL_disabled: Buffer.from("synthetic-key").toString("base64") },
    migrated: [],
  };
  const backup = join(storage, "original.bytes");
  await save(backup, value);
  const secret = {
    readPath: backup,
    relativeName: "provider-credentials.json",
    sourceDigest: sha(await readFile(backup)),
    slot: {
      kind: "providerCredential",
      sourceId: randomUUID(),
      reference: "AREAL_CREDENTIAL_disabled",
    },
  };
  let decrypts = 0;
  const encryption = {
    isEncryptionAvailable: () => true,
    decryptString: (bytes) => {
      decrypts++;
      return bytes.toString();
    },
  };
  const adapter = new GuiSourceAdapter({ source, hostHome, singletonHeld: true, encryption });
  assert.equal(await adapter.extract(secret), "synthetic-key");
  await writeFile(backup, "{}", { mode: 0o600 });
  await assert.rejects(adapter.extract(secret), (error) => error.code === "sourceChanged");
  assert.equal(decrypts, 1, "changed bytes must fail before decryption");
  await assert.rejects(
    adapter.extract({
      ...secret,
      relativeName: "cloud.json",
      sourceDigest: sha(await readFile(backup)),
    }),
    /does not match/,
  );
  assert.throws(
    () => new GuiSourceAdapter({ source, hostHome, singletonHeld: false, encryption }),
    /singleton/,
  );
  await writeFile(join(source.coreHome, "provider-credentials.json"), "AREAL_HOST_MIGRATED\n{}\n");
  await assert.rejects(
    assertLegacySourceWritable(source.coreHome),
    (error) => error.code === "GUI_SOURCE_MIGRATED",
  );
  await save(join(root, "result.json"), {
    scope: "Node adapter and authenticated socket boundary; encryption stub only",
    state: "passed",
    checks: [
      "private discovery and authenticated fragmented hello",
      "bounded frames",
      "missing operation remains null",
      "credential CAS conflict is returned without refresh retry",
      "lost credential response retains original requestId without replay",
      "journal snapshot larger than 1 MiB preserved",
      "CAS conflict retries closure from latest snapshot",
      "lost commit response queries original operation without replay",
      "exact ciphertext digest before decrypt",
      "disabled reference preserved",
      "cloud excluded",
      "singleton prerequisite",
      "fenced source rejected before old writers",
    ],
  });
}

function launch(executable, args, env, name, ownerPipe = false) {
  const child = spawn(executable, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe", ...(ownerPipe ? ["pipe"] : [])],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const done = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  }).then(async (exit) => {
    await writeFile(join(root, name + ".stdout"), stdout);
    await writeFile(join(root, name + ".stderr"), stderr);
    child.stdout.destroy();
    child.stderr.destroy();
    return exit;
  });
  return { child, done, finish: () => done, output: () => ({ stdout, stderr }) };
}
async function integration() {
  assert.equal(process.platform, "darwin", "real Keychain integration requires macOS");
  assert.equal(
    process.env.AREAL_TEST_HOST_KEYCHAIN,
    "1",
    "Set AREAL_TEST_HOST_KEYCHAIN=1 only with authorization for isolated test Keychain entries",
  );
  assert(process.env.HOME?.startsWith("/"), "preserve native HOME for macOS Keychain");
  const legacyArgument = process.argv.find((arg) => arg.startsWith("--legacy-app="));
  const binaryArgument = process.argv.find((arg) => arg.startsWith("--host-bin="));
  assert(
    legacyArgument && binaryArgument,
    "Pass immutable --legacy-app=<app directory> and --host-bin=<areal binary>",
  );
  const legacyApp = await realpath(legacyArgument.slice("--legacy-app=".length));
  const binary = await realpath(binaryArgument.slice("--host-bin=".length));
  const legacyManifest = JSON.parse(
    await readFile(join(legacyApp, "..", "source-manifest.json"), "utf8"),
  );
  for (const [name, expected] of Object.entries(legacyManifest.sha256))
    assert.equal(
      sha(await readFile(join(legacyApp, "..", name))),
      expected,
      `immutable legacy source ${name}`,
    );
  const { ServiceConnection } = require(join(legacyApp, "src/core/service-connection.cjs"));
  const installedElectron = require("electron");
  const profile = join(root, "profile"),
    coreHome = join(root, "core"),
    legacyServiceHome = join(root, "legacy"),
    hostHome = join(root, "host-home"),
    configHome = join(root, "configuration");
  for (const path of [
    profile,
    coreHome,
    legacyServiceHome,
    hostHome,
    configHome,
    join(root, "user"),
  ])
    await mkdir(path, { mode: 0o700 });
  const source = { profile, coreHome, legacyServiceHome };
  const config = join(configHome, "config.toml");
  await writeFile(
    config,
    'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1/v1/chat/completions"\n',
    { mode: 0o600 },
  );
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    HOME: process.env.HOME,
    AREAL_GUI_USER_DATA: profile,
    AREAL_CORE_HOME: coreHome,
    AREAL_HARNESS_HOME: configHome,
    AREAL_HARNESS_SERVICE_HOME: legacyServiceHome,
    AREAL_CORE_USER_HOME: join(root, "user"),
    AREAL_CORE_BIN: binary,
    AREAL_CORE_CONFIG: config,
    OTEL_SDK_DISABLED: "true",
    NO_PROXY: "127.0.0.1,localhost",
    AREAL_GUI_OWNER: JSON.stringify({ kind: "gui", appRunId: randomUUID(), profile }),
    AREAL_GUI_DESKTOP_LIFETIME_FD: "3",
  };
  const runId = randomUUID();
  const appName = `AReaL H2 SafeStorage Test ${runId}`;
  const identity = {
    runId,
    appName,
    service: appName + " Safe Storage",
    account: appName + " Key",
    hostService: "org.areal.host.v1." + sha(hostHome),
    electronVersion: require("electron/package.json").version,
    nativeHome: env.HOME,
    coreUserHome: env.AREAL_CORE_USER_HOME,
  };
  const identityPath = join(root, "keychain-identity.json");
  await save(identityPath, identity);
  const bootstrap = join(root, "identity-bootstrap.cjs");
  await writeFile(
    bootstrap,
    `
const assert = require("node:assert/strict");
const { appendFileSync, writeFileSync } = require("node:fs");
const { app, safeStorage } = require("electron");
const identity = require(${JSON.stringify(identityPath)});
const target = JSON.parse(process.env.AREAL_H2_TEST_ENTRY);
assert.equal(app.isReady(), false, "identity must be set synchronously before ready");
assert.equal(app.getName(), identity.appName, "native startup name before override");
const nativeSetName = app.setName.bind(app);
nativeSetName(identity.appName);
app.setName = (name) => {
  assert(["AReaL Harness GUI", identity.appName].includes(name), "unexpected application name");
  nativeSetName(identity.appName);
};
const original = {
  object: safeStorage,
  encrypt: safeStorage.encryptString,
  decrypt: safeStorage.decryptString,
  available: safeStorage.isEncryptionAvailable,
};
function check(phase) {
  assert.equal(app.getName(), identity.appName, "native application identity");
  assert.equal(require("electron").safeStorage, original.object);
  assert.equal(safeStorage.encryptString, original.encrypt);
  assert.equal(safeStorage.decryptString, original.decrypt);
  assert.equal(safeStorage.isEncryptionAvailable, original.available);
  appendFileSync(target.evidence, JSON.stringify({
    phase, pid: process.pid, appName: app.getName(),
    service: identity.service, account: identity.account,
    realSafeStorageReferences: true,
  }) + "\\n", { mode: 0o600 });
}
check("before-load");
app.once("will-finish-launching", () => check("will-finish-launching"));
app.once("ready", () => check("ready"));
if (target.hook?.kind === "legacy-response-loss") {
  const WebSocket = require(require.resolve("ws", { paths: [target.appPath] }));
  const send = WebSocket.prototype.send;
  const emit = WebSocket.prototype.emit;
  const requests = new WeakMap();
  WebSocket.prototype.send = function (data, ...args) {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch {}
    if (frame?.method && frame.id !== undefined) {
      const entries = requests.get(this) ?? new Map();
      requests.set(this, entries);
      entries.set(frame.id, frame);
      if (frame.method.startsWith("areal/") || frame.method === "thread/list")
        appendFileSync(target.hook.trace, JSON.stringify({ direction: "request", method: frame.method,
          id: frame.id, requestId: frame.params?.requestId }) + "\\n", { mode: 0o600 });
    }
    return send.call(this, data, ...args);
  };
  WebSocket.prototype.emit = function (event, ...args) {
    if (event === "message") {
      let frame;
      try { frame = JSON.parse(args[0].toString()); } catch {}
      const request = requests.get(this)?.get(frame?.id);
      if (request?.params?.requestId === target.hook.requestId &&
          ["areal/thread/start", "areal/request/read"].includes(request.method)) {
        appendFileSync(target.hook.trace, JSON.stringify({ direction: "suppressed-response",
          method: request.method, requestId: request.params.requestId, id: frame.id,
          hasResult: Object.hasOwn(frame, "result"), hasError: Object.hasOwn(frame, "error")
        }) + "\\n", { mode: 0o600 });
        if (request.method === "areal/thread/start" && frame.result)
          writeFileSync(target.hook.barrier, JSON.stringify({ pid: process.pid,
            boundary: "ws-message-before-CoreClient", request, result: frame.result }) + "\\n", { mode: 0o600 });
        this.terminate();
        return true;
      }
    }
    return emit.call(this, event, ...args);
  };
}
if (target.hook?.kind === "host-response-barrier") {
  const { HostClient } = require(target.appPath + "/src/core/host-client.cjs");
  const request = HostClient.prototype.request;
  HostClient.prototype.request = async function (method, params) {
    const result = await request.call(this, method, params);
    if (method === target.hook.method &&
        (method !== "gui.import" || result.kind === "ready" && result.phase === "committed")) {
      writeFileSync(target.hook.barrier, JSON.stringify({ pid: process.pid, method,
        requestId: params.requestId, migrationId: params.migrationId ?? result.migrationId,
        result }) + "\\n", { mode: 0o600 });
      await new Promise(() => {});
    }
    return result;
  };
}
if (target.appPath) app.setAppPath(target.appPath);
require(target.entry);
check("after-load");
`,
    { mode: 0o600 },
  );
  identity.bootstrapSha256 = sha(await readFile(bootstrap));
  await save(identityPath, identity);
  const processes = [];
  const electronEvidence = [];
  function start(executable, args, environment, name, ownerPipe = false) {
    const process = launch(executable, args, environment, name, ownerPipe);
    processes.push({ name, process });
    return process;
  }
  const electronBundle = join(root, "Electron.app");
  const installedBundle = resolve(installedElectron, "../../..");
  const electron = join(electronBundle, "Contents/MacOS/Electron");
  const plist = join(electronBundle, "Contents/Info.plist");
  for (const [name, executable, args] of [
    ["electron-copy", "/usr/bin/ditto", [installedBundle, electronBundle]],
    ["electron-name", "/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleName ${appName}`, plist]],
    [
      "electron-display-name",
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :CFBundleDisplayName ${appName}`, plist],
    ],
    [
      "electron-id",
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :CFBundleIdentifier org.areal.h2.${runId}`, plist],
    ],
    ["electron-sign", "/usr/bin/codesign", ["--force", "--sign", "-", electronBundle]],
    ["electron-verify", "/usr/bin/codesign", ["--verify", "--strict", electronBundle]],
    ["electron-signature", "/usr/bin/codesign", ["-dvv", electronBundle]],
  ]) {
    const process = start(executable, args, env, name);
    assert.equal((await process.finish()).code, 0, `${name} succeeds`);
    if (name === "electron-copy") {
      const appDirectory = join(electronBundle, "Contents/Resources/app");
      await mkdir(appDirectory, { recursive: true });
      await writeFile(
        join(appDirectory, "package.json"),
        JSON.stringify({
          name: "areal-h2-isolated-test",
          productName: appName,
          main: "main.cjs",
        }),
      );
      await writeFile(
        join(appDirectory, "main.cjs"),
        `try { require(${JSON.stringify(bootstrap)}); } catch (error) { console.error(error.stack); require("electron").app.exit(1); }\n`,
      );
    }
  }
  identity.electronBundle = electronBundle;
  identity.electronExecutableSha256 = sha(await readFile(electron));
  identity.electronPlistSha256 = sha(await readFile(plist));
  identity.electronSignatureEvidence = join(root, "electron-signature.stderr");
  await save(identityPath, identity);
  function desktop(
    appPath,
    args,
    name,
    ownerPipe = false,
    entry = join(appPath, "src/main.cjs"),
    hook,
  ) {
    const evidence = join(root, name + ".identity.jsonl");
    electronEvidence.push({ name, evidence });
    return start(
      electron,
      args,
      {
        ...env,
        AREAL_H2_TEST_ENTRY: JSON.stringify({ appPath, entry, evidence, hook }),
      },
      name,
      ownerPipe,
    );
  }
  let securitySequence = 0;
  async function security(args) {
    const command = start("/usr/bin/security", args, env, "keychain-" + securitySequence++);
    const exit = await command.finish();
    return { ...exit, ...command.output() };
  }
  function missing(result) {
    return result.code === 44 && result.stderr.includes("could not be found");
  }
  async function cleanEntry(service, account, expectedKeychain) {
    const item = { service, account, state: "pending" };
    cleanup.entries.push(item);
    await save(cleanupPath, cleanup);
    const found = await security(["find-generic-password", "-s", service, "-a", account]);
    item.findExit = found.code;
    if (missing(found)) {
      item.state = "absent";
      return;
    }
    assert.equal(found.code, 0, `exact Keychain lookup failed for ${service}/${account}`);
    const keychain = /^keychain: "([^"\n]+)"/m.exec(found.stdout)?.[1];
    assert(keychain?.startsWith("/"), "exact Keychain metadata must identify its database");
    if (expectedKeychain)
      assert.equal(keychain, expectedKeychain, "cleanup exact original database");
    item.keychain = keychain;
    await save(cleanupPath, cleanup);
    const deleted = await security([
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
      keychain,
    ]);
    item.deleteExit = deleted.code;
    assert.equal(deleted.code, 0, `exact test Keychain deletion failed for ${service}/${account}`);
    const after = await security(["find-generic-password", "-s", service, "-a", account, keychain]);
    item.verifyExit = after.code;
    assert(missing(after), "test Keychain item must be absent after exact deletion");
    item.state = "removed";
  }
  const requestId = randomUUID();
  const cleanupPath = join(root, "keychain-cleanup.json");
  const cleanup = { state: "pending", identity, entries: [], processes: [], errors: [] };
  await save(cleanupPath, cleanup);
  const ids = [];
  const projects = [];
  for (const name of ["project-one", "project-two"]) {
    const workspace = join(root, name);
    await mkdir(workspace);
    const id = sha(await realpath(workspace)).slice(0, 24);
    ids.push(id);
    projects.push({ id, root: workspace });
  }
  const originalRequestId = randomUUID();
  const legacyBarrierPath = join(root, "legacy-create-lost-response.json");
  const legacyTracePath = join(root, "legacy-core-rpc.jsonl");
  const crashEvidence = [];
  let pending, outcomes, legacyAccepted, safeStorageKeychain, passedResult;
  let recoveryCore, recoveryHost;
  let originalThreadIds;
  let recoveryBackend;
  await save(join(coreHome, "cloud.json"), { syntheticClientOnly: true });
  const fixtureEntry = join(root, "secure-fixture.cjs");
  let old, importer, reverse, stopper;
  let safeStorageStarted = false;
  const legacyConnection = new ServiceConnection();
  try {
    const identityEntry = join(root, "identity-only.cjs");
    const identityResult = join(root, "identity-only.json");
    await writeFile(
      identityEntry,
      `const { app } = require("electron"); const { writeFileSync } = require("node:fs"); writeFileSync(${JSON.stringify(identityResult)}, JSON.stringify({ appName: app.getName(), defaultApp: process.defaultApp ?? false, execPath: process.execPath })); setImmediate(() => app.exit(0));\n`,
    );
    const identityChild = desktop(null, [], "identity-only", false, identityEntry);
    assert.equal((await identityChild.finish()).code, 0, "identity-only child succeeds");
    const observedIdentity = JSON.parse(await readFile(identityResult, "utf8"));
    assert.equal(observedIdentity.appName, appName, "native identity before safeStorage use");
    assert.equal(observedIdentity.defaultApp, false, "dedicated Electron app is loaded");
    assert.equal(observedIdentity.execPath, electron, "dedicated Electron executable is used");
    const before = await security([
      "find-generic-password",
      "-s",
      identity.service,
      "-a",
      identity.account,
    ]);
    assert(missing(before), "unique safeStorage test identity must not already exist");
    await save(join(root, "keychain-preflight.json"), {
      service: identity.service,
      account: identity.account,
      state: "absent",
      exitCode: before.code,
    });
    await writeFile(
      fixtureEntry,
      `const assert=require("node:assert/strict");const {app,safeStorage}=require("electron");const {writeFileSync}=require("node:fs");app.setPath("userData",process.env.AREAL_GUI_USER_DATA);app.whenReady().then(()=>{if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==="basic_text")throw Error("secure storage unavailable");const encrypted=safeStorage.encryptString("isolated-dummy-key");writeFileSync(${JSON.stringify(join(root, "secure-fixture-ciphertext.json"))},JSON.stringify({base64:encrypted.toString("base64")}),{mode:384});assert.equal(safeStorage.decryptString(encrypted),"isolated-dummy-key");writeFileSync(${JSON.stringify(join(coreHome, "provider-credentials.json"))},JSON.stringify({keys:{AREAL_CREDENTIAL_disabled:encrypted.toString("base64")},migrated:[]}),{mode:384});app.exit(0)}).catch(e=>{console.error(e.message);app.exit(1)});`,
    );
    safeStorageStarted = true;
    const fixture = desktop(null, [], "secure-fixture", false, fixtureEntry);
    assert.equal((await fixture.finish()).code, 0, "real Electron safeStorage fixture");
    const safeStorageFound = await security([
      "find-generic-password",
      "-s",
      identity.service,
      "-a",
      identity.account,
    ]);
    assert.equal(
      safeStorageFound.code,
      0,
      "fixture creates exact isolated native safeStorage item",
    );
    safeStorageKeychain = /^keychain: "([^"\n]+)"/m.exec(safeStorageFound.stdout)?.[1];
    assert(safeStorageKeychain?.startsWith("/"), "safeStorage metadata identifies exact database");
    await save(join(root, "keychain-positive-identity.json"), {
      service: identity.service,
      account: identity.account,
      keychain: safeStorageKeychain,
      exitCode: safeStorageFound.code,
    });
    old = desktop(legacyApp, ["--areal-core-service"], "legacy-before", true, undefined, {
      kind: "legacy-response-loss",
      requestId: originalRequestId,
      barrier: legacyBarrierPath,
      trace: legacyTracePath,
    });
    const metadata = await until(async () => {
      const bytes = await optional(join(coreHome, "service.json"));
      if (bytes) return JSON.parse(bytes);
      if (old.child.exitCode != null)
        throw new Error("Legacy Desktop failed before baseline; inspect legacy-before.stderr");
    }, "real legacy Desktop publication");
    await legacyConnection.connect(metadata);
    await legacyConnection.request("hello", {
      protocol: metadata.protocol,
      identity: metadata.identity,
    });
    const originalServices = [];
    for (const project of projects) {
      assert.equal(
        await legacyConnection.request("addProject", { path: project.root }, true),
        project.id,
      );
      const dataDir = await realpath(join(coreHome, project.id, "state"));
      const serviceId = sha(dataDir).slice(0, 24);
      const directory = join(legacyServiceHome, "services", serviceId);
      const descriptor = JSON.parse(await readFile(join(directory, "service.json"), "utf8"));
      assert.equal(descriptor.serviceId, serviceId);
      assert.equal(descriptor.workspace, project.root);
      assert.equal(descriptor.dataDir, dataDir);
      assert.equal(descriptor.owner.kind, "gui");
      assert.equal(descriptor.owner.profile, profile);
      assert(
        Object.keys(await tree(dataDir)).some(
          (name) => !["owner.lock", "service.lock"].includes(name),
        ),
        "old Core created a real Store",
      );
      originalServices.push({ directory, descriptor });
    }
    assert.deepEqual(JSON.parse(await readFile(join(coreHome, "projects.json"), "utf8")), projects);
    const oldService = originalServices[0].descriptor;
    const oldAuth = JSON.parse(await readFile(oldService.authFile, "utf8"));
    const oldCore = new CoreClient({
      createSocket: () =>
        new WebSocket(oldService.endpoint, {
          headers: { Authorization: `Bearer ${oldAuth.principals[0].token}` },
        }),
    });
    try {
      await oldCore.connect();
      const beforeThreads = await oldCore.request("thread/list", { limit: 100 });
      assert.equal(beforeThreads.nextCursor, null, "isolated initial thread list fits one page");
      originalThreadIds = beforeThreads.data.map((thread) => thread.id);
      assert.deepEqual(originalThreadIds, [], "isolated workspace begins without threads");
    } finally {
      oldCore.close();
    }
    const creation = legacyConnection
      .request(
        "command",
        {
          name: "create",
          request: { projectId: ids[0], requestId: originalRequestId },
        },
        true,
      )
      .then(
        (value) => ({ value }),
        (error) => ({
          error: { message: error.message, submissionUnknown: error.submissionUnknown },
        }),
      );
    legacyAccepted = await until(async () => {
      const bytes = await optional(legacyBarrierPath);
      return bytes && JSON.parse(bytes);
    }, "real old Desktop accepted create response intercepted before CoreClient");
    assert.equal(legacyAccepted.boundary, "ws-message-before-CoreClient");
    assert.equal(legacyAccepted.request.method, "areal/thread/start");
    assert.equal(legacyAccepted.request.params.requestId, originalRequestId);
    assert(legacyAccepted.result.thread.id);
    const createReply = await creation;
    assert.equal(createReply.error?.submissionUnknown, true, "old command reports UNKNOWN");
    pending = JSON.parse(await readFile(join(coreHome, ids[0] + "-pending.json"), "utf8"));
    outcomes = JSON.parse((await optional(join(coreHome, ids[0] + "-outcomes.json"))) ?? "{}");
    assert.equal(pending.length, 1, "legacy writer persisted one real UNKNOWN");
    assert.equal(pending[0].method, "areal/thread/start");
    assert.deepEqual(pending[0].params, legacyAccepted.request.params);
    assert(pending[0].params.creationAdmission, "real old Core admission binding retained");
    assert.equal(
      outcomes[originalRequestId],
      undefined,
      "suppressed response never becomes known outcome",
    );
    await save(join(root, "legacy-create-unknown.json"), { pending, outcomes, createReply });
    legacyConnection.close();
    stopper = desktop(legacyApp, ["--areal-core-service-stop"], "legacy-stop");
    assert.equal(
      (await stopper.finish()).code,
      0,
      "original Desktop lifecycle must settle its Cores",
    );
    assert.equal((await old.finish()).code, 0);
    for (const { directory, descriptor } of originalServices) {
      const receipts = await Promise.all(
        (await readdir(join(directory, "operations"))).map(async (name) => ({
          service: JSON.parse(await readFile(join(directory, "operations", name), "utf8")),
          host: JSON.parse(await readFile(join(legacyServiceHome, "host/operations", name), "utf8"))
            .receipt,
        })),
      );
      assert(
        receipts.some(
          ({ service, host }) =>
            host.state === "completed" &&
            host.requestId === service.operation.requestId &&
            host.serviceGeneration === descriptor.generation &&
            host.serviceId === descriptor.serviceId &&
            service.operation.generation === descriptor.generation &&
            service.operation.serviceId === descriptor.serviceId &&
            service.cleanupConfirmed === true &&
            service.service.owner.appRunId === descriptor.owner.appRunId,
        ),
        "original owner persisted exact completed Runtime cleanup proof",
      );
    }
    await save(join(root, "original-services.json"), originalServices);
    assert.deepEqual(
      JSON.parse(await readFile(join(coreHome, ids[0] + "-pending.json"), "utf8")),
      pending,
      "legacy shutdown retains actual UNKNOWN without a runner journal write",
    );
    const original = await tree(coreHome);
    await save(join(root, "original-authority.json"), original);
    start(
      binary,
      ["host", "run"],
      { ...env, AREAL_HARNESS_HOME: hostHome, AREAL_HARNESS_SERVICE_HOME: hostHome },
      "host",
    );
    await until(() => optional(join(hostHome, "host", "host.json")), "shared Host descriptor");
    const requestPath = join(root, "import-request.json"),
      resultPath = join(root, "import-result.json");
    await save(requestPath, { requestId, source, hostHome, resultPath });
    const receiptPath = join(hostHome, "host/imports", requestId, "record.json");
    const importArgs = ["--areal-core-service", `--areal-host-import-source=${requestPath}`];
    for (const [name, method] of [
      ["credential-durable", "gui.importSecret"],
      ["journal-fenced", "gui.import"],
    ]) {
      const barrier = join(root, name + ".barrier.json");
      const interrupted = desktop(join(gui, "app"), importArgs, name, true, undefined, {
        kind: "host-response-barrier",
        method,
        barrier,
      });
      const blocked = await until(async () => {
        const bytes = await optional(barrier);
        if (bytes) return JSON.parse(bytes);
        if (interrupted.child.exitCode != null)
          throw new Error(`Importer exited before ${name}; inspect ${name}.stderr`);
      }, name + " durable response barrier");
      assert.equal(blocked.migrationId, requestId);
      assert.equal(blocked.pid, interrupted.child.pid);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      assert.equal(receipt.requestId, requestId);
      assert.deepEqual(receipt.source, source);
      const providerReceipt = receipt.vaultReceipts.find(
        (entry) =>
          entry.slot.kind === "providerCredential" &&
          entry.slot.reference === "AREAL_CREDENTIAL_disabled",
      );
      assert(providerReceipt, "dummy provider receipt exists");
      assert.equal(providerReceipt.state, "completed");
      if (crashEvidence.length)
        for (const previous of crashEvidence[0].receipt.vaultReceipts)
          assert.deepEqual(
            receipt.vaultReceipts.find(
              (entry) => JSON.stringify(entry.slot) === JSON.stringify(previous.slot),
            ),
            previous,
            "restart retains every original durable credential receipt",
          );
      interrupted.child.kill("SIGKILL");
      const exit = await interrupted.finish();
      assert.equal(exit.signal, "SIGKILL");
      assert.throws(
        () => process.kill(interrupted.child.pid, 0),
        { code: "ESRCH" },
        "importer PID exited",
      );
      assert.equal(await optional(resultPath), null, "interrupted importer has not returned ready");
      const authority = await tree(coreHome);
      if (method === "gui.import") {
        for (const id of ids)
          for (const suffix of ["-pending.json", "-outcomes.json"])
            assert(
              (await readFile(join(coreHome, id + suffix), "utf8")).startsWith(
                "AREAL_HOST_MIGRATED\n",
              ),
            );
        const blockedOld = desktop(
          legacyApp,
          ["--areal-core-service"],
          "legacy-after-interruption",
          true,
        );
        assert.equal(
          (await blockedOld.finish()).code,
          1,
          "old Desktop refuses interrupted committed authority",
        );
        assert.deepEqual(
          await tree(coreHome),
          authority,
          "rejected old writer leaves fences unchanged",
        );
      } else {
        assert.equal(
          authority[ids[0] + "-pending.json"],
          original[ids[0] + "-pending.json"],
          "unpublished migration leaves original UNKNOWN with old authority",
        );
        const unpublished = new HostClient();
        try {
          await unpublished.connect(hostHome);
          await assert.rejects(
            unpublished.journal(receipt.bindings[0].projectId).read(),
            "Host must not publish journal before fences commit",
          );
        } finally {
          unpublished.close();
        }
      }
      crashEvidence.push({ name, method, blocked, receipt, exit, authority });
      await save(join(root, "migration-interruptions.json"), crashEvidence);
    }
    importer = desktop(
      join(gui, "app"),
      ["--areal-core-service", `--areal-host-import-source=${requestPath}`],
      "import",
      true,
    );
    assert.equal(
      (await importer.finish()).code,
      0,
      "import must commit; inspect import.stderr and import-result.json",
    );
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.kind, "ready");
    const hostClient = new HostClient();
    try {
      await hostClient.connect(hostHome);
      const retirement = await hostClient.retirementStatus(result.migrationId);
      assert.equal(
        retirement.state,
        "completed",
        "controlled import retires covered legacy secrets",
      );
      assert.equal(retirement.next, null, "read-only status exposes no derivative payload");
      const finalReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
      const credential = finalReceipt.vaultReceipts.find(
        (entry) => entry.slot.kind === "providerCredential",
      );
      for (const previous of crashEvidence[0].receipt.vaultReceipts)
        assert.deepEqual(
          finalReceipt.vaultReceipts.find(
            (entry) => JSON.stringify(entry.slot) === JSON.stringify(previous.slot),
          ),
          previous,
        );
      assert(finalReceipt.vaultReceipts.every((entry) => entry.state === "completed"));
      assert.equal(
        new Set(finalReceipt.vaultReceipts.map((entry) => entry.entryId)).size,
        finalReceipt.vaultReceipts.length,
      );
      const restoredCredential = await hostClient.vaultRead(credential.slot);
      assert.equal(restoredCredential.revision, credential.revision);
      assert.equal(
        restoredCredential.value,
        "isolated-dummy-key",
        "restarted importer credential is readable",
      );
      assert.equal(
        (await readFile(join(coreHome, "provider-credentials.json"), "utf8")).includes(
          "AREAL_CREDENTIAL_disabled",
        ),
        false,
        "source dummy ciphertext retired",
      );
      const importTree = await tree(join(hostHome, "host/imports", requestId));
      const retiredCiphertext = JSON.parse(
        await readFile(join(root, "secure-fixture-ciphertext.json"), "utf8"),
      );
      for (const path of Object.keys(importTree))
        assert.equal(
          (await readFile(join(hostHome, "host/imports", requestId, path))).includes(
            retiredCiphertext.base64,
          ),
          false,
          "Host import derivatives contain no retired dummy ciphertext",
        );
      await save(join(root, "credential-recovery.json"), {
        migrationId: result.migrationId,
        slot: credential.slot,
        entryId: credential.entryId,
        revision: restoredCredential.revision,
        sourceDigest: credential.sourceDigest,
        dummyReadMatches: true,
        retirement,
        importTree,
      });
      const binding = result.receipt.bindings.find(
        (entry) => entry.alias.legacyProjectId === ids[0],
      );
      assert(binding, "Host publishes original project alias");
      const journal = hostClient.journal(binding.projectId);
      const imported = await journal.read();
      assert.deepEqual(
        imported.snapshot.pending,
        pending,
        "actual old UNKNOWN params and admission retained",
      );
      assert.deepEqual(
        imported.snapshot.outcomes,
        outcomes,
        "actual legacy outcome snapshot retained",
      );
      await journal.change((snapshot) => {
        snapshot.pending.push({
          method: "thread/create",
          params: {
            requestId: randomUUID(),
            input: [{ type: "text", text: "x".repeat(1024 * 1024 + 10) }],
          },
        });
        return snapshot;
      });
      const updated = await journal.read();
      assert.equal(
        updated.snapshot.pending.length,
        2,
        "new authority journal writer commits alongside UNKNOWN",
      );
      assert.deepEqual(updated.snapshot.pending[0], pending[0]);
    } finally {
      hostClient.close();
    }
    const after = await tree(coreHome);
    assert.equal(
      after["projects.json"],
      original["projects.json"],
      "registry retained byte for byte",
    );
    assert.equal(after["cloud.json"], original["cloud.json"], "client-only cloud retained");
    for (const id of ids) {
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(after).filter(([path]) => path.startsWith(id + "/state/")),
        ),
        Object.fromEntries(
          Object.entries(original).filter(([path]) => path.startsWith(id + "/state/")),
        ),
        "Store remains in place",
      );
      for (const suffix of ["-pending.json", "-outcomes.json"])
        assert(
          (await readFile(join(coreHome, id + suffix), "utf8")).startsWith("AREAL_HOST_MIGRATED\n"),
          "including previously absent journal paths",
        );
    }
    reverse = desktop(legacyApp, ["--areal-core-service"], "legacy-after", true);
    assert.equal(
      (await reverse.finish()).code,
      1,
      "actual pre-migration Desktop must refuse fenced source",
    );
    assert.deepEqual(
      await tree(coreHome),
      after,
      "old Desktop must not mutate authority during reverse startup",
    );
    recoveryHost = new HostClient();
    await recoveryHost.connect(hostHome);
    const importedBinding = result.receipt.bindings.find(
      (entry) => entry.alias.legacyProjectId === ids[0],
    );
    const ensured = await recoveryHost.ensureProject(randomUUID(), importedBinding.projectId, {
      workspace: projects[0].root,
      cwd: projects[0].root,
      configHome,
      homedir: env.AREAL_CORE_USER_HOME,
      configPath: config,
      environment: {},
      credentialNames: [],
      options: {
        allow_write: false,
        allow_network: false,
        allow_concurrent_writes: false,
        read_only_path: [],
        task_credential_command: [],
        no_deployment_mcp: false,
      },
    });
    assert(ensured.service, JSON.stringify(ensured));
    const auth = JSON.parse(await readFile(ensured.service.authFile, "utf8"));
    recoveryCore = new CoreClient({
      createSocket: () =>
        new WebSocket(ensured.service.endpoint, {
          headers: { Authorization: `Bearer ${auth.principals[0].token}` },
        }),
    });
    await recoveryCore.connect();
    const recoveryTrace = [];
    const coreRequest = recoveryCore.request.bind(recoveryCore);
    recoveryCore.request = async (method, params, options) => {
      recoveryTrace.push({ method, params });
      return coreRequest(method, params, options);
    };
    recoveryBackend = Object.assign(Object.create(CoreBackend.prototype), {
      host: recoveryHost,
      saved: [{ id: importedBinding.projectId, root: projects[0].root }],
      projects: new Map(),
      awaitingResponses: new Set(),
      onChange() {},
      worktrees: { observeProject: async () => {} },
      providers: {
        redact: (value) => value,
        acceptModelSelection: async () => {},
        rejectModel() {},
      },
      lifecycleOperations: { activeTargets: new Set(), blocking: () => false },
      refreshAfterAdmission: async () => {},
      listThreads: async () => {},
    });
    const reopened = await recoveryBackend.loadProjectJournal(importedBinding.projectId);
    reopened.client = recoveryCore;
    reopened.connectionGeneration = 1;
    const beforeRecovery = reopened.pending.find(
      (entry) => entry.params.requestId === originalRequestId,
    );
    assert.deepEqual(beforeRecovery, pending[0], "new consumer loads actual old UNKNOWN unchanged");
    const recovered = await recoveryBackend.readSubmission(reopened, "areal/thread/start", {
      requestId: originalRequestId,
    });
    assert.equal(recovered.confirmed, true);
    assert.equal(recovered.accepted, true);
    assert.equal(
      recovered.result.threadId ?? recovered.result.thread?.id,
      legacyAccepted.result.thread.id,
    );
    assert.deepEqual(
      recoveryTrace.map((entry) => entry.method),
      ["areal/request/read"],
      "ordinary new consumer only queries original Core receipt",
    );
    assert.equal(recoveryTrace[0].params.requestId, originalRequestId);
    assert.deepEqual(
      recoveryTrace[0].params.creationAdmission,
      pending[0].params.creationAdmission,
    );
    assert.equal(
      reopened.pending.some((entry) => entry.params.requestId === originalRequestId),
      false,
    );
    assert.equal(reopened.outcomes[originalRequestId].threadId, legacyAccepted.result.thread.id);
    const threadsAfter = await recoveryCore.request("thread/list", { limit: 100 });
    assert.equal(threadsAfter.nextCursor, null);
    const newThreadIds = threadsAfter.data
      .map((thread) => thread.id)
      .filter((id) => !originalThreadIds.includes(id));
    assert.deepEqual(
      newThreadIds,
      [legacyAccepted.result.thread.id],
      "accepted create has exactly one thread side effect",
    );
    const legacyTrace = (await readFile(legacyTracePath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      legacyTrace.filter(
        (entry) => entry.direction === "request" && entry.method === "areal/thread/start",
      ).length,
      1,
      "old Desktop dispatched create exactly once",
    );
    assert.equal(
      recoveryTrace.filter((entry) => entry.method === "areal/thread/start").length,
      0,
      "upgrade recovery dispatches zero creates",
    );
    for (const id of ids)
      for (const suffix of ["-pending.json", "-outcomes.json"])
        assert.equal(
          sha(await readFile(join(coreHome, id + suffix))),
          after[id + suffix],
          "new consumer recovery preserves old journal fences",
        );
    await save(join(root, "accepted-create-recovery.json"), {
      originalRequestId,
      admission: pending[0].params.creationAdmission,
      threadId: legacyAccepted.result.thread.id,
      originalThreadIds,
      newThreadIds,
      legacyTrace,
      recoveryTrace,
      recovered,
      oldCreateDispatches: 1,
      newCreateDispatches: 0,
    });
    for (const item of electronEvidence) {
      const records = (await readFile(item.evidence, "utf8")).trim().split("\n").map(JSON.parse);
      assert(records.some((record) => record.phase === "before-load"));
      assert(records.some((record) => record.phase === "after-load"));
      if (["secure-fixture", "legacy-before", "import"].includes(item.name))
        assert(records.some((record) => record.phase === "ready"));
      assert(
        records.every((record) => record.appName === appName && record.realSafeStorageReferences),
      );
      item.sha256 = sha(await readFile(item.evidence));
    }
    passedResult = {
      state: "passed",
      scope: "isolated real Electron safeStorage and actual pre-migration Desktop reverse startup",
      legacySourceCommit: legacyManifest.commit,
      legacySourceManifest: join(legacyApp, "..", "source-manifest.json"),
      executionSources: {
        hostBinary: { path: binary, sha256: sha(await readFile(binary)) },
        hostClient: sha(await readFile(join(gui, "app/src/core/host-client.cjs"))),
        guiSource: sha(await readFile(join(gui, "app/src/core/gui-source.cjs"))),
        backend: sha(await readFile(join(gui, "app/src/core/backend.cjs"))),
        coreClient: sha(await readFile(join(gui, "packages/runtime-client/core.js"))),
        handoffScript: sha(await readFile(fileURLToPath(import.meta.url))),
      },
      source,
      hostHome,
      configHome,
      requestId,
      keychainIdentity: identity,
      identityEvidence: electronEvidence,
      keychainCleanup: cleanupPath,
      migrationId: result.migrationId,
      checks: [
        "real legacy Desktop starts before migration",
        "old Desktop opens two real projects and its lifecycle persists exact Runtime cleanup receipts",
        "existing singleton acquired before import",
        "metadata-only lookup proves exact native safeStorage identity exists",
        "two importer SIGKILL interruptions restart the same request with original credential receipt",
        "restarted dummy credential is readable and its source and backups are retired",
        "real old Desktop accepted create loses socket response before CoreClient",
        "ordinary new consumer recovers original Core receipt with zero create dispatches and one thread",
        "controlled import completes credential retirement before returning ready",
        "registry and Store bytes retained",
        "journal fences cover absent files",
        "actual old creation UNKNOWN and original admission identity retained",
        "new Host journal writer commits over 1 MiB alongside imported UNKNOWN",
        "actual old Desktop rejects fences without authority changes",
      ],
      interruptionEvidence: join(root, "migration-interruptions.json"),
      credentialRecovery: join(root, "credential-recovery.json"),
      acceptedCreateRecovery: join(root, "accepted-create-recovery.json"),
      excluded: [
        "real credentials",
        "signed package/Keychain identity",
        "full H2 consumer migration",
        "GUI/TUI active Turn handoff",
        "full crash-window matrix",
      ],
    };
  } catch (error) {
    await save(join(root, "integration-failure.json"), {
      message: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    legacyConnection.close();
    recoveryCore?.close();
    recoveryHost?.close();
    if (recoveryBackend) {
      recoveryBackend.closing = true;
      for (const project of recoveryBackend.projects.values())
        clearTimeout(project.reconciliation?.timer);
    }
    for (const { name, process } of processes.filter((item) => item.name !== "host")) {
      try {
        if (process.child.exitCode == null && process.child.signalCode == null) {
          process.child.stdio[3]?.destroy();
          process.child.kill("SIGTERM");
          const force = setTimeout(() => process.child.kill("SIGKILL"), 5000);
          try {
            await process.finish();
          } finally {
            clearTimeout(force);
          }
        } else {
          await process.finish();
        }
        cleanup.processes.push({ name, pid: process.child.pid, ...(await process.finish()) });
      } catch (error) {
        cleanup.errors.push({ process: name, message: error.message });
      }
    }
    cleanup.hosts = [];
    for (const home of [legacyServiceHome, hostHome]) {
      try {
        const bytes = await optional(join(home, "host/host.json"));
        if (!bytes) continue;
        const descriptor = JSON.parse(bytes);
        assert.equal(descriptor.socketPath, join(home, "host/control.sock"));
        assert(Number.isInteger(descriptor.pid) && descriptor.pid > 0);
        const host = new HostClient();
        try {
          await host.connect(home);
          assert.equal(host.hostId, descriptor.hostId);
          assert.equal(host.generation, descriptor.generation);
          const stopped = await host.stop(randomUUID(), descriptor.generation, "cancel");
          assert.equal(stopped.state, "completed", "test Host stop completes");
          await until(() => {
            try {
              process.kill(descriptor.pid, 0);
              return false;
            } catch (error) {
              if (error.code === "ESRCH") return true;
              throw error;
            }
          }, "test Host PID exit");
          cleanup.hosts.push({
            home,
            pid: descriptor.pid,
            hostId: descriptor.hostId,
            generation: descriptor.generation,
            stopped,
            pidExited: true,
          });
        } finally {
          host.close();
        }
      } catch (error) {
        cleanup.errors.push({ operation: "host.stop", home, message: error.message });
      }
    }
    for (const { name, process } of processes.filter((item) => item.name === "host")) {
      try {
        if (process.child.exitCode == null && process.child.signalCode == null) {
          process.child.kill("SIGTERM");
          const force = setTimeout(() => process.child.kill("SIGKILL"), 5000);
          try {
            await process.finish();
          } finally {
            clearTimeout(force);
          }
        }
        cleanup.processes.push({ name, pid: process.child.pid, ...(await process.finish()) });
      } catch (error) {
        cleanup.errors.push({ process: name, message: error.message });
      }
    }
    try {
      const database = join(coreHome, "diagnostics/desktop-crashes");
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
      const helpers = rows
        .split("\n")
        .map((row) =>
          /^\s*(\d+)\s+(\S+\/Electron\.app\/Contents\/Frameworks\/Electron Framework\.framework\/Helpers\/chrome_crashpad_handler) (.*)$/.exec(
            row,
          ),
        )
        .filter(Boolean)
        .filter((row) => row[3].split(" ").includes(`--database=${database}`));
      cleanup.crashpad = [];
      for (const helper of helpers) {
        const pid = Number(helper[1]);
        process.kill(pid, "SIGTERM");
        await until(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if (error.code === "ESRCH") return true;
            throw error;
          }
        }, "test crashpad exit");
        cleanup.crashpad.push({ pid, database, state: "stopped" });
      }
    } catch (error) {
      cleanup.errors.push({ operation: "crashpad cleanup", message: error.message });
    }
    try {
      assert.equal(identity.appName, `AReaL H2 SafeStorage Test ${runId}`);
      assert.equal(identity.service, identity.appName + " Safe Storage");
      assert.equal(identity.account, identity.appName + " Key");
      assert.equal(identity.hostService, "org.areal.host.v1." + sha(hostHome));
      if (safeStorageStarted)
        await cleanEntry(identity.service, identity.account, safeStorageKeychain);
      else
        cleanup.entries.push({
          service: identity.service,
          account: identity.account,
          state: "not-started",
        });
    } catch (error) {
      cleanup.errors.push({
        service: identity.service,
        account: identity.account,
        message: error.message,
      });
    }
    const entries = new Set();
    try {
      const receiptPath = join(hostHome, "host/imports", requestId, "record.json");
      const bytes = await optional(receiptPath);
      cleanup.hostReceipt = { path: receiptPath, sha256: bytes && sha(bytes) };
      if (bytes) {
        const receipt = JSON.parse(bytes);
        assert.equal(receipt.requestId, requestId);
        assert.deepEqual(receipt.source, source);
        cleanup.hostReceipt.entryIds = receipt.vaultReceipts.map((entry) => entry.entryId);
        for (const entryId of cleanup.hostReceipt.entryIds) entries.add(entryId);
      }
    } catch (error) {
      cleanup.errors.push({ service: identity.hostService, message: error.message });
    }
    try {
      const directory = join(hostHome, "host/vault-operations");
      const names = await readdir(directory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      cleanup.hostOperations = [];
      for (const name of names) {
        const path = join(directory, name);
        const bytes = await readFile(path);
        const receipt = JSON.parse(bytes);
        assert.equal(name, receipt.requestId + ".json");
        assert.equal(receipt.method, "vault.replace");
        cleanup.hostOperations.push({ path, sha256: sha(bytes), entryId: receipt.entryId });
        entries.add(receipt.entryId);
      }
    } catch (error) {
      cleanup.errors.push({ service: identity.hostService, message: error.message });
    }
    for (const entryId of entries) {
      try {
        assert.match(
          entryId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        await cleanEntry(identity.hostService, entryId);
      } catch (error) {
        cleanup.errors.push({
          service: identity.hostService,
          account: entryId,
          message: error.message,
        });
      }
    }
    for (const item of cleanup.entries.filter((entry) => entry.state === "pending"))
      item.state = "failed";
    cleanup.state = cleanup.errors.length ? "failed" : "completed";
    await save(cleanupPath, cleanup);
    for (const [name, expected] of Object.entries(legacyManifest.sha256))
      assert.equal(
        sha(await readFile(join(legacyApp, "..", name))),
        expected,
        `immutable legacy source ${name}`,
      );
    assert.equal(
      cleanup.state,
      "completed",
      `test Keychain cleanup incomplete; inspect ${cleanupPath}`,
    );
    if (passedResult)
      await save(join(root, "result.json"), { ...passedResult, cleanupState: cleanup.state });
  }
}
console.log("Shared Host source handoff evidence", root);
try {
  if (process.argv.includes("--unit")) await unit();
  else await integration();
  await save(join(root, "active-resources.json"), process.getActiveResourcesInfo());
  console.log("PASS", join(root, "result.json"));
} catch (error) {
  await save(join(root, "failure.json"), {
    state: "failed",
    message: error.message,
    stack: error.stack,
  });
  throw error;
}
