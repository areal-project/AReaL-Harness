import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require(join(gui, "../../services/workbench/src/desktop/core/backend.cjs"));
const local = require(join(gui, "../../services/workbench/src/desktop/core/local-service.cjs"));
const { createOwner } = require(join(gui, "../../services/workbench/src/desktop/core/application-owner.cjs"));
const scratch = await makeTempDir("areal-desktop-crash-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user", ".areal"), { recursive: true });
let workRequests = 0;
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const title =
    body.messages?.[0]?.content?.startsWith("Generate a concise semantic session title") === true;
  if (!title) workRequests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: title ? "Crash fixture" : "CRASH_ORIGINAL_HISTORY" }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(scratch, "user", ".areal", "config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      { id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Complete the task" },
    ],
  }),
);
const backend = new CoreBackend({
  binary: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
  home: join(scratch, "desktop"),
  harnessHome: join(scratch, "registry"),
  userHome: join(scratch, "user"),
  applicationOwner: createOwner(join(scratch, "profile")),
  desktopConfig: deployment,
  defaultProfile: { id: "fixture", revision: "v1" },
});
const checks = [];
let project, fatal, cleanupError, explicitStop;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timeout: ${label}; ${project?.error ?? ""}`);
}
async function confirmedCrash(original) {
  await until(async () => {
    const status = await local.serviceRequest(backend, [
      "status",
      "--instance",
      original.serviceId,
      "--recovery",
    ]);
    return status.recovery?.generation === original.generation && status.recovery.eligible;
  }, "real Host cleanup proof");
}
async function crashAndRestore({ loseReply = false } = {}) {
  const original = project.service,
    before = workRequests;
  clearTimeout(project.reconnectTimer);
  project.reconnectTimer = null;
  project.reconnectBlocked = true;
  process.kill(original.corePid, "SIGKILL");
  await confirmedCrash(original);
  project.reconnectBlocked = false;
  const recover = local.recoverService;
  let replies = 0;
  if (loseReply)
    local.recoverService = async (...args) => {
      const result = await recover(...args);
      if (replies++ === 0)
        throw Object.assign(new Error("INJECTED_RECOVER_REPLY_LOSS"), { code: "TIMEOUT" });
      return result;
    };
  try {
    backend.scheduleReconnect(project);
    await until(
      () =>
        project.service.generation !== original.generation &&
        project.model.state.connected &&
        !backend.starting.has(project.id),
      "automatic guarded Desktop reconnect",
    );
  } finally {
    local.recoverService = recover;
  }
  assert.equal(
    project.client.ready,
    true,
    "Desktop automatically connects to its guarded successor",
  );
  assert.notEqual(project.service.generation, original.generation);
  assert.equal(project.service.serviceId, original.serviceId);
  assert.equal(
    backend.ownedEngines.get(project.id).service.generation,
    project.service.generation,
    "lifecycle owner adopts the same successor",
  );
  assert.equal(workRequests, before, "restoring the original history causes no model replay");
  const thread = project.model.state.threads[project.fixtureThread];
  assert.equal(thread.turns.length, 1);
  assert.match(JSON.stringify(thread.turns), /CRASH_ORIGINAL_HISTORY/);
  const receipt = JSON.parse(
    await readFile(
      join(scratch, "registry", "services", original.serviceId, "replacement.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.original.generation, original.generation);
  assert.equal(receipt.successor.generation, project.service.generation);
  checks.push({
    case: loseReply ? "lost-recover-reply" : "confirmed-core-crash",
    passed: true,
    original: original.generation,
    successor: project.service.generation,
    modelReplays: workRequests - before,
    discardedReplies: replies ? 1 : 0,
  });
}
try {
  await backend.init();
  const projectId = await backend.addProject(workspace);
  project = backend.projects.get(projectId);
  const { threadId } = await backend.command("create", { projectId, requestId: randomUUID() });
  project.fixtureThread = threadId;
  await backend.command("send", {
    projectId,
    threadId,
    requestId: randomUUID(),
    text: "Keep this original history",
  });
  await until(
    () => project.model.state.threads[threadId]?.turns.at(-1)?.status === "completed",
    "original completed turn",
  );
  await crashAndRestore();
  await crashAndRestore({ loseReply: true });
  const stopped = project.service;
  clearTimeout(project.reconnectTimer);
  project.reconnectTimer = null;
  project.reconnectBlocked = true;
  explicitStop = {
    projectId,
    root: project.root,
    serviceId: stopped.serviceId,
    generation: stopped.generation,
    requestId: randomUUID(),
  };
  await local.serviceRequest(backend, [
    "stop",
    "--instance",
    stopped.serviceId,
    "--expected-generation",
    stopped.generation,
    "--request-id",
    explicitStop.requestId,
    "--cancel",
  ]);
  await until(
    async () =>
      (await local.serviceRequest(backend, ["status", "--instance", stopped.serviceId])).state ===
      "stopped",
    "explicit stop",
  );
  project.reconnectBlocked = false;
  await assert.rejects(backend.reconnectProject(project), (error) =>
    ["CORE_STOPPED", "CORE_RECOVERY_EXHAUSTED"].includes(error.code),
  );
  assert.equal(
    (await local.serviceRequest(backend, ["status", "--instance", stopped.serviceId])).generation,
    stopped.generation,
  );
  assert.equal(workRequests, 1);
  checks.push({
    case: "explicit-stop-not-resurrected",
    passed: true,
    generation: stopped.generation,
  });
} catch (error) {
  fatal = { message: error.message, code: error.code, stack: error.stack };
} finally {
  clearTimeout(project?.reconnectTimer);
  if (project) {
    project.reconnectTimer = null;
    project.reconnectBlocked = true;
  }
  try {
    if (explicitStop) {
      await until(
        async () => (await local.readStop(backend, explicitStop))?.state === "completed",
        "original explicit stop cleanup receipt",
      );
      local.detachStoppedProject(backend, explicitStop);
    }
    await backend.shutdown({ cancel: true });
  } catch (error) {
    cleanupError = error.message;
  }
  await backend.disconnect().catch((error) => {
    cleanupError ??= error.message;
  });
  for (const owned of backend.ownedEngines.values())
    for (const lifetime of owned.lifetimes ?? []) lifetime.destroy();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const passed = !fatal && !cleanupError && checks.length === 3;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        sourceRoot: resolve(gui, "../.."),
        binary: backend.binary,
        scope:
          "real CoreBackend, Core, Host and Runtime; isolated GUI owner and local SSE provider; no Renderer or installed-package acceptance",
        checks,
        workRequests,
        fatal,
        cleanupError,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, fatal, cleanupError }));
  if (!passed) process.exitCode = 1;
}
