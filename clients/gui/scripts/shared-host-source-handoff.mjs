import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("../app/src/core/host-client.cjs");
const { GuiSourceAdapter, assertLegacySourceWritable } = require("../app/src/core/gui-source.cjs");
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
    return exit;
  });
  return { child, done, finish: () => done };
}
async function integration() {
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
  const electron = require("electron");
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
    HOME: join(root, "user"),
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
  const pending = [
    {
      method: "thread/create",
      params: {
        requestId: originalRequestId,
        creationAdmission: {
          identity: "isolated-original-identity",
          journalEpoch: randomUUID(),
          coreInstanceId: randomUUID(),
        },
        input: [{ type: "text", text: "Preserve original UNKNOWN submission" }],
      },
      operationId: "original-remote-operation",
      remote: {
        method: "thread/create",
        capability: "thread.create",
        semanticDigest: sha("original semantics"),
        target: { hostId: "original-noise-host", projectId: ids[0] },
      },
      unknownSourceExtension: { retained: true },
    },
  ];
  const outcomes = {
    [originalRequestId]: {
      method: "thread/create",
      status: "unknown",
      operationId: "original-remote-operation",
      remote: pending[0].remote,
    },
  };
  await save(join(coreHome, "cloud.json"), { syntheticClientOnly: true });
  const fixtureEntry = join(root, "secure-fixture.cjs");
  await writeFile(
    fixtureEntry,
    `const {app,safeStorage}=require("electron");const {writeFileSync}=require("node:fs");app.setName("AReaL Harness GUI");app.setPath("userData",process.env.AREAL_GUI_USER_DATA);app.whenReady().then(()=>{if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==="basic_text")throw Error("secure storage unavailable");writeFileSync(${JSON.stringify(join(coreHome, "provider-credentials.json"))},JSON.stringify({keys:{AREAL_CREDENTIAL_disabled:safeStorage.encryptString("isolated-dummy-key").toString("base64")},migrated:[]}),{mode:384});app.exit(0)}).catch(e=>{console.error(e.message);app.exit(1)});`,
  );
  const fixture = launch(electron, [fixtureEntry], env, "secure-fixture");
  assert.equal((await fixture.finish()).code, 0, "real Electron safeStorage fixture");
  const old = launch(electron, [legacyApp, "--areal-core-service"], env, "legacy-before", true);
  let host, importer, reverse, stopper;
  const legacyConnection = new ServiceConnection();
  try {
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
    legacyConnection.close();
    stopper = launch(electron, [legacyApp, "--areal-core-service-stop"], env, "legacy-stop");
    assert.equal(
      (await stopper.finish()).code,
      0,
      "original Desktop lifecycle must settle its Cores",
    );
    assert.equal((await old.finish()).code, 0);
    for (const { directory, descriptor } of originalServices) {
      const receipts = await Promise.all(
        (await readdir(join(directory, "operations"))).map(async (name) =>
          JSON.parse(await readFile(join(directory, "operations", name), "utf8")),
        ),
      );
      assert(
        receipts.some(
          (receipt) =>
            receipt.operation.state === "completed" &&
            receipt.operation.generation === descriptor.generation &&
            receipt.operation.serviceId === descriptor.serviceId &&
            receipt.cleanupConfirmed === true &&
            receipt.service.owner.appRunId === descriptor.owner.appRunId,
        ),
        "original owner persisted exact completed Runtime cleanup proof",
      );
    }
    await save(join(root, "original-services.json"), originalServices);
    await save(join(coreHome, ids[0] + "-pending.json"), pending);
    await save(join(coreHome, ids[0] + "-outcomes.json"), outcomes);
    const original = await tree(coreHome);
    await save(join(root, "original-authority.json"), original);
    host = launch(binary, ["host", "run"], { ...env, AREAL_HARNESS_HOME: hostHome }, "host");
    await until(() => optional(join(hostHome, "host", "host.json")), "shared Host descriptor");
    const requestId = randomUUID(),
      requestPath = join(root, "import-request.json"),
      resultPath = join(root, "import-result.json");
    await save(requestPath, { requestId, source, hostHome, resultPath });
    importer = launch(
      electron,
      [join(gui, "app"), "--areal-core-service", `--areal-host-import-source=${requestPath}`],
      env,
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
      const binding = result.receipt.bindings.find(
        (entry) => entry.alias.legacyProjectId === ids[0],
      );
      assert(binding, "Host publishes original project alias");
      const journal = hostClient.journal(binding.projectId);
      const imported = await journal.read();
      assert.deepEqual(
        imported.snapshot.pending,
        pending,
        "original params/admission/Remote IDs retained",
      );
      assert.deepEqual(imported.snapshot.outcomes, outcomes, "coexisting UNKNOWN outcome retained");
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
    reverse = launch(electron, [legacyApp, "--areal-core-service"], env, "legacy-after", true);
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
    await save(join(root, "result.json"), {
      state: "passed",
      scope: "isolated real Electron safeStorage and actual pre-migration Desktop reverse startup",
      legacySourceCommit: legacyManifest.commit,
      legacySourceManifest: join(legacyApp, "..", "source-manifest.json"),
      executionSources: {
        hostBinary: { path: binary, sha256: sha(await readFile(binary)) },
        hostClient: sha(await readFile(join(gui, "app/src/core/host-client.cjs"))),
        guiSource: sha(await readFile(join(gui, "app/src/core/gui-source.cjs"))),
        handoffScript: sha(await readFile(fileURLToPath(import.meta.url))),
      },
      source,
      hostHome,
      configHome,
      requestId,
      migrationId: result.migrationId,
      checks: [
        "real legacy Desktop starts before migration",
        "old Desktop opens two real projects and its lifecycle persists exact Runtime cleanup receipts",
        "existing singleton acquired before import",
        "dummy safeStorage credential imported",
        "registry and Store bytes retained",
        "journal fences cover absent files",
        "original request/admission/Remote identities and coexisting UNKNOWN retained",
        "new Host journal writer commits over 1 MiB alongside imported UNKNOWN",
        "actual old Desktop rejects fences without authority changes",
      ],
      excluded: [
        "real credentials",
        "signed package/Keychain identity",
        "full H2 consumer migration",
        "GUI/TUI active Turn handoff",
        "crash-window matrix",
        "real accepted creation with a lost response; imported UNKNOWN records are preservation fixtures",
      ],
    });
  } finally {
    legacyConnection.close();
    for (const process of [old, stopper, importer, reverse, host].filter(Boolean)) {
      if (process.child.exitCode == null && process.child.signalCode == null) {
        process.child.kill("SIGTERM");
        await process.finish();
      }
    }
  }
}
console.log("Shared Host source handoff evidence", root);
try {
  if (process.argv.includes("--unit")) await unit();
  else await integration();
  console.log("PASS", join(root, "result.json"));
} catch (error) {
  await save(join(root, "failure.json"), {
    state: "failed",
    message: error.message,
    stack: error.stack,
  });
  throw error;
}
