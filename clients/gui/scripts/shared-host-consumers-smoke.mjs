import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { waitForProcessExit } = require("../app/src/core/service-client.cjs");
const { GuiHostProjects } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const { HostClient } = createRequire(new URL("../app/package.json", import.meta.url))(
  "@areal/client/node",
);
const { AppProviders } = require("@areal/workbench-service/desktop/core/providers.cjs");
const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = process.env.AREAL_TEST_BIN_DIR
  ? join(process.env.AREAL_TEST_BIN_DIR, "areal")
  : (process.env.AREAL_CORE_BIN ?? join(repository, ".local/shared-host-bin/areal"));
const root = await realpath(await trackedMkdtemp("/tmp/ah-consumers-"));
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
const home = join(root, "host");
const user = join(root, "user");
const workspace = join(root, "cli-workspace");
const guiWorkspace = join(root, "gui-workspace");
for (const path of [home, user, workspace, guiWorkspace, ...Object.values(source)])
  await mkdir(path, { mode: 0o700 });
const config = join(user, "config.toml");
await writeFile(
  config,
  'schema_version = 1\n[model]\nname = "fixture"\n[model.providers.default]\napi_key_env = "FIXTURE_API_KEY"\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:1"\n',
  { mode: 0o600 },
);
const environment = {
  HOME: user,
  PATH: process.env.PATH,
  AREAL_HARNESS_HOME: user,
  FIXTURE_API_KEY: "dummy-api-key",
};
const snapshot = JSON.parse(
  (await run(binary, ["config", "models", "read", "--config", config], { env: environment }))
    .stdout,
);
const cliProject = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", root: workspace };
await writeFile(join(source.coreHome, "projects.json"), JSON.stringify([cliProject]), {
  mode: 0o600,
});
const cli = new HostClient();
const owner = new GuiHostProjects({ binary, home, source, singletonHeld: true });
let hostPid;
try {
  await cli.connectOrStart(home, binary);
  hostPid = JSON.parse(await readFile(join(home, "host/host.json"), "utf8")).pid;
  await cli.registerProject(randomUUID(), {
    projectId: "original-cli-project",
    workspace,
    dataDir: join(source.coreHome, cliProject.id, "state"),
    source: { kind: "cli" },
    defaultBinding: true,
  });
  await owner.init();
  const binding = owner.resolve(cliProject.id);
  assert.equal(binding.projectId, "original-cli-project");
  assert.equal(binding.registration.source.kind, "cli");
  assert.equal(
    AppProviders.prototype.manages.call({ backend: { host: owner } }, cliProject),
    false,
  );

  const guiProject = { id: "bbbbbbbbbbbbbbbbbbbbbbbb", root: guiWorkspace };
  await owner.register(randomUUID(), guiProject);
  const backend = {
    home: source.coreHome,
    host: owner,
    config,
    configHome: user,
    userHome: user,
    desktopProcesses: false,
    sandboxProfile: "native",
    resources: { deployment: async () => ({}), beforeCreate: async () => {} },
    providers: {
      manages: (project) =>
        AppProviders.prototype.manages.call({ backend: { host: owner } }, project),
      prepare: async () => {},
      config: { current: async () => snapshot },
      snapshot: () => snapshot,
      environment: () => ({}),
    },
    hooks: {
      launch: async () => ({ value: {}, revision: "fixture" }),
      environment: () => environment,
    },
  };
  const launch = await CoreBackend.prototype.prepareServiceLaunch.call(backend, guiProject, {
    advance() {},
  });
  assert.deepEqual(launch.launchInputs.credentialNames, ["FIXTURE_API_KEY"]);
  assert.deepEqual(launch.credentials, { FIXTURE_API_KEY: "dummy-api-key" });
  assert.equal(JSON.stringify(launch.launchInputs).includes("dummy-api-key"), false);
  const guiStarted = await owner.ensure(
    randomUUID(),
    guiProject.id,
    launch.launchInputs,
    launch.credentials,
  );
  assert.equal(guiStarted.descriptor.state, "ready");

  await mkdir(binding.scratchDir, { recursive: true, mode: 0o700 });
  const cliStarted = await cli.ensureProject(
    randomUUID(),
    binding.projectId,
    {
      ...launch.launchInputs,
      workspace,
      cwd: workspace,
      options: {
        ...launch.launchInputs.options,
        workspace,
        data_dir: binding.dataDir,
        scratch: binding.scratchDir,
      },
    },
    launch.credentials,
  );
  const project = { ...cliProject, pending: [] };
  backend.prepareServiceLaunch = () =>
    assert.fail("foreign project must not prepare GUI resources");
  await CoreBackend.prototype.launch.call(backend, project);
  assert.equal(project.service.generation, cliStarted.service.generation);
  const result = {
    root,
    checks: [
      "named-credential-ready-with-secret-outside-launch",
      "equivalent-cli-binding-keeps-configuration-owner",
      "foreign-core-generation-preserved",
    ],
  };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  try {
    if (cli.socket && !cli.socket.destroyed)
      assert.equal(
        (
          await cli.request("host.stop", {
            requestId: randomUUID(),
            expectedGeneration: cli.generation,
            strategy: "cancel",
          })
        ).state,
        "completed",
      );
  } finally {
    owner.close();
    cli.close();
  }
  if (hostPid) await waitForProcessExit(hostPid);
  await rm(root, { recursive: true, force: true });
}
