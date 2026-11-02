import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { connect } from "../examples/desktop-api/client.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const execute = promisify(execFile);
const repository = await realpath(new URL("..", import.meta.url).pathname);
const require = createRequire(join(repository, "clients/gui/app/package.json"));
const { HostClient } = require("../app/src/core/host-client.cjs");
const prefix = resolve(process.env.AREAL_UPDATE_PREFIX);
const mode = process.env.AREAL_UPDATE_CASE ?? "main";
assert(
  [
    "main",
    "prepare-red",
    "prepare-recovery",
    "prepare-existing-recovery",
    "apply-registration-red",
    "apply-registration-recovery",
    "startup-failure",
  ].includes(mode),
);
const oldBinary = join(prefix, "lib/areal/0.1.8-macos-arm64/bin/areal");
const newBinary = join(prefix, "lib/areal/0.1.9-macos-arm64/bin/areal");
const entry = join(prefix, "bin/areal");
const root = await realpath(await mkdtemp("/private/tmp/ah-update-run-"));
const home = join(root, "home");
const resultPath = join(root, "result.json");
const env = {
  ...process.env,
  HOME: join(root, "user"),
  AREAL_HARNESS_HOME: home,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  OTEL_SDK_DISABLED: "true",
};
const evidence = {
  root,
  prefix,
  mode,
  resultPath,
  checks: [],
  operations: [],
  cleanup: [],
  modelRequests: [],
  excluded: ["system service manager", "real provider", "Electron GUI", "signed package"],
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const clients = [];
let child, core, identity, pendingStop, pendingApply, held, modelFailure, failure;
let hostOutput = "",
  hostError = "";
const model = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (respondToSessionName(input, response)) return;
    const original = input.messages.some(
      (message) => message.role === "user" && message.content === "H4_UPDATE_BUSY_BARRIER",
    );
    evidence.modelRequests.push({ original, model: input.model });
    const reply = () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Update fixture complete" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    if (original) {
      assert(!held, "original Solve must not be replayed");
      held = reply;
    } else reply();
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});
async function save() {
  await writeFile(resultPath, JSON.stringify(evidence, null, 2) + "\n");
}
async function until(read, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (modelFailure) throw modelFailure;
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${message}`);
}
async function cli(args, binary = oldBinary) {
  const { stdout } = await execute(binary, args, {
    env,
    cwd: root,
    timeout: 90000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function hostClient() {
  const client = new HostClient();
  await client.connect(home);
  clients.push(client);
  return client;
}
async function descriptor() {
  try {
    return JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function operation(requestId) {
  return (await cli(["host", "operation", requestId, "--json"])).operation;
}
async function pointAt(binary) {
  const temporary = `${entry}.${randomUUID()}`;
  await symlink(binary, temporary);
  await rename(temporary, entry);
}
async function prepare(host) {
  const requestId = randomUUID();
  const receipt = await host.request("host.update", {
    requestId,
    expectedGeneration: host.generation,
    action: "prepare",
    targetVersion: "0.1.9",
  });
  evidence.operations.push(receipt);
  assert.equal(receipt.state, "prepared");
  return receipt;
}
async function stopOriginal() {
  const live = await descriptor();
  if (!live) return;
  assert.equal(live.hostId, identity.hostId);
  if (pendingApply) {
    const receipt = await operation(pendingApply);
    evidence.cleanup.push({ originalApply: pendingApply, receipt });
    if (!receipt || !["completed", "blocked"].includes(receipt.state))
      throw new Error("Original apply remains UNKNOWN; no cleanup stop was submitted");
  }
  const host = await hostClient();
  pendingStop = {
    requestId: randomUUID(),
    expectedGeneration: host.generation,
    strategy: "ifIdle",
  };
  evidence.pendingStop = pendingStop;
  await save();
  try {
    evidence.cleanup.push({ stop: await host.request("host.stop", pendingStop) });
  } catch (error) {
    evidence.cleanup.push({ stopError: error.message, request: pendingStop });
  }
  const receipt = await until(async () => {
    const value = await operation(pendingStop.requestId);
    return value?.state === "completed" && value;
  }, "original cleanup stop completed");
  evidence.cleanup.push({ originalStop: receipt });
  await until(async () => !(await descriptor()), "Host descriptor removed");
  const exit = await until(
    () => child.exitCode !== null && { code: child.exitCode, signal: child.signalCode },
    "original Host process exit",
  );
  assert.equal(exit.code, 0);
  evidence.cleanup.push({ hostExit: exit });
}
try {
  for (const path of [home, env.HOME, join(prefix, "bin")])
    await mkdir(path, { recursive: true, mode: 0o700 });
  evidence.artifacts = [];
  for (const binary of [oldBinary, newBinary]) {
    const info = JSON.parse(
      (await execute(binary, ["build-info"], { env, timeout: 15000 })).stdout,
    );
    const version = (await execute(binary, ["--version"], { env, timeout: 15000 })).stdout.trim();
    evidence.artifacts.push({
      binary,
      info,
      version,
      sha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    });
  }
  assert.notEqual(evidence.artifacts[0].sha256, evidence.artifacts[1].sha256);
  assert.equal(evidence.artifacts[0].version, "areal 0.1.8");
  assert.equal(evidence.artifacts[1].version, "areal 0.1.9");
  await pointAt(oldBinary);
  child = spawn(entry, ["host", "run"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (bytes) => {
    hostOutput += bytes;
  });
  child.stderr.on("data", (bytes) => {
    hostError += bytes;
  });
  identity = await until(async () => {
    const value = await descriptor();
    return value?.pid === child.pid && value;
  }, "original Host");
  evidence.before = identity;
  await save();
  console.log(JSON.stringify({ root, mode, resultPath, hostPid: identity.pid }));
  await pointAt(newBinary);
  const host = await hostClient();
  if (mode === "startup-failure") {
    const directory = join(home, "host/subscription-owners");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "fixture.json"), "{}\n", { mode: 0o600 });
    await prepare(host);
    pendingApply = randomUUID();
    evidence.pendingApply = {
      requestId: pendingApply,
      hostId: host.hostId,
      generation: host.generation,
    };
    await save();
    try {
      evidence.operations.push(
        await host.request("host.update", {
          requestId: pendingApply,
          expectedGeneration: host.generation,
          action: "apply",
          targetVersion: "0.1.9",
          strategy: "ifIdle",
        }),
      );
    } catch (error) {
      evidence.applyResponseError = error.message;
    }
    const exit = await until(
      () => child.exitCode !== null && { code: child.exitCode, signal: child.signalCode },
      "new Host restore failure",
    );
    assert.equal(exit.code, 1);
    const original = await operation(pendingApply);
    assert.notEqual(original.state, "completed");
    const stop = await operation(original.stopRequestId);
    assert.equal(stop.state, "completed");
    assert.equal(await descriptor(), null);
    assert.match(hostError, /invalid subscription owner source/);
    evidence.operations.push(original, stop);
    evidence.cleanup.push({ expectedStartupFailure: exit, descriptorAbsent: true });
    evidence.checks.push(
      "failed target restore never reports the original apply completed before Host is available",
    );
  } else if (mode !== "main") {
    const previousPreparation =
      mode.startsWith("apply-") || mode === "prepare-existing-recovery"
        ? await prepare(host)
        : null;
    await mkdir(join(home, "host/operations"), { recursive: true, mode: 0o700 });
    await chmod(join(home, "host"), 0o500);
    const requestId = randomUUID();
    const action = mode.startsWith("apply-") ? "apply" : "prepare";
    try {
      await host.request("host.update", {
        requestId,
        expectedGeneration: host.generation,
        action,
        targetVersion: "0.1.9",
        ...(action === "apply" ? { strategy: "ifIdle" } : {}),
      });
    } catch (error) {
      evidence.prepareError = { code: error.code, message: error.message };
    }
    const receipt = await operation(requestId);
    evidence.operations.push(receipt);
    assert.equal(
      receipt.state,
      mode === "prepare-red"
        ? "prepared"
        : mode === "apply-registration-recovery" || mode === "prepare-existing-recovery"
          ? "blocked"
          : "acceptedPending",
    );
    if (action === "apply") {
      const original = JSON.parse(
        await readFile(
          join(
            home,
            "host/operations",
            `${createHash("sha256").update(requestId).digest("hex")}.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(original.evidence.stopDispatch, "notStarted");
      evidence.unsubmittedApply = original;
    }
    await chmod(join(home, "host"), 0o700);
    if (mode === "prepare-existing-recovery") {
      const pointer = JSON.parse(await readFile(join(home, "host/update.json"), "utf8"));
      assert.equal(pointer.prepareRequestId, previousPreparation.requestId);
      evidence.checks.push(
        "new preparation with failed registration settles blocked and preserves the previous pointer",
      );
    } else if (mode === "prepare-recovery") {
      const restored = await operation(requestId);
      assert.equal(restored.state, "prepared");
      const pointer = JSON.parse(await readFile(join(home, "host/update.json"), "utf8"));
      assert.equal(pointer.prepareRequestId, requestId);
      evidence.operations.push(restored);
      evidence.checks.push(
        "original prepare recovers registration using only its original receipt",
      );
    } else if (action === "apply") {
      assert.equal((await host.request("host.status", {})).stopIntent, false);
      evidence.checks.push(
        mode === "apply-registration-red"
          ? "RED: undispatched apply remains acceptedPending after registration failure"
          : "undispatched apply settles blocked by original lookup without any stop effect",
      );
    } else evidence.checks.push("RED: prepared receipt existed although pointer commit failed");
  } else {
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const workspace = join(root, "workspace"),
      dataDir = join(root, "project");
    await mkdir(workspace);
    await mkdir(dataDir);
    const config = join(root, "config.toml");
    await writeFile(
      config,
      `schema_version = 1\n[model]\nname = "update-fixture"\nmax_retries = 0\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n`,
    );
    const projectId = randomUUID();
    const ensureArgs = [
      "host",
      "ensure",
      "--json",
      "--project-id",
      projectId,
      "--workspace",
      workspace,
      "--data-dir",
      dataDir,
      "--config",
      config,
    ];
    const project = await cli(ensureArgs);
    evidence.service = project.service;
    core = await connect(project.service.endpoint, project.service.authFile);
    const thread = (
      await core.call("areal/thread/start", { requestId: randomUUID(), cwd: workspace })
    ).thread;
    const turnRequestId = randomUUID();
    await core.call("areal/turn/start", {
      requestId: turnRequestId,
      threadId: thread.id,
      input: [{ type: "text", text: "H4_UPDATE_BUSY_BARRIER" }],
    });
    await until(() => held, "original model request held");
    const prepared = await prepare(host);
    evidence.coreHostPending = await until(async () => {
      const value = await core.call("areal/host/status", {});
      return value?.hostId === identity.hostId && value.restartPending && value;
    }, "Core exposes authenticated Host pending state");
    assert.equal(evidence.coreHostPending.targetVersion, "0.1.9");
    evidence.cliPending = await cli(["host", "status", "--json"]);
    assert.equal(evidence.cliPending.restartPending, true);
    evidence.checks.push("CLI and authenticated Core client read the real Host pending version");
    await pointAt(oldBinary);
    const historic = await operation(prepared.requestId);
    assert.equal(historic.state, "prepared");
    await pointAt(newBinary);
    evidence.checks.push("historical prepared receipt stays prepared after stable entry changes");
    const busy = await host.request("host.update", {
      requestId: randomUUID(),
      expectedGeneration: host.generation,
      action: "apply",
      targetVersion: "0.1.9",
      strategy: "ifIdle",
    });
    evidence.operations.push(busy);
    assert.equal(busy.state, "blocked");
    assert.equal((await host.request("host.status", {})).stopIntent, false);
    assert.deepEqual(await descriptor(), identity);
    evidence.checks.push(
      "busy ifIdle refused before stop admission; original Host and Core work continue",
    );
    const unconfirmed = randomUUID();
    await assert.rejects(
      cli([
        "host",
        "update",
        "apply",
        "--target-version",
        "0.1.9",
        "--strategy",
        "cancel",
        "--request-id",
        unconfirmed,
        "--expected-generation",
        host.generation,
        "--json",
      ]),
      (error) => {
        evidence.unconfirmedCancel = { requestId: unconfirmed, stderr: error.stderr };
        return /requires --confirm-cancel/.test(error.stderr);
      },
    );
    assert.equal(await operation(unconfirmed), null);
    assert.equal((await host.request("host.status", {})).stopIntent, false);
    evidence.checks.push(
      "CLI cancel without second confirmation is rejected before stop admission",
    );
    held();
    const completed = await until(async () => {
      const value = (await core.call("areal/thread/observe", { threadId: thread.id })).thread;
      return value.turns[0]?.status === "completed" && value;
    }, "original Turn completed");
    evidence.originalTurn = {
      threadId: thread.id,
      turnRequestId,
      turns: completed.turns.map(({ id, status }) => ({ id, status })),
    };
    assert.equal(completed.turns.length, 1);
    await until(async () => {
      const value = await host.request("host.activity", {});
      return value.complete && value.projects.every((p) => p.state === "observed" && p.idleAllowed);
    }, "real Core idle");
    await prepare(host);
    pendingApply = randomUUID();
    evidence.pendingApply = {
      requestId: pendingApply,
      hostId: host.hostId,
      generation: host.generation,
    };
    await save();
    host.socket.removeAllListeners("data");
    const lostReply = host
      .request("host.update", {
        requestId: pendingApply,
        expectedGeneration: host.generation,
        action: "apply",
        targetVersion: "0.1.9",
        strategy: "ifIdle",
      })
      .then(
        () => {
          throw new Error("Lost-response client unexpectedly observed a reply");
        },
        (error) => {
          evidence.lostReply = error.message;
        },
      );
    await until(async () => await operation(pendingApply), "original apply persisted");
    host.close();
    await lostReply;
    const after = await until(async () => {
      const value = await descriptor();
      return (
        value?.generation !== identity.generation && value?.executableVersion === "0.1.9" && value
      );
    }, "new version after controlled exec");
    assert.equal(after.hostId, identity.hostId);
    assert.equal(after.pid, identity.pid);
    const settled = await until(async () => {
      const value = await operation(pendingApply);
      return value?.state === "completed" && value;
    }, "original apply completed after exec");
    assert.equal(settled.generation, identity.generation);
    evidence.after = after;
    evidence.operations.push(settled);
    evidence.checks.push(
      "idle update execs real new version with original PID and stable Host identity",
    );
    evidence.checks.push("lost apply reply settles only original ID across generation change");
    const reopened = await cli(ensureArgs, newBinary);
    evidence.reopenedService = reopened.service;
    core.close();
    core = await connect(reopened.service.endpoint, reopened.service.authFile);
    const history = (await core.call("areal/thread/observe", { threadId: thread.id })).thread;
    assert.deepEqual(
      history.turns.map(({ id, status }) => ({ id, status })),
      evidence.originalTurn.turns,
    );
    const pidPath = (
      await execute("/usr/bin/python3", [
        "-I",
        "-S",
        "-c",
        "import ctypes,sys\nb=ctypes.create_string_buffer(4096)\nn=ctypes.CDLL('/usr/lib/libproc.dylib').proc_pidpath(int(sys.argv[1]),b,len(b))\nassert n>0\nprint(b.value.decode())",
        String(reopened.service.corePid),
      ])
    ).stdout.trim();
    assert.equal(await realpath(pidPath), await realpath(newBinary));
    evidence.reopenedCore = {
      executable: pidPath,
      version: evidence.artifacts[1].version,
      build: evidence.artifacts[1].info,
      sha256: createHash("sha256")
        .update(await readFile(pidPath))
        .digest("hex"),
    };
    assert.equal(evidence.reopenedCore.sha256, evidence.artifacts[1].sha256);
    evidence.checks.push(
      "next project use starts real target-version Core and preserves original history",
    );
    assert.equal(evidence.modelRequests.filter((value) => value.original).length, 1);
    evidence.checks.push("original Solve has one model request and one completed Turn");
  }
} catch (error) {
  failure = error;
  evidence.failure = { message: error.message, stack: error.stack };
} finally {
  await chmod(join(home, "host"), 0o700).catch(() => {});
  core?.close();
  if (held && failure) {
    try {
      held();
    } catch {}
  }
  try {
    if (identity) await stopOriginal();
  } catch (error) {
    evidence.cleanupRequired = error.message;
    failure ??= error;
  }
  for (const client of clients) client.close();
  if (model.listening) {
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }
  if (evidence.service) {
    evidence.coreModelRequests = (
      await readFile(join(evidence.service.dataDir, "model-requests/requests.jsonl"), "utf8")
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (!failure) {
      try {
        const solves = evidence.coreModelRequests.filter((row) => row.purpose === "Solve");
        assert.equal(solves.length, 1);
        assert.equal(solves[0].httpAttempts, 1);
        assert.equal(solves[0].outcome, "completed");
      } catch (error) {
        failure = error;
        evidence.failure = { message: error.message };
      }
    }
  }
  evidence.hostOutput = hostOutput;
  evidence.hostError = hostError;
  evidence.passed = !failure;
  await save();
  console.log(JSON.stringify({ resultPath, passed: evidence.passed, checks: evidence.checks }));
}
if (failure) throw failure;
