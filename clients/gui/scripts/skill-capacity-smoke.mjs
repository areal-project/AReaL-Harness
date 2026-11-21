import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CoreClient } from "../packages/runtime-client/core.js";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { executeCore } = createRequire(import.meta.url)("./support/core-process-fixture.cjs");
const builtin = {
  id: "openai-skill-creator",
  revision: "fixture-v1",
  root: join(gui, "packages/workbench/assets/builtin-skills/openai-skill-creator"),
};
const WebSocket = require("ws");
assert.ok(process.env.AREAL_CORE_BIN, "Set AREAL_CORE_BIN to the built Core under test");
const binary = resolve(process.env.AREAL_CORE_BIN);
const coreSha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const scratch = await makeTempDir("areal-skill-capacity-");
const checks = [];
const running = new Set();
const config = join(scratch, "config.toml");
await writeFile(
  config,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n',
);
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AREAL_"))),
  HOME: join(scratch, "process-home"),
  AREAL_HARNESS_HOME: join(scratch, "configuration"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_HARNESS_TOOL_EXTENSIONS: join(scratch, "tools.json"),
};
await mkdir(environment.HOME);
await writeFile(environment.AREAL_HARNESS_TOOL_EXTENSIONS, "{}");
async function fixture(label) {
  const home = join(scratch, label, "desktop");
  const userHome = join(scratch, label, "user");
  const root = join(scratch, label, "workspace");
  for (const path of [home, userHome, root, join(home, "scratch")])
    await mkdir(path, { recursive: true });
  return { home, userHome, root };
}
async function deployment(fixture, revision, current, previous) {
  const profile = { id: "fixture", revision };
  const definition = {
    ...profile,
    displayName: "Skill capacity fixture",
    instructions: "Read the requested skill.",
    skills: [...current, builtin].map(({ id, revision }) => ({ id, revision })),
  };
  const value = {
    profiles: [...(previous?.value.profiles ?? []), definition],
    skills: [
      ...(previous?.value.skills.filter(({ id }) => id !== builtin.id) ?? []),
      ...current,
      builtin,
    ],
  };
  const path = join(fixture.home, `deployment-${revision}.json`);
  await writeFile(path, JSON.stringify(value));
  return { path, profile, value };
}
async function skill(base, id) {
  const root = join(base, ".agents/skills", id);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${id}\ndescription: Capacity fixture\n---\nInstructions for ${id}.\n`,
  );
  return { id, revision: "fixture-v1", root };
}
async function core(args) {
  const { stdout } = await executeCore(binary, ["service", ...args, "--json"], {
    env: environment,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function start(f, deployment) {
  const descriptor = await core([
    "ensure",
    "--workspace",
    f.root,
    "--data-dir",
    join(f.home, "state"),
    "--scratch",
    join(f.home, "scratch"),
    "--config",
    config,
    "--desktop-config",
    deployment.path,
  ]);
  const entry = { descriptor, client: null };
  running.add(entry);
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const principal = auth.principals.find((p) => p.permissions.includes("manage"));
  entry.client = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${principal.token}` },
      }),
  });
  await entry.client.connect();
  entry.request = (method, params) => entry.client.request(method, params);
  return entry;
}
async function stop(entry) {
  entry.client?.close();
  const result = await core([
    "stop",
    "--instance",
    entry.descriptor.serviceId,
    "--expected-generation",
    entry.descriptor.generation,
  ]);
  assert.equal(result.state, "stopped");
  running.delete(entry);
}
async function create(entry, deployment) {
  return (
    await entry.request("areal/thread/start", {
      requestId: randomUUID(),
      agentProfile: deployment.profile,
    })
  ).thread;
}
const list = async (entry, thread) =>
  (await entry.request("areal/skill/list", { threadId: thread.id })).data;
const read = (entry, thread, reference, resource = "SKILL.md") =>
  entry.request("areal/skill/read", {
    threadId: thread.id,
    skill: { id: reference.id, revision: reference.revision },
    resource,
  });
let passed = false;
try {
  const linked = await fixture("linked");
  const target = await skill(join(scratch, "external"), "linked-skill");
  const linkedDeployment = await deployment(linked, "outside", [target]);
  const linkedService = await start(linked, linkedDeployment);
  const linkedThread = await create(linkedService, linkedDeployment);
  const linkedSkill = (await list(linkedService, linkedThread)).find(
    (s) => s.id === "linked-skill",
  );
  assert.ok(linkedSkill, "ordinary thread receives the linked user skill");
  assert.match(
    (await read(linkedService, linkedThread, linkedSkill)).text,
    /Instructions for linked-skill/,
  );
  await stop(linkedService);
  checks.push("ordinary thread lists and reads a registered skill outside its workspace");

  const history = await fixture("history");
  const original = [];
  for (let i = 0; i < 7; i++) original.push(await skill(history.userHome, `old-${i}`));
  const previous = await deployment(history, "previous", original);
  let service = await start(history, previous);
  const oldThread = await create(service, previous);
  const oldCatalog = await list(service, oldThread);
  assert.equal(oldCatalog.length, 8);
  assert.ok(oldCatalog.some((skill) => skill.id === builtin.id));
  const oldSkills = oldCatalog.filter((skill) => skill.id !== builtin.id);
  assert.equal(oldSkills.length, 7);
  await stop(service);
  const versions = [];
  for (let i = 0; i < 151; i++)
    versions.push(await skill(history.root, `current-${String(i).padStart(3, "0")}`));
  const current = await deployment(history, "current", versions, previous);
  const catalog = JSON.parse(await readFile(current.path, "utf8"));
  assert.equal(catalog.skills.length, 159);
  assert.equal(catalog.profiles.at(-1).skills.length, 152);
  service = await start(history, current);
  const thread = await create(service, current);
  const currentCatalog = await list(service, thread);
  assert.equal(currentCatalog.length, 152);
  assert.ok(currentCatalog.some((skill) => skill.id === builtin.id));
  const currentSkills = currentCatalog.filter((skill) => skill.id !== builtin.id);
  assert.equal(currentSkills.length, 151);
  assert.equal(currentSkills[0].id, "current-000");
  assert.equal(currentSkills.at(-1).id, "current-150");
  assert.equal(
    (await read(service, thread, currentSkills[150])).text.endsWith(
      "Instructions for current-150.\n",
    ),
    true,
  );
  assert.deepEqual(
    (await list(service, oldThread)).map((s) => s.id),
    oldCatalog.map((s) => s.id),
  );
  assert.equal(
    (await read(service, oldThread, oldSkills[0])).text.endsWith("Instructions for old-0.\n"),
    true,
  );
  await assert.rejects(read(service, thread, oldSkills[0]), /skill|scope|profile/i);
  await assert.rejects(read(service, oldThread, currentSkills[0]), /skill|scope|profile/i);
  await assert.rejects(read(service, thread, currentSkills[0], "../outside.txt"));
  await writeFile(join(scratch, "outside.txt"), "outside the registered skill");
  await symlink(
    join(scratch, "outside.txt"),
    join(history.root, ".agents/skills/current-000/linked.txt"),
  );
  await assert.rejects(read(service, thread, currentSkills[0], "linked.txt"));
  const selection = currentSkills.map(({ id, revision }) => ({ id, revision }));
  await assert.rejects(
    service.request("areal/thread/configure", {
      threadId: thread.id,
      expectedRevision: 1,
      selectedSkills: selection.slice(0, 129),
    }),
    /selected skills exceed budget/,
  );
  const configured = await service.request("areal/thread/configure", {
    threadId: thread.id,
    expectedRevision: 1,
    selectedSkills: selection.slice(0, 128),
  });
  assert.equal(configured.selectedSkills.length, 128);
  await stop(service);
  checks.push(
    "151 current plus 7 retained references survive a real Core restart with Profile, selectedSkills and path restrictions",
  );

  const capacity = await fixture("capacity");
  const registered = [];
  for (let i = 0; i < 511; i++)
    registered.push(
      await skill(
        i < 256 ? capacity.userHome : capacity.root,
        `skill-${String(i).padStart(3, "0")}`,
      ),
    );
  const full = await deployment(capacity, "capacity", registered);
  service = await start(capacity, full);
  const fullThread = await create(service, full);
  const fullSkills = await list(service, fullThread);
  assert.equal(fullSkills.length, 512);
  assert.ok(fullSkills.some((skill) => skill.id === builtin.id));
  for (const index of [0, 510])
    assert.equal(
      (
        await read(
          service,
          fullThread,
          fullSkills.find((skill) => skill.id === `skill-${String(index).padStart(3, "0")}`),
        )
      ).text.endsWith(`Instructions for skill-${String(index).padStart(3, "0")}.\n`),
      true,
    );
  await stop(service);
  const saved = await readFile(full.path, "utf8");
  const oversized = JSON.parse(saved);
  oversized.skills.push(await skill(capacity.root, "extra"));
  const overflow = join(capacity.home, "overflow.json");
  await writeFile(overflow, JSON.stringify(oversized));
  let startupError;
  // Host 可退回历史只读；容量边界在真正加载部署的 Core 启动入口验证。
  await assert.rejects(
    executeCore(
      binary,
      [
        "app-server",
        "--config",
        config,
        "--data-dir",
        join(capacity.home, "overflow-state"),
        "--desktop-config",
        overflow,
      ],
      { env: environment, cwd: capacity.root, timeout: 30000 },
    ),
    (error) => {
      startupError = error.stderr || error.message;
      assert.match(error.stderr || error.message, /skills 513 \(limit 512\)/);
      return true;
    },
  );
  await writeFile(join(scratch, "core-overflow-stderr.txt"), startupError);
  checks.push("real Core accepts 512 and rejects 513 registered versions at deployment load");

  passed = true;
} finally {
  const cleanup = await Promise.allSettled([...running].map(stop));
  const finalCoreSha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const services = await core(["list"]);
  const activeServices = services.filter((s) => !["stopped", "unavailable"].includes(s.state));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const pids = [...new Set(services.flatMap((s) => [s.corePid, s.hostPid]))].filter(
    (pid) => Number.isInteger(pid) && pid > 0,
  );
  let livePids = pids.filter(alive);
  const deadline = Date.now() + 5000;
  while (livePids.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    livePids = pids.filter(alive);
  }
  await writeFile(join(scratch, "services-after-cleanup.json"), JSON.stringify(services, null, 2));
  const report = {
    passed:
      passed &&
      cleanup.every((r) => r.status === "fulfilled") &&
      activeServices.length === 0 &&
      livePids.length === 0 &&
      finalCoreSha256 === coreSha256,
    scratch,
    binary,
    coreSha256,
    finalCoreSha256,
    checks,
    cleanup: cleanup.map((r) => r.status),
    services,
    livePids,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  for (const result of cleanup) assert.ifError(result.status === "rejected" ? result.reason : null);
  assert.equal(finalCoreSha256, coreSha256, "Core binary remains unchanged during acceptance");
  assert.deepEqual(activeServices, [], "No active service remains in the isolated registry");
  assert.deepEqual(livePids, [], "All observed Core and service host processes have exited");
}
