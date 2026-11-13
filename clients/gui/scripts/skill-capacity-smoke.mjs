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
const { ScopedResources } = require("@areal/workbench-service/desktop/core/scoped-resources.cjs");
const { executeCore } = createRequire(import.meta.url)("./support/core-process-fixture.cjs");
const { BUILTIN_SKILL_ID } = require("@areal/workbench-service/desktop/core/builtin-skills.cjs");
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
  ...process.env,
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
  const project = { id: label, root };
  const backend = {
    home,
    userHome,
    saved: [project],
    desktopConfig: require.resolve("@areal/workbench-service/desktop/core/desktop-profile.json"),
    save: (name, value) => writeFile(join(home, name), JSON.stringify(value)),
  };
  const resources = new ScopedResources(backend);
  await resources.init();
  return { home, userHome, root, project, resources };
}
async function skill(base, id) {
  const root = join(base, ".agents/skills", id);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    `---\nname: ${id}\ndescription: Capacity fixture\n---\nInstructions for ${id}.\n`,
  );
  return root;
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
  const history = await fixture("history");
  for (let i = 0; i < 7; i++) await skill(history.userHome, `old-${i}`);
  const previous = await history.resources.deployment(history.project);
  let service = await start(history, previous);
  const oldThread = await create(service, previous);
  const oldCatalog = await list(service, oldThread);
  assert.equal(oldCatalog.length, 8);
  assert.ok(oldCatalog.some((skill) => skill.id === BUILTIN_SKILL_ID));
  const oldSkills = oldCatalog.filter((skill) => skill.id !== BUILTIN_SKILL_ID);
  assert.equal(oldSkills.length, 7);
  await stop(service);
  history.resources.value.skills.user = Object.fromEntries(oldSkills.map((s) => [s.id, false]));
  for (let i = 0; i < 151; i++) await skill(history.root, `current-${String(i).padStart(3, "0")}`);
  const current = await history.resources.deployment(history.project);
  const catalog = JSON.parse(await readFile(current.path, "utf8"));
  assert.equal(catalog.skills.length, 159);
  assert.equal(catalog.profiles.at(-1).skills.length, 152);
  service = await start(history, current);
  const thread = await create(service, current);
  const currentCatalog = await list(service, thread);
  assert.equal(currentCatalog.length, 152);
  assert.ok(currentCatalog.some((skill) => skill.id === BUILTIN_SKILL_ID));
  const currentSkills = currentCatalog.filter((skill) => skill.id !== BUILTIN_SKILL_ID);
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
  // The mandatory built-in skill occupies one of the 512 registered slots.
  for (let i = 0; i < 511; i++)
    await skill(i < 256 ? capacity.userHome : capacity.root, `skill-${String(i).padStart(3, "0")}`);
  const full = await capacity.resources.deployment(capacity.project);
  service = await start(capacity, full);
  const fullThread = await create(service, full);
  const fullSkills = await list(service, fullThread);
  assert.equal(fullSkills.length, 512);
  assert.ok(fullSkills.some((skill) => skill.id === BUILTIN_SKILL_ID));
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
  const references = await readFile(join(capacity.home, "capacity-skills.json"), "utf8");
  const extraRoot = await skill(capacity.root, "extra");
  await assert.rejects(capacity.resources.deployment(capacity.project), /513.*512/);
  assert.equal(await readFile(full.path, "utf8"), saved);
  assert.equal(await readFile(join(capacity.home, "capacity-skills.json"), "utf8"), references);
  const oversized = JSON.parse(saved);
  oversized.skills.push({ id: "extra", revision: "v1", root: extraRoot });
  const overflow = join(capacity.home, "overflow.json");
  await writeFile(overflow, JSON.stringify(oversized));
  let startupError;
  await assert.rejects(start(capacity, { path: overflow }), (error) => {
    startupError = error.stderr || error.message;
    assert.match(error.stderr || error.message, /skills 513 \(limit 512\)/);
    return true;
  });
  await writeFile(join(scratch, "core-overflow-stderr.txt"), startupError);
  checks.push(
    "GUI and real Core accept 512 and reject 513 registered versions without overwriting the saved GUI deployment",
  );

  const directory = await fixture("directory");
  const root = join(directory.userHome, ".agents/skills");
  await skill(directory.userHome, "valid");
  for (let i = 0; i < 511; i++) await writeFile(join(root, `entry-${i}.txt`), "index");
  assert.equal((await directory.resources.scan("user"))[0].id, "valid");
  await writeFile(join(root, "extra.txt"), "index");
  await assert.rejects(directory.resources.scan("user"), /513.*512/);
  checks.push("GUI scan counts raw directory entries and enforces the 512/513 boundary");
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
