import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { GuiHostProjects, requestIdFor } = require("../app/src/core/gui-host-projects.cjs");
const { HostClient } = require("../app/src/core/host-client.cjs");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = join(
  process.env.AREAL_TEST_BIN_DIR || join(repository, ".local/shared-host-bin"),
  "areal",
);
const root = await realpath(await mkdtemp("/tmp/ah-gui-lifecycle-"));
const home = join(root, "host");
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
const user = join(root, "user");
const workspace = join(root, "workspace");
for (const path of [home, user, workspace, ...Object.values(source)])
  await mkdir(path, { mode: 0o700 });
await writeFile(join(source.coreHome, "projects.json"), "[]", { mode: 0o600 });
const owner = new GuiHostProjects({ binary, home, source, singletonHeld: true });
const checks = [];
const clients = [owner.client];
try {
  await owner.init();
  assert.ok(owner.sourceId);
  checks.push("ordinary-owner-source-init-empty-secret-manifest");
  const id = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  const project = {
    id,
    root: workspace,
    worktreeResources: "fixture-resources",
    projectless: true,
    projectlessRequestId: randomUUID(),
  };
  await owner.register(requestIdFor(`${owner.sourceId}:register:${id}`), project);
  await writeFile(join(source.coreHome, "projects.json"), JSON.stringify([project]), {
    mode: 0o600,
  });
  assert.deepEqual((await owner.list())[0], project);
  const binding = owner.resolve(id);
  assert.equal(binding.dataDir, join(source.coreHome, id, "state"));
  assert.deepEqual((await owner.journal(id).read()).snapshot, {
    version: 1,
    pending: [],
    outcomes: {},
  });
  await mkdir(binding.scratchDir, { recursive: true, mode: 0o700 });
  const launch = {
    workspace,
    cwd: workspace,
    configHome: user,
    homedir: user,
    environment: { PATH: process.env.PATH },
    credentialNames: [],
    options: {
      workspace,
      data_dir: binding.dataDir,
      scratch: binding.scratchDir,
      allow_write: true,
      allow_network: false,
      allow_concurrent_writes: false,
      read_only_path: [],
      task_credential_command: [],
      no_deployment_mcp: false,
      sandbox_profile: "native",
    },
  };
  const started = await owner.ensure(randomUUID(), id, launch);
  assert.equal(started.descriptor.owner.kind, "host");
  assert.equal(started.descriptor.owner.hostId, owner.client.hostId);
  owner.close();
  const observer = new GuiHostProjects({ binary, home, source, singletonHeld: false });
  clients.push(observer.client);
  await observer.init();
  const observed = await observer.observe(id);
  assert.equal(observed.descriptor.generation, started.descriptor.generation);
  checks.push("gui-client-disconnect-keeps-host-core-generation");
  const requestId = randomUUID();
  const receipt = await observer.stop(requestId, id, observed.descriptor.generation, "ifIdle");
  assert.equal(receipt.state, "completed");
  assert.deepEqual(await observer.operation(requestId), receipt);
  await assert.rejects(observer.observe(id), (error) => error.code === "CORE_STOPPED");
  assert.equal((await observer.status(id)).state, "stopped");
  checks.push("original-stop-receipt-and-passive-observation-no-restart");
  const cliWorkspace = join(root, "cli-workspace");
  await mkdir(cliWorkspace);
  await observer.client.registerProject(randomUUID(), {
    projectId: "cli-test-project",
    workspace: cliWorkspace,
    dataDir: join(root, "cli-data"),
    source: { kind: "cli" },
    defaultBinding: true,
  });
  const listed = await observer.list();
  const cli = listed.find((item) => item.root === cliWorkspace);
  assert.match(cli.id, /^[a-f0-9]{24}$/);
  assert.equal(observer.resolve(cli.id).projectId, "cli-test-project");
  assert.equal(observer.resolve(cli.id).dataDir, join(root, "cli-data"));
  assert.deepEqual((await observer.journal(cli.id).read()).snapshot, {
    version: 1,
    pending: [],
    outcomes: {},
  });
  checks.push("cli-registration-stable-local-alias-and-original-store");
  const reopened = await observer.ensure(randomUUID(), id, launch);
  assert.notEqual(reopened.descriptor.generation, observed.descriptor.generation);
  checks.push("explicit-open-creates-successor-after-completed-stop");
  const stopped = await observer.client.request("host.stop", {
    requestId: randomUUID(),
    expectedGeneration: observer.client.generation,
    strategy: "ifIdle",
  });
  assert.equal(stopped.state, "completed");
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        root,
        binary,
        checks,
        excluded: [
          "Electron singleton",
          "legacy writer handoff",
          "Keychain",
          "provider",
          "package",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, checks }));
} finally {
  for (const client of clients) client.close();
  const cleanup = new HostClient();
  try {
    await cleanup.connect(home);
    const stopped = await cleanup.request("host.stop", {
      requestId: randomUUID(),
      expectedGeneration: cleanup.generation,
      strategy: "cancel",
    });
    assert.equal(stopped.state, "completed");
  } catch (error) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(error.code) &&
      !error.message.includes("connection closed")
    )
      console.error("cleanup", error.message);
  } finally {
    cleanup.close();
  }
}
