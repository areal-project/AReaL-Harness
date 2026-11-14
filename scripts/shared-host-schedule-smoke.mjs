import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const require = createRequire(import.meta.url);
const { HostClient } = createRequire(new URL("../clients/gui/app/package.json", import.meta.url))(
  "@areal/client/node",
);
const repository = await realpath(new URL("..", import.meta.url).pathname);
const root = await realpath(await mkdtemp("/tmp/ah-host-schedules-"));
const home = join(root, "host");
const user = join(root, "user");
const binary = join(
  resolve(process.env.AREAL_TEST_BIN_DIR ?? join(repository, ".local/shared-host-bin")),
  "areal",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const evidence = {
  root,
  binary,
  binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(new URL(import.meta.url))),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  diffSha256: hash(execFileSync("git", ["diff"], { cwd: repository })),
  checks: [],
  hosts: [],
  modelRequests: [],
  cleanup: [],
  excluded: ["Electron UI", "Keychain", "real provider", "physical phone", "installed package"],
};
const host = new HostClient();
const coreClients = [];
let modelFailure;
let linkedSkillRead = false;
let desktopProvider;
const desktopModelTools = [];
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    evidence.modelRequests.push({ at: Date.now(), model: body.model });
    const text = (message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n");
    const context = (body.messages ?? [])
      .map(text)
      .filter((value) => value.includes("Current authoritative goal: "))
      .at(-1);
    const goal = context && JSON.parse(context.split("Current authoritative goal: ").at(-1));
    if ((body.messages ?? []).some((message) => text(message).includes("HOST_SCHEDULE_desktop"))) {
      const tools = (body.tools ?? []).map((tool) => tool.function?.name);
      desktopModelTools.push(tools);
      if (desktopProvider) {
        assert(tools.includes("browser_v1"), "online schedule advertises Browser");
        assert(tools.includes("computer_v1"), "online schedule advertises Computer");
        await desktopProvider.close();
        desktopProvider = undefined;
      }
    }
    const skillResults = (body.messages ?? []).filter((message) => message.role === "tool");
    const listed = skillResults.find((message) => message.tool_call_id === "linked-schedule-list");
    const readLinked = skillResults.find(
      (message) => message.tool_call_id === "linked-schedule-read",
    );
    let skillTool;
    if (JSON.stringify(body.messages).includes("HOST_SCHEDULE_managed") && !readLinked) {
      if (!listed) skillTool = { id: "linked-schedule-list", name: "skill_list", args: {} };
      else {
        const skill = JSON.parse(listed.content).data.find((item) => item.id === "linked-skill");
        assert.ok(skill, "scheduled agent sees the linked skill");
        skillTool = {
          id: "linked-schedule-read",
          name: "skill_read",
          args: { skill: { id: skill.id, revision: skill.revision } },
        };
      }
    }
    if (readLinked) {
      assert.match(JSON.parse(readLinked.content).text, /Linked schedule instructions/);
      linkedSkillRead = true;
    }
    const tool =
      skillTool ??
      (goal?.goal?.limitsPending
        ? { name: "goal_set_limits", args: { expectedRevision: goal.revision, sources: {} } }
        : goal && goal.goal.report?.status !== "complete"
          ? {
              name: "goal_update",
              args: {
                expectedRevision: goal.revision,
                status: "complete",
                summary: "HOST_SCHEDULE_DONE",
                evidence: ["Local deterministic schedule fixture."],
                remaining: [],
              },
            }
          : null);
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: tool.id ?? randomUUID(),
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        }
      : { content: "HOST_SCHEDULE_DONE" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const frame of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
      {
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    ])
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) {
    modelFailure = error;
    response.destroy(error);
  }
});
await mkdir(user);
const linkedSkillRoot = join(root, "external-skill");
await mkdir(linkedSkillRoot);
await writeFile(
  join(linkedSkillRoot, "SKILL.md"),
  "---\nname: Linked skill\ndescription: Scheduled fixture\n---\nLinked schedule instructions.\n",
);
await mkdir(join(user, ".agents/skills"), { recursive: true });
await symlink(linkedSkillRoot, join(user, ".agents/skills/linked-skill"));
await new Promise((done) => model.listen(0, "127.0.0.1", done));
const configPath = join(user, "config.toml");
await writeFile(
  configPath,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\n`,
);
async function until(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (modelFailure) throw modelFailure;
    const result = await check();
    if (result) return result;
    assert(Date.now() < deadline, `Timeout: ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function startHost() {
  await host.connectOrStart(home, binary);
  host.requireCapability("scheduledActivation");
  const identity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
  evidence.hosts.push(identity);
  return identity;
}
async function waitExit(pid) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    assert(Date.now() < deadline, `owned Host ${pid} must exit`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function stopHost() {
  const identity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
  const receipt = await host.stop(randomUUID(), host.generation, "ifIdle");
  assert.equal(receipt.state, "completed", JSON.stringify(receipt));
  host.close();
  await waitExit(identity.pid);
  evidence.cleanup.push({ pid: identity.pid, stopped: true });
}
async function status(id) {
  return (await host.status()).projects.find((project) => project.registration.projectId === id);
}
async function readTask(project) {
  const directory = join(project.registration.dataDir, "desktop");
  const catalog = JSON.parse(await readFile(join(directory, "task-mode.json"), "utf8"));
  const entry = catalog.tasks[hash(project.task.id)];
  assert(entry, "published catalog retains seeded task");
  const bytes = await readFile(join(directory, "task-ledger", entry.body));
  assert.equal(hash(bytes), entry.body, "committed task body digest");
  assert.equal(bytes.length, entry.hot_bytes, "committed task body length");
  return JSON.parse(bytes);
}
async function seed(id, at, paused = false, managed = false) {
  const workspace = join(root, id);
  const dataDir = join(root, `${id}-state`);
  const scratch = join(root, `${id}-scratch`);
  await mkdir(workspace);
  await mkdir(scratch);
  const registration = {
    projectId: id,
    workspace,
    dataDir,
    source: { kind: "cli" },
    defaultBinding: true,
  };
  await host.registerProject(randomUUID(), registration);
  const launchInputs = {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    configPath,
    environment: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost,::1" },
    credentialNames: [],
    options: {
      workspace,
      data_dir: dataDir,
      scratch,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  };
  if (managed) {
    const builtin = join(root, "fixture-builtin");
    const skill = join(workspace, ".agents", "skills", "scheduled-skill");
    await mkdir(builtin, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(join(builtin, "SKILL.md"), "# Local builtin fixture\n");
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: Scheduled skill\ndescription: First\n---\n",
    );
    const deployment = join(root, `${id}-deployment.json`);
    await writeFile(
      deployment,
      JSON.stringify({
        profiles: [
          {
            id: "fixture-standard",
            revision: "base",
            displayName: "Managed fixture",
            instructions: "Complete the task.",
          },
        ],
        skills: [
          {
            id: "openai-skill-creator",
            revision: "fixture-builtin",
            root: builtin,
            metadata: { name: "Local builtin fixture", description: "Deterministic test only." },
          },
        ],
      }),
    );
    launchInputs.deploymentPath = deployment;
    launchInputs.schedulePreparation = {
      kind: "managed",
      resourceStatePath: join(root, "resources.json"),
      userManagedSkillsRoot: join(user, "managed-skills"),
      projectManagedSkillsRoot: join(workspace, "managed-skills"),
      projectResourceScope: id,
      defaultProfile: { id: "fixture-standard", revision: "base" },
    };
  }
  const ensured = await host.ensureProject(randomUUID(), id, launchInputs);
  assert.equal(ensured.project.state, "ready", JSON.stringify(ensured));
  const core = await connect(ensured.service.endpoint, ensured.service.authFile);
  coreClients.push(core);
  const source = await core.call("areal/thread/start", { requestId: randomUUID(), cwd: workspace });
  const anchor = await core.call("areal/thread/start", { requestId: randomUUID(), cwd: workspace });
  const task = await core.call("areal/task/create", {
    requestId: randomUUID(),
    sourceThreadId: source.thread.id,
    threadId: anchor.thread.id,
    mode: "scheduled",
    objective: `HOST_SCHEDULE_${id}`,
    interactionMode: "interactive",
    scheduleV2: {
      version: 1,
      rule: { kind: "onceIso", atIso: new Date(at * 1000).toISOString().replace(".000Z", "Z") },
      misfire: { kind: "coalesce" },
      overlap: "skip",
    },
  });
  if (paused)
    await core.call("areal/task/pause", {
      requestId: randomUUID(),
      taskId: task.id,
      expectedRevision: task.revision,
    });
  await core.close();
  return { registration, launchInputs, task, service: ensured.service };
}
let failure;
try {
  await startHost();
  const due = Math.floor(Date.now() / 1000) + 40;
  const active = await seed("scheduled", due);
  const paused = await seed("paused", due, true);
  const suppressed = await seed("suppressed", due);
  const managed = await seed("managed", due, false, true);
  const stop = await host.stopProject(
    randomUUID(),
    suppressed.registration.projectId,
    suppressed.service.generation,
    "ifIdle",
  );
  assert.equal(stop.state, "completed");
  assert.equal((await status("suppressed")).scheduleActivationSuppressed, true);
  assert(Date.now() < due * 1000, "all owners stop before the scheduled occurrence");
  await stopHost();
  const restarted = await startHost();
  assert.notEqual(restarted.generation, evidence.hosts[0].generation);
  assert.equal(restarted.hostId, evidence.hosts[0].hostId);
  await until(
    async () => (await status("scheduled"))?.state === "ready",
    "headless owner activation",
  );
  assert.equal((await status("suppressed")).scheduleActivationSuppressed, true);
  assert.notEqual((await status("suppressed")).state, "ready");
  assert.notEqual((await status("paused")).state, "ready");
  evidence.checks.push("Host startup activates enabled published task without any GUI process");
  const completed = await until(async () => {
    const task = await readTask(active);
    return task.runCount === 1 && task.runs[0]?.status === "completed" && task;
  }, "headless scheduled Run completes");
  assert.equal(completed.runs[0].scheduledAt, due);
  assert.equal((await readTask(paused)).runCount, 0);
  assert.equal((await readTask(suppressed)).runCount, 0);
  assert.notEqual((await status("paused")).state, "ready");
  evidence.checks.push(
    "one due occurrence completes once; paused and explicitly stopped projects stay dormant",
  );
  const managedTask = await until(
    async () => {
      const task = await readTask(managed);
      return task.runCount === 1 && task.runs[0]?.status === "completed" && task;
    },
    "managed schedule prepares its profile after a controlled Core restart",
    120000,
  );
  const firstManagedService = (await status("managed")).service;
  const firstManagedClient = await connect(
    firstManagedService.endpoint,
    firstManagedService.authFile,
  );
  coreClients.push(firstManagedClient);
  const firstManagedThread = await firstManagedClient.call("thread/read", {
    threadId: managedTask.runs[0].threadId,
    includeTurns: false,
  });
  const firstProfile = firstManagedThread.thread.desktop.configuration.profile;
  assert.ok(linkedSkillRead, "scheduled agent reads the linked skill through its tool");
  const scheduledSkills = (
    await firstManagedClient.call("areal/skill/list", { threadId: managedTask.runs[0].threadId })
  ).data;
  const linkedSkill = scheduledSkills.find((skill) => skill.id === "linked-skill");
  assert.ok(linkedSkill, "scheduled thread receives the linked user skill");
  const linkedContent = await firstManagedClient.call("areal/skill/read", {
    threadId: managedTask.runs[0].threadId,
    skill: { id: linkedSkill.id, revision: linkedSkill.revision },
    resource: "SKILL.md",
  });
  assert.match(linkedContent.text, /Linked schedule instructions/);
  evidence.checks.push(
    "scheduled thread lists and reads a user skill linked outside its discovery root",
  );
  assert.equal(managedTask.runs[0].scheduledAt, due);
  assert.match(firstProfile.revision, /^resources-/);
  await writeFile(
    join(managed.registration.workspace, ".agents", "skills", "scheduled-skill", "SKILL.md"),
    "---\nname: Scheduled skill\ndescription: Second\n---\n",
  );
  const manualRun = await firstManagedClient.call("areal/task/runNow", {
    requestId: randomUUID(),
    taskId: managedTask.id,
    expectedRevision: managedTask.revision,
  });
  const secondManagedTask = await until(
    async () => {
      const task = await readTask(managed);
      return task.runCount === 2 && task.runs[1]?.status === "completed" && task;
    },
    "changed managed resources prepare the second Run exactly once",
    120000,
  );
  const secondManagedService = (await status("managed")).service;
  assert.equal(secondManagedTask.runs[1].id, manualRun.runId);
  assert.notEqual(secondManagedService.generation, firstManagedService.generation);
  const secondManagedClient = await connect(
    secondManagedService.endpoint,
    secondManagedService.authFile,
  );
  coreClients.push(secondManagedClient);
  const secondManagedThread = await secondManagedClient.call("thread/read", {
    threadId: secondManagedTask.runs[1].threadId,
    includeTurns: false,
  });
  assert.notEqual(
    secondManagedThread.thread.desktop.configuration.profile.revision,
    firstProfile.revision,
  );
  evidence.checks.push(
    "managed resource changes restart Core and select a fresh profile without duplicating Runs",
  );
  const ordinary = await host.ensureProject(randomUUID(), "suppressed");
  assert.equal(ordinary.project.state, "ready");
  assert.equal((await status("suppressed")).scheduleActivationSuppressed, true);
  assert.equal((await readTask(suppressed)).runCount, 0);
  evidence.checks.push(
    "ordinary project activation succeeds without resuming suppressed schedules",
  );
  const resumed = await host.request("project.ensure", {
    requestId: randomUUID(),
    expectedGeneration: host.generation,
    projectId: "suppressed",
    noAutoRestart: true,
    resumeScheduling: true,
  });
  assert.equal(resumed.project.state, "ready");
  assert.equal((await status("suppressed")).scheduleActivationSuppressed, false);
  evidence.checks.push("only explicit resumeScheduling clears Host suppression");
  await until(async () => {
    const task = await readTask(suppressed);
    return task.runCount === 1 && task.runs[0]?.status === "completed";
  }, "resumed owner coalesces the missed occurrence");
  const desktop = await seed("desktop", Math.floor(Date.now() / 1000) + 10);
  desktopProvider = await connect(desktop.service.endpoint, desktop.service.authFile);
  coreClients.push(desktopProvider);
  await desktopProvider.call("areal/task/tools/ready", {
    bundles: ["areal.browser.v1", "areal.computer.v1"],
  });
  const desktopTask = await until(async () => {
    const task = await readTask(desktop);
    return task.runCount === 1 && task.runs[0]?.status === "completed" && task;
  }, "scheduled Run continues after its separate desktop provider disconnects");
  assert(desktopModelTools.length > 1, "same Run makes model progress after provider disconnect");
  assert.equal((await status("desktop")).service.generation, desktop.service.generation);
  assert.equal((await host.status()).generation, restarted.generation);
  const withoutDesktop = await connect(desktop.service.endpoint, desktop.service.authFile);
  coreClients.push(withoutDesktop);
  const beforeHeadless = desktopModelTools.length;
  await withoutDesktop.call("areal/task/runNow", {
    requestId: randomUUID(),
    taskId: desktopTask.id,
    expectedRevision: desktopTask.revision,
  });
  await until(async () => {
    const task = await readTask(desktop);
    return task.runCount === 2 && task.runs[1]?.status === "completed";
  }, "next Run completes without a desktop provider");
  const headlessTools = desktopModelTools.slice(beforeHeadless);
  assert(headlessTools.length > 0);
  assert(
    headlessTools.every((tools) => !tools.includes("browser_v1") && !tools.includes("computer_v1")),
    "headless Run never advertises unavailable desktop tools",
  );
  evidence.checks.push(
    "online schedules receive Browser/Computer; desktop disconnect preserves Run and generations; next Run omits desktop tools",
  );
  evidence.desktopModelTools = desktopModelTools;
  await until(async () => {
    const activity = await host.activity();
    return activity.complete && activity.projects.every((project) => project.idleAllowed);
  }, "all scheduled execution settles");
  await stopHost();
  assert.equal(hash(await readFile(binary)), evidence.binarySha256, "fixed binary unchanged");
  assert(evidence.modelRequests.length > 0, "real Core used local deterministic model");
} catch (error) {
  failure = error;
  evidence.error = { message: error.message, stack: error.stack };
} finally {
  for (const core of coreClients) core.socket.close();
  host.close();
  const cleanup = new HostClient();
  let cleanupIdentity;
  try {
    await cleanup.connect(home);
    const identity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
    assert.equal(identity.hostId, cleanup.hostId);
    assert.equal(identity.generation, cleanup.generation);
    cleanupIdentity = identity;
    const receipt = await cleanup.stop(randomUUID(), cleanup.generation, "cancel");
    assert.equal(receipt.state, "completed");
    cleanup.close();
    await waitExit(identity.pid);
    evidence.cleanup.push({ pid: identity.pid, stopped: true, receipt });
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) {
      evidence.cleanup.push({ error: error.message });
      failure ??= error;
      if (cleanupIdentity) {
        const current = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
        assert.deepEqual(
          current,
          cleanupIdentity,
          "failed cleanup still targets the same test Host",
        );
        cleanup.close();
        process.kill(current.pid, "SIGTERM");
        await waitExit(current.pid);
        evidence.cleanup.push({ pid: current.pid, forcedAfterFailure: true, stopped: true });
      }
    }
  } finally {
    cleanup.close();
  }
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  evidence.state = failure ? "failed" : "passed";
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
}
console.log(JSON.stringify({ state: evidence.state, root, checks: evidence.checks }));
if (failure) throw failure;
