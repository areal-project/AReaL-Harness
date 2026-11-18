import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { stopAndAssertFixtureHost } from "./application-cleanup.mjs";
import { makeTempDir } from "./support/temp.mjs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// 在原生 Host 的来源附件上读取状态，再与同配置的独立 CLI 对照。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { GuiSourceSession } = require("@areal/client/gui-source");
const {
  createNativeHostTransport,
} = require("../app/src/core/generated/native-host-transport.cjs");
const WebSocket = require("ws");
const { build } = createRequire(join(gui, "packages/browser-data/package.json"))("esbuild");
const scratch = await makeTempDir("atc-");
const clientBundle = join(scratch, "host-websocket.mjs");
await build({
  entryPoints: [join(gui, "packages/client/src/websocket.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: clientBundle,
});
const { connectWebSocket } = await import(pathToFileURL(clientBundle));
const { serviceOptions } = require("../app/src/core/service-config.cjs");
const execute = promisify(execFile);
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const checks = [];
for (const key of Object.keys(process.env)) {
  if (/^AREAL_|^ELECTRON_RUN_AS_NODE$/.test(key)) delete process.env[key];
}
process.env.HOME = join(scratch, "os-home");
process.env.AREAL_CORE_BIN = binary;
process.env.AREAL_CORE_HOME = join(scratch, "gui-home");
const app = {
  isPackaged: false,
  getPath: (name) => (name === "home" ? process.env.HOME : join(scratch, name)),
};
async function config(path, label, explicitSpool = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `schema_version = 1\n[trajectory]\nenabled = false\nendpoint = "https://${label}.example.test"\n${explicitSpool ? `spool_dir = "queue-${label}"\n` : ""}`,
  );
  return path;
}
async function check(options, expectedPath, label, explicitSpool = false) {
  const evidence = join(scratch, "checks", `${checks.length}-${label}`);
  await mkdir(evidence, { recursive: true });
  const environment = {
    ...process.env,
    HOME: options.userHome || process.env.HOME,
    AREAL_CORE_USER_HOME: options.userHome || process.env.HOME,
    AREAL_HARNESS_HOME: options.configHome,
    AREAL_HARNESS_SERVICE_HOME: options.hostHome,
  };
  const configurationHome = options.configHome;
  const sourceID = createHash("sha256")
    .update(await realpath(expectedPath))
    .digest("hex");
  const expectedSpool = explicitSpool
    ? join(dirname(expectedPath), `queue-${label}`)
    : expectedPath === join(configurationHome, "config.toml")
      ? join(configurationHome, "trajectory")
      : join(configurationHome, "trajectory-sources", sourceID);
  // 服务登记位置不改变 GUI 与独立 CLI 所读的配置和默认轨迹队列。
  const cliEnvironment = { ...environment };
  delete cliEnvironment.AREAL_HARNESS_SERVICE_HOME;
  const { stdout } = await execute(
    binary,
    ["trajectory", "status", ...(options.config ? ["--config", options.config] : [])],
    { env: cliEnvironment },
  );
  const cliStatus = JSON.parse(stdout);
  assert.equal(cliStatus.configPath, expectedPath);
  assert.equal(cliStatus.spool_dir, expectedSpool);
  const launch = {
    ...options,
    userHome: environment.HOME,
    guiProfile: join(evidence, "profile"),
    home: join(evidence, "core"),
    harnessHome: join(evidence, "prior-registry"),
  };
  const source = new GuiSourceSession({
    binary,
    home: options.hostHome,
    source: {
      profile: launch.guiProfile,
      coreHome: launch.home,
      legacyServiceHome: launch.harnessHome,
    },
    singletonHeld: true,
  });
  let attachment,
    web,
    stage = "source publication";
  try {
    await source.init();
    stage = "configuration preparation";
    const prepared = await source.prepareNative(launch, environment);
    stage = "desktop attachment";
    attachment = await createNativeHostTransport({
      home: source.home,
      sourceId: source.sourceId,
      launch: prepared.options,
      environmentCredentials: source.environmentCredentials,
      onCallback: async () => {
        throw new Error("Unexpected desktop tool callback");
      },
      onEvent: () => {},
      onClosed: () => {},
    });
    stage = "loopback negotiation";
    const origin = "areal-ui://app";
    const ticket = await source.client.request("web.ticket", {
      origin,
      expectedGeneration: source.client.generation,
    });
    web = await connectWebSocket(
      { origin, writes: true, bootstrap: async () => ticket },
      () => true,
      AbortSignal.timeout(20000),
      () => {},
      () => {},
      (url) => new WebSocket(url, { origin, followRedirects: false }),
    );
    stage = "trajectory status";
    const status = await web.transport.request("trajectory.read", {
      sourceId: source.sourceId,
      operation: "status",
    });
    assert.equal(status.configPath, cliStatus.configPath);
    assert.equal(status.spool_dir, cliStatus.spool_dir);
    assert.equal(status.config_revision, cliStatus.config_revision);
    assert.equal(status.endpoint, `https://${label}.example.test/`);
    assert.equal(status.state, "disabled");
    assert.equal(status.worker_running, false);
    assert.deepEqual(status.records, []);
  } catch (error) {
    throw new Error(`${label}: ${stage}`, { cause: error });
  } finally {
    web?.transport.close();
    attachment?.close();
    source.close();
    const descriptor = await readFile(join(options.hostHome, "host/host.json")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (descriptor) await stopAndAssertFixtureHost(binary, environment, evidence);
  }
  checks.push(label);
  return expectedPath === join(configurationHome, "config.toml")
    ? join(await realpath(configurationHome), "trajectory")
    : expectedSpool;
}
const options = serviceOptions(app);
// 开发配置与安装版隔离，CLI 读管理配置时仍须遵循同一配置根。
const installedFile = await config(join(process.env.HOME, ".areal", "config.toml"), "installed");
const defaultFile = await config(join(options.configHome, "config.toml"), "shared-default");
assert.notEqual(defaultFile, installedFile);
const sharedSpool = await check(options, defaultFile, "shared-default");
assert.equal(options.harnessHome, options.configHome);
process.env.AREAL_HARNESS_SERVICE_HOME = join(scratch, "fixed-registry");
const registryOptions = serviceOptions(app);
assert.notEqual(registryOptions.harnessHome, registryOptions.configHome);
assert.equal(await check(registryOptions, defaultFile, "shared-default"), sharedSpool);
process.env.AREAL_CORE_USER_HOME = join(scratch, "core-user-home");
const userOptions = serviceOptions(app);
const userFile = await config(join(userOptions.configHome, "config.toml"), "core-user-home");
await check(userOptions, userFile, "core-user-home");
process.env.AREAL_HARNESS_HOME = join(scratch, "explicit-home");
const homeOptions = serviceOptions(app);
const homeFile = await config(join(process.env.AREAL_HARNESS_HOME, "config.toml"), "explicit-home");
await check(homeOptions, homeFile, "explicit-home");
assert.equal(
  homeOptions.harnessHome,
  registryOptions.harnessHome,
  "explicit service home wins over configuration home",
);
process.env.AREAL_HARNESS_HOME = join(scratch, "other-home");
const otherHomeOptions = serviceOptions(app);
const otherHomeFile = await config(
  join(process.env.AREAL_HARNESS_HOME, "config.toml"),
  "other-home",
);
await check(otherHomeOptions, otherHomeFile, "other-home");
const aliasHome = join(scratch, "alias-home");
await symlink(process.env.AREAL_HARNESS_HOME, aliasHome);
process.env.AREAL_HARNESS_HOME = aliasHome;
assert.equal(
  await check(serviceOptions(app), join(aliasHome, basename(otherHomeFile)), "other-home"),
  join(otherHomeOptions.configHome, "trajectory"),
  "an alias of the same configuration home uses the original queue",
);
process.env.AREAL_HARNESS_HOME = otherHomeOptions.configHome;
const environmentFile = await config(
  join(scratch, "env config", "selected.toml"),
  "environment-file",
);
process.env.AREAL_HARNESS_CONFIG = relative(process.cwd(), environmentFile);
const environmentOptions = serviceOptions(app);
const otherEnvironmentFile = await config(
  join(scratch, "other env config", "selected.toml"),
  "environment-other",
);
process.env.AREAL_HARNESS_CONFIG = relative(process.cwd(), otherEnvironmentFile);
const otherEnvironmentOptions = serviceOptions(app);
const environmentSpool = await check(environmentOptions, environmentFile, "environment-file");
const otherEnvironmentSpool = await check(
  otherEnvironmentOptions,
  otherEnvironmentFile,
  "environment-other",
);
assert.notEqual(
  environmentSpool,
  otherEnvironmentSpool,
  "independent configuration files have separate default trajectory queues",
);
const explicitFile = await config(
  join(scratch, "explicit config", "selected.toml"),
  "explicit-file",
  true,
);
process.env.AREAL_CORE_CONFIG = relative(process.cwd(), explicitFile);
await check(serviceOptions(app), explicitFile, "explicit-file", true);
const manifest = {
  passed: true,
  checks,
  scope:
    "native Host trajectory.read and CLI parity for isolated configuration sources; no Core or uploader launch",
};
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest, evidence: scratch }));
