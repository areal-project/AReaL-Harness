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
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
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
  evidence.hostPid = child.pid;
  let identity;
  t.after(async () => {
    try {
      await Promise.all(instances.map((remote) => remote.close()));
      source.close();
      if (identity) {
        if (evidence.ensure) {
          const original = evidence.ensure.reference;
          await until(async () => {
            const { operation } = await host.operation(original.requestId);
            evidence.ensure.operation = operation ?? null;
            assert.ok(operation, `UNKNOWN original ensure ${original.requestId}; no replay`);
            assert.equal(operation.requestId, original.requestId);
            assert.equal(operation.hostId, original.hostId);
            assert.equal(operation.generation, original.generation);
            assert.equal(operation.projectId, original.projectId);
            return ["completed", "blocked"].includes(operation.state);
          }, "original project ensure settlement before fixture stop");
        }
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
      if (child.exitCode === null && child.signalCode === null) {
        evidence.cleanupRequired =
          "Owned Host remains alive; inspect the recorded original operation IDs without replay";
        child.unref();
      }
      await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
      t.diagnostic(`native Host evidence: ${join(root, "evidence.json")}`);
    }
  });
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  t.diagnostic(`native Host startup evidence: ${join(root, "evidence.json")}`);
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

// 原限额用例需要真实 Core 的 Thread 身份；此客户端只做本地种子和权威读取。
export async function nativeCoreProject(t, fixture, { approval = false } = {}) {
  const { createServer } = await import("node:http");
  const { connect } = await import("../../../examples/desktop-api/client.mjs");
  const { respondToSessionName } = await import("../../../scripts/model-fixture.mjs");
  const root = fixture.evidence.root;
  const workspace = join(root, "Project"),
    user = join(root, "user"),
    scratch = join(root, "scratch");
  for (const directory of [workspace, user, scratch])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const projectId = randomUUID();
  const alias = digest(`host:${projectId}`).slice(0, 24);
  const binding = { projectId, dataDir: join(root, "state") };
  await fixture.client.registerProject(randomUUID(), {
    projectId,
    workspace,
    dataDir: binding.dataDir,
    source: { kind: "cli" },
    defaultBinding: false,
  });
  const modelRequests = [];
  const model = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    modelRequests.push({
      stream: body.stream === true,
      roles: (body.messages ?? []).map((message) => message.role),
    });
    if (respondToSessionName(body, response)) return;
    const delta =
      approval && !(body.messages ?? []).some((message) => message.role === "tool")
        ? {
            tool_calls: [
              {
                index: 0,
                id: "native-overlap-write",
                type: "function",
                function: {
                  name: "fs_create",
                  arguments: JSON.stringify({ path: "approved.txt", text: "approved once" }),
                },
              },
            ],
          }
        : { content: "NATIVE_REMOTE_FIXTURE" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  });
  const configPath = join(root, "config.toml"),
    deploymentPath = join(root, "deployment.json");
  await writeFile(
    configPath,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
  );
  await writeFile(
    deploymentPath,
    JSON.stringify({
      profiles: [
        {
          id: "fixture",
          revision: "v1",
          displayName: "Native Remote fixture",
          instructions: "Complete the requested task.",
          ...(approval ? { approvalTools: ["fs_create"] } : {}),
        },
      ],
    }),
  );
  const reference = {
    requestId: randomUUID(),
    hostId: fixture.client.hostId,
    generation: fixture.client.generation,
    projectId: binding.projectId,
  };
  fixture.evidence.ensure = { reference };
  await writeFile(join(root, "ensure-reference.json"), JSON.stringify(reference, null, 2));
  const ensured = await fixture.client.ensureProject(reference.requestId, binding.projectId, {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    configPath,
    deploymentPath,
    environment: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost" },
    credentialNames: [],
    options: {
      workspace,
      data_dir: binding.dataDir,
      scratch,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  });
  fixture.evidence.ensure.result = ensured;
  assert.equal(ensured.project.state, "ready");
  const core = await connect(ensured.service.endpoint, ensured.service.authFile);
  t.after(() => core.close());
  fixture.evidence.service = ensured.service;
  const original = new Set(
    (await core.call("thread/list", { limit: 100 })).data.map((thread) => thread.id),
  );
  return {
    alias,
    workspace,
    projectId: binding.projectId,
    service: ensured.service,
    core,
    modelRequests,
    async readAttention() {
      const refs = [];
      let cursor;
      for (let page = 0; page < 32; page++) {
        const result = await core.call("areal/work/overview", {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const row of result.data) refs.push(...row.attentionRefs);
        if (!result.nextCursor) return refs;
        cursor = result.nextCursor;
      }
      throw new Error("Native attention fixture exceeded the public page bound");
    },
    async createApproval() {
      assert.equal(approval, true, "the original profile must require fs_create approval");
      const threadRequestId = randomUUID(),
        turnRequestId = randomUUID();
      const created = await core.call("areal/thread/start", {
        requestId: threadRequestId,
        cwd: workspace,
        agentProfile: { id: "fixture", revision: "v1" },
      });
      const threadId = created.thread.id;
      const started = await core.call("areal/turn/start", {
        requestId: turnRequestId,
        threadId,
        input: [
          { type: "text", text: "PRIVATE_PUSH_APPROVAL: create approved.txt with approved once." },
        ],
        expectedConfigRevision: 1,
      });
      let interaction;
      await until(async () => {
        interaction = (await core.call("areal/interaction/list", { threadId })).data.find(
          (item) =>
            item.turnId === started.turn.id &&
            item.kind === "approval" &&
            item.status === "pending",
        );
        return interaction;
      }, "real Core pending approval");
      let attention;
      await until(async () => {
        attention = (await this.readAttention()).find(
          (item) =>
            item.threadId === threadId &&
            item.turnId === started.turn.id &&
            item.interactionId === interaction.requestId,
        );
        return attention;
      }, "real Core overview approval reference");
      return {
        threadRequestId,
        turnRequestId,
        threadId,
        turnId: started.turn.id,
        interactionId: interaction.requestId,
        argumentsDigest: interaction.argumentsDigest,
        attentionRef: attention.attentionRef,
      };
    },
    async denyApproval(target) {
      await core.call("areal/interaction/respond", {
        requestId: target.interactionId,
        threadId: target.threadId,
        turnId: target.turnId,
        argumentsDigest: target.argumentsDigest,
        decision: "deny",
      });
      await until(async () => {
        const result = await core.call("thread/read", {
          threadId: target.threadId,
          includeTurns: true,
        });
        return result.thread.turns.some(
          (turn) => turn.id === target.turnId && turn.status !== "inProgress",
        );
      }, "original approval turn terminal after explicit fixture denial");
    },
    starts: async () =>
      (await core.call("thread/list", { limit: 100 })).data.filter(
        (thread) => !original.has(thread.id),
      ).length,
  };
}
