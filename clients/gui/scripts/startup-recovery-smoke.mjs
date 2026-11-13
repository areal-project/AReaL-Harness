import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { DesktopService } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const { executeCore } = createRequire(import.meta.url)("./support/core-process-fixture.cjs");
const {
  readLifecycleReceipt,
  reconcileLifecycleReceipt,
} = require("@areal/workbench-service/desktop/core/lifecycle-operations.cjs");
const scratch = await makeTempDir("areal-startup-recovery-");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const checks = [],
  held = new Set();
let backend,
  service,
  passed = false,
  exitRequests = 0;
const options = {
  binary,
  home: join(scratch, "core"),
  harnessHome: join(scratch, "registry"),
  userHome: join(scratch, "user"),
};
const workspace = join(scratch, "workspace");
const tracePath = join(scratch, "cli-requests.jsonl");
const wrapper = join(scratch, "controlled-core.cjs");
const controlPath = join(scratch, "control.json");
const model = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Lifecycle fixture is running." }, finish_reason: null }] })}\n\n`,
  );
  held.add(response);
  response.on("close", () => held.delete(response));
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await mkdir(workspace);
await mkdir(join(options.userHome, ".areal"), { recursive: true });
await writeFile(
  join(options.userHome, ".areal/config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
await writeFile(controlPath, "{}");
await writeFile(
  wrapper,
  `#!/usr/bin/env node
const {appendFileSync,readFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2), control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(args)+'\\n');
if (args[0] === 'service' && (args[1] === 'stop' && args.includes(control.rejectStop) || args[1] === 'capabilities' && args.includes(control.legacy))) {
  process.stderr.write(JSON.stringify({error:{code:'INJECTED_BEFORE_ADMISSION',message:'injected failure before host admission'}})); process.exit(1);
}
const result = spawnSync(${JSON.stringify(binary)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`,
  { mode: 0o755 },
);
const until = async (read, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timeout waiting for ${label}`);
};
const cliWrites = async () =>
  (
    await readFile(tracePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((args) => args[0] === "service" && args[1] === "stop");
const target = (projectId) => {
  const descriptor = backend.projects.get(projectId).service;
  return { projectId, serviceId: descriptor.serviceId, generation: descriptor.generation };
};
async function attach(identity = "fixture-current") {
  service = new DesktopService(backend, identity, () => {
    exitRequests++;
  });
  const metadata = await service.listen();
  const connection = new ServiceConnection();
  await connection.connect(metadata);
  const packet = await connection.request("hello", {
    protocol: metadata.protocol,
    identity: metadata.identity,
  });
  return { metadata, connection, packet };
}
function intent(fixture, kind, expectedTargets, mode = "ifIdle", extra = {}) {
  return {
    protocol: fixture.metadata.protocol,
    requestId: randomUUID(),
    kind,
    mode,
    expectedDesktopGeneration: fixture.packet.service.lifecycle.desktopGeneration,
    expectedTargets,
    ...extra,
  };
}
const read = (fixture, request) =>
  fixture.connection.request("lifecycleRead", {
    protocol: fixture.metadata.protocol,
    requestId: request.requestId,
  });
const reconcile = (fixture, request) =>
  fixture.connection.request("lifecycleReconcile", {
    protocol: fixture.metadata.protocol,
    requestId: request.requestId,
  });
const submit = (fixture, request) => fixture.connection.request("lifecycleRequest", request, true);
try {
  backend = new CoreBackend(options);
  await backend.init();
  const projectId = await backend.addProject(workspace);
  const scheduled = await backend.command("manage", {
    projectId,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "Future startup fixture",
    interactionMode: "interactive",
    schedule: { at: Math.floor(Date.now() / 1000) + 3600, timeZone: "Asia/Shanghai" },
  });
  let fixture = await attach();
  assert.equal(
    fixture.packet.service.lifecycle?.version,
    2,
    "Desktop advertises durable lifecycle operations",
  );
  assert.match(fixture.packet.service.lifecycle.desktopGeneration, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fixture.packet.service.lifecycle.capabilities, {
    request: true,
    read: true,
    reconcile: true,
    kinds: ["stopDesktop", "updateDesktop", "stopProject", "updateProject", "interruptTurn"],
  });
  assert.equal(fixture.packet.service.lifecycle.activeRequestId, null);
  backend.binary = wrapper;
  const originalTarget = target(projectId);
  await assert.rejects(
    () =>
      submit(
        fixture,
        intent(fixture, "stopProject", [originalTarget], "cancel", {
          expectedDesktopGeneration: randomUUID(),
        }),
      ),
    (error) => error.code === "CONFIRMATION_STALE",
  );
  await assert.rejects(
    () =>
      submit(
        fixture,
        intent(fixture, "stopProject", [{ ...originalTarget, generation: randomUUID() }], "cancel"),
      ),
    (error) => error.code === "CONFIRMATION_STALE",
  );
  assert.equal(
    (await backend.projects.get(projectId).client.request("areal/server/status")).acceptingWork,
    true,
  );
  assert.deepEqual(await cliWrites(), []);
  checks.push("Desktop and Core generations are checked before durable admission or cancellation");

  const safe = intent(fixture, "stopProject", [originalTarget]);
  const stopped = await submit(fixture, safe);
  assert.equal(stopped.phase, "completed");
  assert.equal(stopped.targets[0].phase, "completed");
  assert.equal(stopped.desktopExit, "notRequested");
  assert.equal(exitRequests, 0);
  const writesAfterSafeStop = await cliWrites();
  assert.deepEqual(await submit(fixture, safe), stopped);
  assert.deepEqual(
    await cliWrites(),
    writesAfterSafeStop,
    "same request returns its receipt without stopping twice",
  );
  await backend.start(projectId);
  assert.notEqual(target(projectId).generation, originalTarget.generation);
  const restored = await backend.command("manage", {
    projectId,
    operation: "task",
    taskId: scheduled.id,
  });
  assert.equal(restored.paused, false);
  assert.equal(restored.cancelled, false);
  assert.deepEqual(restored.schedule, scheduled.schedule);
  assert.equal(restored.runs.length, 0);
  assert.deepEqual(await reconcile(fixture, safe), stopped);
  assert.equal(
    (await backend.projects.get(projectId).client.request("areal/server/status")).acceptingWork,
    true,
  );
  checks.push(
    "safe stop preserves an idle schedule; duplicate and reconcile cannot stop the replacement generation",
  );

  const beforeMaintenance = target(projectId);
  const beforeMaintenanceWrites = (await cliWrites()).length;
  await backend.restartProject(backend.projects.get(projectId));
  assert.notEqual(target(projectId).generation, beforeMaintenance.generation);
  const maintenanceWrites = (await cliWrites()).slice(beforeMaintenanceWrites);
  assert.equal(
    maintenanceWrites.length,
    1,
    "configuration maintenance stops through the same durable lifecycle owner",
  );
  assert.equal(maintenanceWrites[0].includes("--request-id"), true);
  assert.equal(maintenanceWrites[0].includes(beforeMaintenance.generation), true);
  const maintenanceRequests = (await readFile(tracePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    maintenanceRequests.some((args) => args[0] === "service" && args[1] === "restart"),
    false,
  );
  assert.equal(
    maintenanceRequests
      .filter((args) => args[0] === "service" && args[1] === "ensure")
      .every((args) => args.includes("--no-auto-restart")),
    true,
  );
  checks.push(
    "configuration maintenance uses the durable update owner and GUI ensure never restarts an existing generation implicitly",
  );

  const { threadId } = await backend.command("create", { projectId });
  const client = backend.projects.get(projectId).client;
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "hold exact turn" }],
  });
  await until(() => held.size, "held model turn");
  const interrupt = intent(fixture, "interruptTurn", [target(projectId)], "cancel", {
    threadId,
    turnId: turn.turn.id,
  });
  assert.equal((await submit(fixture, interrupt)).phase, "completed");
  await until(
    async () =>
      (await client.request("thread/read", { threadId, includeTurns: true })).thread.turns.find(
        (item) => item.id === turn.turn.id,
      )?.status === "interrupted",
    "fixed turn interruption",
  );
  const interruptBefore = await read(fixture, interrupt);
  assert.equal(interruptBefore.turnId, turn.turn.id);
  assert.equal((await reconcile(fixture, interrupt)).phase, "completed");
  const newerTurn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "hold next exact turn" }],
  });
  await until(() => held.size, "next held model turn");
  const staleInterrupt = await submit(
    fixture,
    intent(fixture, "interruptTurn", [target(projectId)], "cancel", {
      threadId,
      turnId: turn.turn.id,
    }),
  );
  assert.equal(staleInterrupt.phase, "blocked");
  assert.equal(
    (await client.request("thread/read", { threadId, includeTurns: true })).thread.turns.find(
      (item) => item.id === newerTurn.turn.id,
    ).status,
    "inProgress",
  );
  assert.equal(
    (
      await backend.command("stop", {
        projectId,
        threadId,
        turnId: newerTurn.turn.id,
        requestId: randomUUID(),
      })
    ).phase,
    "completed",
  );
  const { threadId: queueThread } = await backend.command("create", { projectId });
  await client.request("areal/queue/pause", {
    threadId: queueThread,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  await client.request("areal/turn/enqueue", {
    threadId: queueThread,
    requestId: randomUUID(),
    input: [{ type: "text", text: "Preserved pending input" }],
  });
  const queueBefore = await client.request("areal/queue/list", { threadId: queueThread });
  const blocked = await submit(fixture, intent(fixture, "stopProject", [target(projectId)]));
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.targets[0].phase, "blocked");
  assert.equal(backend.closing, false);
  const secondWorkspace = join(scratch, "second-workspace");
  await mkdir(secondWorkspace);
  const secondProjectId = await backend.addProject(secondWorkspace);
  assert.equal(
    typeof (await backend.command("create", { projectId: secondProjectId })).threadId,
    "string",
  );
  const cancel = intent(fixture, "stopProject", [target(projectId)], "cancel");
  assert.equal((await submit(fixture, cancel)).phase, "completed");
  await backend.start(projectId);
  const queueAfter = await backend.projects
    .get(projectId)
    .client.request("areal/queue/list", { threadId: queueThread });
  assert.equal(queueAfter.paused, true);
  assert.deepEqual(queueAfter.items, queueBefore.items);
  checks.push(
    "exact-turn interrupt uses the shared owner; known busy refusal preserves unrelated admissions and cancellation preserves pending input",
  );

  const beforePartial = [target(projectId), target(secondProjectId)].sort((a, b) =>
    a.projectId.localeCompare(b.projectId),
  );
  const rejectedTarget = beforePartial[1];
  await writeFile(controlPath, JSON.stringify({ legacy: rejectedTarget.serviceId }));
  const partialRequest = intent(fixture, "stopDesktop", beforePartial, "cancel");
  const partial = await submit(fixture, partialRequest);
  assert.equal(partial.phase, "partial");
  assert.deepEqual(
    partial.targets.map((item) => item.phase),
    ["completed", "blocked"],
  );
  assert.equal(partial.desktopExit, "notRequested");
  assert.equal(exitRequests, 0);
  assert.equal(backend.closing, false);
  const beforeRead = await cliWrites();
  assert.deepEqual(
    (await reconcile(fixture, partialRequest)).targets.map((item) => item.phase),
    ["completed", "blocked"],
  );
  assert.deepEqual(await cliWrites(), beforeRead, "reconcile never resends stop or drain");
  fixture.connection.close();
  service.close();
  service = null;
  fixture = await attach("fixture-restarted-desktop");
  assert.notEqual(fixture.packet.service.lifecycle.desktopGeneration, partial.desktopGeneration);
  const recovered = await read(fixture, partialRequest);
  assert.equal(recovered.phase, "partial");
  assert.deepEqual(
    recovered.targets.map((item) => item.phase),
    ["completed", "blocked"],
  );
  assert.deepEqual(await cliWrites(), beforeRead);
  await backend.start(beforePartial[0].projectId);
  assert.equal(
    typeof (await backend.command("create", { projectId: beforePartial[0].projectId })).threadId,
    "string",
  );
  await writeFile(controlPath, "{}");
  const remaining = intent(fixture, "stopProject", [target(rejectedTarget.projectId)], "cancel");
  assert.equal((await submit(fixture, remaining)).phase, "completed");
  assert.equal(
    (await cliWrites()).filter(
      (args) =>
        args.includes(beforePartial[0].serviceId) && args.includes(beforePartial[0].generation),
    ).length,
    1,
  );
  checks.push(
    "partial Desktop operation survives a new Desktop generation and read-only reconciliation never repeats a completed target",
  );

  await backend.start(projectId);
  const lost = intent(fixture, "stopProject", [target(projectId)], "cancel");
  const send = service.send.bind(service);
  let dropped = false;
  service.send = (socket, packet) => {
    if (!dropped && packet.id && packet.result?.requestId === lost.requestId) {
      dropped = true;
      socket.terminate();
      return;
    }
    send(socket, packet);
  };
  await assert.rejects(
    () => submit(fixture, lost),
    (error) => error.submissionUnknown === true,
  );
  assert.equal(dropped, true);
  fixture.connection.close();
  service.close();
  service = null;
  fixture = await attach("fixture-after-lost-response");
  assert.equal((await read(fixture, lost)).phase, "completed");
  const writesAfterLost = await cliWrites();
  assert.equal((await reconcile(fixture, lost)).phase, "completed");
  assert.deepEqual(await cliWrites(), writesAfterLost);
  checks.push(
    "a lost authenticated Desktop response is recovered from its original durable receipt after Desktop restart",
  );

  await backend.start(projectId);
  const legacyTarget = target(projectId);
  await writeFile(controlPath, JSON.stringify({ legacy: legacyTarget.serviceId }));
  const oldHost = await submit(fixture, intent(fixture, "stopProject", [legacyTarget], "cancel"));
  assert.equal(oldHost.phase, "blocked");
  assert.equal(oldHost.targets[0].error.code, "LIFECYCLE_UNSUPPORTED");
  assert.equal(
    (await backend.projects.get(projectId).client.request("areal/server/status")).acceptingWork,
    true,
  );
  assert.deepEqual(await cliWrites(), writesAfterLost);
  checks.push(
    "unsupported host lifecycle capability refuses the new write before any legacy stop or cancel fallback",
  );
  await writeFile(controlPath, "{}");
  const desktopTargets = [...backend.projects.keys()]
    .filter((id) => backend.projects.get(id).service)
    .map(target)
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
  const desktopStop = intent(fixture, "stopDesktop", desktopTargets, "cancel");
  const exiting = await submit(fixture, desktopStop);
  assert.equal(exiting.phase, "acceptedPending");
  assert.equal(exiting.desktopExit, "requested");
  assert.equal(exiting.targets[0].phase, "completed");
  await until(() => exitRequests === 1, "Desktop exit request");
  assert.equal(
    (await read(fixture, desktopStop)).phase,
    "acceptedPending",
    "the owner cannot claim its own process already exited",
  );
  const afterExitWorkspace = join(scratch, "after-exit-workspace");
  await mkdir(afterExitWorkspace);
  const savedBeforeExitAdmission = structuredClone(backend.saved);
  await assert.rejects(
    () => backend.addProject(afterExitWorkspace),
    (error) => error.code === "LIFECYCLE_EXIT_REQUESTED",
  );
  assert.deepEqual(
    backend.saved,
    savedBeforeExitAdmission,
    "exit requested rejects registration before changing the index",
  );
  await assert.rejects(
    () => backend.restartProject(backend.projects.get(projectId)),
    (error) => error.code === "LIFECYCLE_EXIT_REQUESTED",
  );
  checks.push(
    "Desktop records exit requested only after Core lock settlement and leaves actual Desktop exit confirmation to Main",
  );
  fixture.connection.close();
  service.close();
  service = null;

  backend = new CoreBackend(options);
  await backend.init();
  const uncertainWorkspace = join(scratch, "uncertain-workspace");
  await mkdir(uncertainWorkspace);
  const uncertainProjectId = await backend.addProject(uncertainWorkspace);
  const uncertainThread = await backend.command("create", { projectId: uncertainProjectId });
  backend.binary = wrapper;
  fixture = await attach("fixture-admission-unconfirmed");
  await writeFile(
    controlPath,
    JSON.stringify({ rejectStop: target(uncertainProjectId).serviceId }),
  );
  const uncertainRequest = intent(fixture, "stopProject", [target(uncertainProjectId)], "cancel");
  const uncertain = await submit(fixture, uncertainRequest);
  assert.equal(uncertain.phase, "admissionUnconfirmed");
  assert.equal(uncertain.targets[0].phase, "admissionUnconfirmed");
  const beforeUncertainRead = await cliWrites();
  assert.equal((await reconcile(fixture, uncertainRequest)).phase, "admissionUnconfirmed");
  assert.deepEqual(await cliWrites(), beforeUncertainRead);
  const observedList = await backend.command("list", { projectId: uncertainProjectId });
  assert.equal(
    observedList.projects
      .find((project) => project.id === uncertainProjectId)
      .summaries.some((thread) => thread.id === uncertainThread.threadId),
    true,
  );
  const observedHistory = await backend.command("open", {
    projectId: uncertainProjectId,
    threadId: uncertainThread.threadId,
  });
  assert.equal(
    observedHistory.projects.find((project) => project.id === uncertainProjectId).state.threads[
      uncertainThread.threadId
    ].id,
    uncertainThread.threadId,
  );
  assert.equal(
    (await backend.command("manage", { projectId: uncertainProjectId, operation: "server" }))
      .acceptingWork,
    true,
  );
  assert.deepEqual(await cliWrites(), beforeUncertainRead);
  await backend.addProject(workspace);
  assert.equal(typeof (await backend.command("create", { projectId })).threadId, "string");
  checks.push(
    "missing authoritative host receipt stays admission unconfirmed, never replays stop, and does not disable unrelated workspaces",
  );
  fixture.connection.close();
  service.close();
  service = null;

  for (const project of backend.projects.values())
    if (project.service) {
      await executeCore(
        binary,
        [
          "service",
          "stop",
          "--instance",
          project.service.serviceId,
          "--expected-generation",
          project.service.generation,
          "--cancel",
          "--json",
        ],
        { env: backend.hooks.environment(), timeout: 30000 },
      );
    }
  await backend.disconnect();
  const offlineOptions = {
    ...options,
    home: join(scratch, "offline-core"),
    harnessHome: join(scratch, "r2"),
  };
  await writeFile(controlPath, "{}");
  backend = new CoreBackend(offlineOptions);
  await backend.init();
  const offlineWorkspace = join(scratch, "offline-workspace");
  await mkdir(offlineWorkspace);
  const offlineProjectId = await backend.addProject(offlineWorkspace);
  backend.binary = wrapper;
  fixture = await attach("fixture-offline-original-host");
  const owner = service.lifecycle,
    store = owner.store.bind(owner);
  const initialFailure = intent(fixture, "stopProject", [target(offlineProjectId)]);
  const writesBeforeInitialFailure = await cliWrites();
  owner.store = async () => {
    throw Object.assign(new Error("injected initial receipt write failure"), {
      code: "LIFECYCLE_RECEIPT_WRITE_FAILED",
    });
  };
  await assert.rejects(
    () => submit(fixture, initialFailure),
    (error) => error.code === "LIFECYCLE_ADMISSION_FAILED" && error.submissionUnknown !== true,
  );
  assert.equal(
    await readLifecycleReceipt(offlineOptions.home, { requestId: initialFailure.requestId }),
    null,
  );
  assert.deepEqual(await cliWrites(), writesBeforeInitialFailure);
  owner.store = store;
  const offlineRequest = intent(fixture, "stopDesktop", [target(offlineProjectId)]);
  owner.store = async (record) => {
    await store(record);
    if (
      record.requestId === offlineRequest.requestId &&
      record.targets[0].phase === "acceptedPending"
    )
      throw Object.assign(new Error("injected Desktop death after durable admission"), {
        code: "LIFECYCLE_RECEIPT_WRITE_FAILED",
      });
  };
  const postAdmissionError = await submit(fixture, offlineRequest).then(
    () => assert.fail("post-admission fault must reject"),
    (error) => error,
  );
  owner.store = store;
  const staleReceipt = await readLifecycleReceipt(offlineOptions.home, {
    requestId: offlineRequest.requestId,
  });
  assert.equal(staleReceipt.targets[0].phase, "acceptedPending");
  assert.equal(staleReceipt.harnessHome, offlineOptions.harnessHome);
  fixture.connection.close();
  service.close();
  service = null;
  await backend.disconnect();
  const originalHost = staleReceipt.targets[0];
  await executeCore(
    wrapper,
    [
      "service",
      "stop",
      "--instance",
      originalHost.serviceId,
      "--expected-generation",
      originalHost.generation,
      "--request-id",
      originalHost.requestId,
      "--json",
    ],
    { env: backend.hooks.environment(), timeout: 30000 },
  );
  await until(
    async () =>
      JSON.parse(
        (
          await executeCore(
            wrapper,
            [
              "service",
              "operation",
              "--instance",
              originalHost.serviceId,
              "--expected-generation",
              originalHost.generation,
              "--request-id",
              originalHost.requestId,
              "--json",
            ],
            { env: backend.hooks.environment(), timeout: 10000 },
          )
        ).stdout,
      ).operation?.state === "completed",
    "original Host physical receipt completion",
  );
  const writesAfterOriginalHost = await cliWrites();
  const stalePath = join(
    offlineOptions.home,
    "lifecycle-operations",
    `${offlineRequest.requestId}.json`,
  );
  const staleBytes = await readFile(stalePath, "utf8");
  const offlineProjection = await (reconcileLifecycleReceipt ?? readLifecycleReceipt)(
    offlineOptions.home,
    {
      requestId: offlineRequest.requestId,
      desktopGeneration: staleReceipt.desktopGeneration,
      binary: wrapper,
      harnessHome: join(scratch, "wrong-current-registry"),
    },
  );
  assert.equal(
    offlineProjection.targets[0].phase,
    "completed",
    "offline reconciliation reads original Host completion instead of stale Desktop JSON",
  );
  assert.equal(offlineProjection.phase, "acceptedPending");
  assert.equal(
    offlineProjection.desktopExit,
    "notRequested",
    "offline projection leaves original Desktop exit proof to Main",
  );
  assert.equal(
    await readFile(stalePath, "utf8"),
    staleBytes,
    "offline reconciliation never writes the Desktop journal",
  );
  assert.deepEqual(
    await cliWrites(),
    writesAfterOriginalHost,
    "offline reconciliation never repeats stop or starts a missing service",
  );
  assert.equal(
    postAdmissionError.submissionUnknown,
    true,
    "failure after durable admission retains the original request for reconciliation",
  );
  backend = new CoreBackend(offlineOptions);
  await backend.init();
  assert.equal(
    backend.projects.size,
    0,
    "startup recovery reads receipts before any Core auto-start",
  );
  assert.equal(
    (await backend.lifecycleOperations.read(offlineRequest.requestId)).targets[0].phase,
    "completed",
  );
  await backend.start(offlineProjectId);
  assert.notEqual(target(offlineProjectId).generation, originalHost.generation);
  checks.push(
    "offline original Host completion projects over stale Desktop receipts without writes, stop replay or new owner; initial and post-admission failures remain distinct",
  );
  passed = true;
} finally {
  service?.close();
  if (backend) {
    backend.binary = binary;
    for (const project of backend.projects.values())
      if (project.service) {
        await executeCore(
          binary,
          [
            "service",
            "stop",
            "--instance",
            project.service.serviceId,
            "--expected-generation",
            project.service.generation,
            "--cancel",
            "--json",
          ],
          { env: backend.hooks.environment(), timeout: 30000 },
        ).catch(() => {});
      }
    await backend.disconnect().catch(() => {});
  }
  for (const response of held) response.destroy();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        binarySha256,
        scope:
          "real Core/Runtime and authenticated Desktop lifecycle; Desktop process exit remains separate Electron acceptance",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
}
