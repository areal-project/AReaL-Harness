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
export async function nativeHostFixture(
  t,
  {
    config,
    deferNative = false,
    expectedUnknownSettlement,
    caseRoot,
    tlsHome = process.env.RC12_TLS_HOME,
  } = {},
) {
  assert.ok(
    process.platform !== "darwin" || process.env.AREAL_TEST_HOST_KEYCHAIN === "1",
    "Requires isolated synthetic Host vault authorization",
  );
  assert.ok(
    process.env.AREAL_CORE_BIN,
    "AREAL_CORE_BIN must identify the locked verification slot",
  );
  const binary = resolve(process.env.AREAL_CORE_BIN);
  const root = await realpath(caseRoot ?? (await mkdtemp(join(tmpdir(), "native-remote-host-"))));
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
  const startHost = async () => {
    const log = await open(join(root, "host.log"), "a", 0o600);
    const spawned = spawn(binary, ["host", "run"], {
      env: {
        ...process.env,
        ...(tlsHome ? { SSL_CERT_FILE: join(tlsHome, "ca.pem") } : {}),
        AREAL_HARNESS_HOME: home,
        AREAL_HARNESS_SERVICE_HOME: home,
      },
      stdio: ["ignore", "ignore", log.fd],
    });
    await log.close();
    evidence.hostPid = spawned.pid;
    return spawned;
  };
  let child = await startHost();
  let restartReference;
  let identity;
  let crashStopped = false;
  t.after(async () => {
    let phase = "remote-close";
    try {
      await Promise.all(instances.map((remote) => remote.close()));
      source.close();
      phase = "restart-receipt";
      if (restartReference) {
        const receipt = readHostReceipt(
          restartReference,
          (await host.operation(restartReference.requestId)).operation,
        );
        evidence.restartStopReceipt = receipt;
        assert.equal(
          receipt?.state,
          "completed",
          "original restart stop remains UNKNOWN; preserve fixture",
        );
      }
      phase = "successor-identity";
      if (!identity && evidence.restarts?.length && child.exitCode === null) {
        const current = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
        assert.equal(current.pid, child.pid);
        assert.equal(current.hostId, restartReference.hostId);
        host.close();
        await host.connect(home);
        assert.equal(host.hostId, current.hostId);
        assert.equal(host.generation, current.generation);
        identity = current;
        evidence.host = current;
      }
      if (!identity && evidence.crashes?.length && !crashStopped && child.exitCode === null) {
        const current = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
        const previous = evidence.crashes.at(-1).before;
        assert.equal(current.pid, child.pid);
        assert.equal(current.hostId, previous.hostId);
        assert.notEqual(current.generation, previous.generation);
        host.close();
        await host.connect(home);
        assert.equal(host.hostId, current.hostId);
        assert.equal(host.generation, current.generation);
        identity = current;
        evidence.host = current;
      }
      if (identity) {
        phase = "ensure-receipt";
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
        phase = "host-stop";
        const reference = expectedUnknownSettlement?.reference ?? {
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
        if (expectedUnknownSettlement?.reference) {
          assert.equal(expectedUnknownSettlement.businessAssertionsPassed, true);
          const {
            service,
            terminal,
            status,
            stopReceipt,
            target: originalTarget,
          } = expectedUnknownSettlement;
          const tool = terminal.items.find((item) => item.id === status.unresolvedTools[0].itemId);
          assert.equal(status.restartSafe, false);
          assert.equal(status.runtime.activeProcesses, 0);
          assert.equal(status.activeTasks, 0);
          assert.equal(status.pendingQueueItems, 0);
          for (const key of [
            "activeTurns",
            "activeGoals",
            "resources",
            "compactions",
            "workgroups",
          ])
            assert.deepEqual(status[key], []);
          assert.equal(terminal.id, originalTarget.expectedTurnId);
          assert.deepEqual(status.unresolvedTools, [
            { threadId: originalTarget.threadId, itemId: tool.id },
          ]);
          assert.equal(tool.execution.outcome, "unknown");
          assert.equal(tool.execution.inspection, undefined);
          assert(["blocked", "settlementIncomplete"].includes(stopReceipt.state));
          assert.equal(stopReceipt.projects.length, 1);
          const target = stopReceipt.projects[0];
          assert.equal(target.serviceId, service.serviceId);
          assert.equal(target.serviceGeneration, service.generation);
          assert.equal(target.receipt.lifecycle.executionOutcomes.uninspectedUnknown, 1);
          assert.equal(target.receipt.lifecycle.settled.allowed, false);
          assert.equal(reference.hostId, identity.hostId);
          assert.equal(reference.generation, identity.generation);
          assert.equal(stopReceipt.requestId, reference.requestId);
          assert.equal(stopReceipt.hostId, reference.hostId);
          assert.equal(stopReceipt.generation, reference.generation);
          receipt = readHostReceipt(
            reference,
            (await host.operation(reference.requestId)).operation,
          );
          assert.ok(receipt, "original UNKNOWN guard stop remains queryable");
          assert(["blocked", "settlementIncomplete"].includes(receipt.state));
          assert.equal(receipt.projects.length, 1);
          assert.equal(receipt.projects[0].requestId, target.requestId);
          assert.equal(receipt.projects[0].serviceId, target.serviceId);
          assert.equal(receipt.projects[0].serviceGeneration, target.serviceGeneration);
          assert.equal(
            receipt.projects[0].receipt.lifecycle.executionOutcomes.uninspectedUnknown,
            1,
          );
          assert.equal(receipt.projects[0].receipt.lifecycle.settled.allowed, false);
          for (const pid of [service.hostPid, service.corePid])
            assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
          const current = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
          assert.deepEqual(current, identity);
          const command = spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "command="], {
            encoding: "utf8",
          });
          assert.equal(command.status, 0);
          assert.equal(command.stdout.trim(), `${binary} host run`);
          assert.equal(digest(await readFile(binary)), evidence.binarySha256);
          observation.harnessTermination = {
            pid: child.pid,
            signal: "SIGTERM",
            productDrain: false,
            unknownAcknowledged: false,
          };
          assert.equal(child.kill("SIGTERM"), true);
        } else
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
        if (!observation.harnessTermination) assert.equal(receipt.state, "completed");
      }
      phase = "host-exit";
      await until(() => child.exitCode !== null || child.signalCode !== null, "owned Host exit");
      if (crashStopped) assert.equal(child.signalCode, "SIGKILL");
      else if (evidence.cleanup.some((entry) => entry.harnessTermination))
        assert(child.exitCode === 0 || child.signalCode === "SIGTERM");
      else assert.equal(child.exitCode, 0);
      phase = "synthetic-keychain-cleanup";
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
      phase = "binary-identity";
      assert.equal(
        digest(await readFile(binary)),
        evidence.binarySha256,
        "fixed binary remained unchanged",
      );
    } catch (error) {
      evidence.cleanupError = { phase, message: String(error) };
      throw error;
    } finally {
      for (const remote of instances) remote.storage.close();
      source.close();
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
  const restart = async () => {
    for (const remote of instances) await remote.close();
    const previous = structuredClone(identity);
    const oldChild = child;
    restartReference = {
      kind: "stopHost",
      requestId: randomUUID(),
      home,
      hostId: previous.hostId,
      generation: previous.generation,
      strategy: "ifIdle",
    };
    const observation = { reference: restartReference, before: previous };
    (evidence.restarts ??= []).push(observation);
    await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
    try {
      observation.receipt = readHostReceipt(
        restartReference,
        await host.stop(
          restartReference.requestId,
          restartReference.generation,
          restartReference.strategy,
        ),
      );
    } catch (error) {
      observation.error = { code: error.code, message: error.message };
      observation.receipt = await readOfflineHostReceipt(binary, restartReference);
    }
    assert.equal(
      observation.receipt?.state,
      "completed",
      "only query the original restart stop; no replay",
    );
    await until(
      () => oldChild.exitCode !== null || oldChild.signalCode !== null,
      "original Host naturally exits before restart",
    );
    assert.equal(oldChild.exitCode, 0);
    observation.originalExited = true;
    host.close();
    identity = undefined;
    delete evidence.host;
    child = await startHost();
    await until(async () => {
      assert.equal(child.exitCode, null);
      try {
        await host.connect(home);
        return true;
      } catch {
        host.close();
        return false;
      }
    }, "restarted Host authenticated startup");
    identity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
    assert.equal(identity.hostId, previous.hostId);
    assert.notEqual(identity.generation, previous.generation);
    assert.notEqual(identity.pid, previous.pid);
    evidence.host = identity;
    observation.after = identity;
    await source.reconnect();
    restartReference = null;
    const remote = await make();
    await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
    return remote;
  };
  const crashRestart = async (
    beforeRestart,
    terminate = () => assert.equal(child.kill("SIGKILL"), true),
  ) => {
    const previous = structuredClone(identity);
    assert.equal(child.pid, previous.pid);
    const current = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
    assert.deepEqual(current, previous);
    await terminate(child.pid);
    await until(() => child.exitCode !== null || child.signalCode !== null, "crashed Host exit");
    assert.equal(child.signalCode, "SIGKILL");
    const observation = { before: previous, originalExited: true, signal: "SIGKILL" };
    (evidence.crashes ??= []).push(observation);
    identity = undefined;
    delete evidence.host;
    crashStopped = true;
    host.close();
    try {
      await beforeRestart();
    } catch (error) {
      observation.beforeRestartError = String(error);
      throw error;
    }
    child = await startHost();
    crashStopped = false;
    await until(async () => {
      assert.equal(child.exitCode, null);
      try {
        await host.connect(home);
        return true;
      } catch {
        host.close();
        return false;
      }
    }, "crash successor authenticated startup");
    identity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
    assert.equal(identity.hostId, previous.hostId);
    assert.notEqual(identity.generation, previous.generation);
    assert.equal(identity.pid, child.pid);
    evidence.host = identity;
    observation.after = identity;
    await source.reconnect();
    return make();
  };
  const resumeOwnedHost = async (pid) => {
    assert.equal(child.pid, pid);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const current = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
    assert.deepEqual(current, identity);
    assert.equal(child.kill("SIGCONT"), true);
  };
  return {
    remote: deferNative ? null : await make(),
    make,
    restart,
    crashRestart,
    resumeOwnedHost,
    home,
    source,
    client: host,
    evidence,
    persisted: async () => (await host.request("remote.read", {})).config,
  };
}

// 原限额用例需要真实 Core 的 Thread 身份；此客户端只做本地种子和权威读取。
export async function nativeCoreProject(
  t,
  fixture,
  {
    approval = false,
    holdModel = false,
    effectModel = false,
    stopModel = false,
    taskModel = false,
    modelDisplayName,
  } = {},
) {
  const { createServer } = await import("node:http");
  const { connect } = await import("../../../examples/desktop-api/client.mjs");
  const { respondToSessionName } = await import("../../../scripts/model-fixture.mjs");
  const root = fixture.evidence.root;
  const workspace = join(root, "Project"),
    user = join(root, "user"),
    scratch = join(root, "scratch");
  for (const directory of [workspace, user, scratch])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  if (effectModel || stopModel || taskModel)
    await mkdir(join(workspace, "effects"), { mode: 0o700 });
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
  const modelRequests = [],
    heldResponses = [],
    taskModels = new Map();
  const model = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    modelRequests.push({
      stream: body.stream === true,
      roles: (body.messages ?? []).map((message) => message.role),
    });
    if (respondToSessionName(body, response)) return;
    const textMessages = (body.messages ?? []).flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.filter((part) => typeof part.text === "string").map((part) => part.text)
          : [],
    );
    const extractTaskContext = (prefix) =>
      textMessages
        .toReversed()
        .map((value) => {
          try {
            return JSON.parse(value.split(prefix)[1]);
          } catch {
            return null;
          }
        })
        .find(Boolean);
    const taskGoal = extractTaskContext("Current authoritative goal: ");
    const taskMarker =
      taskModel && String(taskGoal?.goal?.objective ?? "").match(/RC08_TASK:([a-f0-9-]{36})/);
    if (taskMarker) {
      const effect = taskMarker[1],
        text = taskGoal.goal.objective;
      const state = taskModels.get(effect) ?? { stage: 0, answered: false, reported: false };
      taskModels.set(effect, state);
      const goal = taskGoal;
      const channel = extractTaskContext("Current task channel: ");
      const answer = channel?.messages?.find((message) => message.kind === "reply")?.answers;
      let name, args;
      if (state.stage === 0) {
        name = "ask_user_question";
        args = {
          questions: text.includes("RC08_KEYS")
            ? ["Z", "a", "10", "2"].map((id) => ({
                id,
                title: `Original ${id}`,
                options: [],
                allowFreeText: true,
              }))
            : [
                {
                  id: "choice",
                  title: "Native Task choice",
                  options: ["A", "B"],
                  allowFreeText: false,
                },
                { id: "free", title: "Native Task free text", options: [], allowFreeText: true },
              ],
          mode: "async",
          required: !text.includes("RC08_TERMINAL"),
          timeoutSeconds: text.includes("RC08_EXPIRE") ? 1 : 600,
        };
        state.stage++;
      } else if (state.stage === 1) {
        name = "run_command";
        args = {
          command: `printf x >> '${join(workspace, "effects", effect + "-pending")}'; while [ ! -f '${join(workspace, "effects", effect + "-release")}' ]; do sleep 0.05; done; printf y >> '${join(workspace, "effects", effect + "-work")}'`,
          timeoutMs: 120000,
        };
        state.stage++;
      } else if (answer && !state.answered) {
        assert.ok(["A", "B"].includes(answer.choice ?? answer.Z));
        state.answered = true;
        modelRequests.push({
          effect,
          taskId: channel.taskId,
          runId: channel.runId,
          answers: answer,
        });
        name = "run_command";
        args = {
          command: `printf '${answer.choice ?? answer.Z}' >> '${join(workspace, "effects", effect + "-reply")}'`,
        };
      } else if (!answer && !text.includes("RC08_TERMINAL") && state.stage === 2) {
        name = "task_wait";
        args = {};
        state.stage++;
      } else if (!state.reported) {
        assert.ok(Number.isSafeInteger(goal?.revision), "native Task authoritative goal context");
        name = "goal_update";
        args = {
          expectedRevision: goal.revision,
          status: "complete",
          summary: "Task fixture complete",
          evidence: ["native Runtime useful work and original Channel checked"],
          remaining: [],
        };
        state.reported = true;
      }
      const delta = name
        ? {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { content: "RC08_DONE" };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    const messages = body.messages ?? [];
    const currentMessages = messages.slice(
      messages.findLastIndex((message) => message.role === "user"),
    );
    const input = JSON.stringify(currentMessages[0]?.content ?? null);
    const effect = effectModel && input.match(/RC05_EFFECT:([a-f0-9-]{36})/);
    const cleanup = stopModel && input.match(/RC06_CLEANUP:([a-f0-9-]{36})/);
    const hasTool = currentMessages.some((message) => message.role === "tool");
    const delta =
      (effect || cleanup) && !hasTool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "rc05-tool",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({
                    command: cleanup
                      ? `trap 'sleep 1; exit 0' TERM; printf ready >> '${join(workspace, "effects", cleanup[1])}'; while :; do sleep 1; done`
                      : `printf x >> '${join(workspace, "effects", effect[1])}'`,
                  }),
                },
              },
            ],
          }
        : approval && !messages.some((message) => message.role === "tool")
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
    const release = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    if (!holdModel || cleanup || (effect && hasTool)) return release();
    const held = {
      inputSha256: digest(input),
      released: false,
      matches: (text) => input.includes(text),
      release() {
        assert.equal(this.released, false, "the original model response is released once");
        assert.equal(response.destroyed, false, "the original Core model request remains open");
        this.released = true;
        release();
      },
    };
    heldResponses.push(held);
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
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n${modelDisplayName === undefined ? "" : `models=[{id="fixture",display_name=${JSON.stringify(modelDisplayName)}}]\n`}`,
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
    async waitForModel(text) {
      assert.equal(holdModel, true, "the fixture must explicitly hold model responses");
      let held;
      await until(
        () => (held = heldResponses.find((entry) => entry.matches(text))),
        "the exact original Core model request",
      );
      return { inputSha256: held.inputSha256, release: () => held.release() };
    },
    modelResponseEvidence: () =>
      heldResponses.map(({ inputSha256, released }) => ({
        inputSha256,
        released,
      })),
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
