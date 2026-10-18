import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 真实 CLI 只读管理链路；不初始化适配器、Core、模型或上传进程。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { serviceOptions, serviceIdentity } = require("../app/src/core/service-config.cjs");
const execute = promisify(execFile);
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "areal-trajectory-config-")));
const checks = [];
for (const key of Object.keys(process.env)) {
  if (/^AREAL_(CORE|HARNESS)_/.test(key)) delete process.env[key];
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
  const backend = new CoreBackend(options);
  const environment = backend.hooks.environment();
  assert.equal(environment.HOME, options.userHome || process.env.HOME);
  assert.equal(environment.AREAL_HARNESS_HOME, process.env.AREAL_HARNESS_HOME);
  assert.equal(environment.AREAL_HARNESS_SERVICE_HOME, options.harnessHome);
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
  for (const project of ["project-a", "project-b"]) {
    backend.saved = [{ id: project, root: join(scratch, project) }];
    const status = await backend.trajectory.command({ operation: "status" });
    assert.equal(status.configPath, expectedPath);
    assert.equal(status.spool_dir, expectedSpool);
    assert.equal(status.endpoint, `https://${label}.example.test/`);
    assert.equal(status.state, "disabled");
    assert.equal(status.worker_running, false);
    assert.deepEqual(status.records, []);
  }
  checks.push(label);
  return expectedSpool;
}
const options = serviceOptions(app);
const initialIdentity = await serviceIdentity(options);
const defaultFile = await config(join(process.env.HOME, ".areal", "config.toml"), "shared-default");
assert.equal(
  await serviceIdentity(options),
  initialIdentity,
  "first default configuration save preserves the background identity",
);
const sharedSpool = await check(options, defaultFile, "shared-default");
assert.notEqual(options.harnessHome, options.configHome);
process.env.AREAL_HARNESS_SERVICE_HOME = join(scratch, "fixed-registry");
const registryOptions = serviceOptions(app);
assert.equal(await check(registryOptions, defaultFile, "shared-default"), sharedSpool);
const defaultIdentity = await serviceIdentity(registryOptions);
process.env.AREAL_CORE_USER_HOME = join(scratch, "core-user-home");
const userOptions = serviceOptions(app);
const userFile = await config(
  join(process.env.AREAL_CORE_USER_HOME, ".areal", "config.toml"),
  "core-user-home",
);
await check(userOptions, userFile, "core-user-home");
assert.notEqual(await serviceIdentity(userOptions), defaultIdentity);
process.env.AREAL_HARNESS_HOME = join(scratch, "explicit-home");
const homeOptions = serviceOptions(app);
const homeFile = await config(join(process.env.AREAL_HARNESS_HOME, "config.toml"), "explicit-home");
await check(homeOptions, homeFile, "explicit-home");
assert.equal(
  homeOptions.harnessHome,
  registryOptions.harnessHome,
  "explicit service home wins over configuration home",
);
const homeIdentity = await serviceIdentity(homeOptions);
process.env.AREAL_HARNESS_HOME = join(scratch, "other-home");
const otherHomeOptions = serviceOptions(app);
const otherHomeFile = await config(
  join(process.env.AREAL_HARNESS_HOME, "config.toml"),
  "other-home",
);
await check(otherHomeOptions, otherHomeFile, "other-home");
assert.notEqual(
  await serviceIdentity(otherHomeOptions),
  homeIdentity,
  "different default configuration homes cannot attach the same GUI background service with a fixed registry",
);
const aliasHome = join(scratch, "alias-home");
await symlink(process.env.AREAL_HARNESS_HOME, aliasHome);
process.env.AREAL_HARNESS_HOME = aliasHome;
assert.equal(
  await serviceIdentity(serviceOptions(app)),
  await serviceIdentity(otherHomeOptions),
  "an alias of the same configuration home preserves identity",
);
process.env.AREAL_HARNESS_HOME = otherHomeOptions.configHome;
const environmentFile = await config(
  join(scratch, "env config", "selected.toml"),
  "environment-file",
);
process.env.AREAL_HARNESS_CONFIG = relative(process.cwd(), environmentFile);
const environmentOptions = serviceOptions(app);
const environmentIdentity = await serviceIdentity(environmentOptions);
const otherEnvironmentFile = await config(
  join(scratch, "other env config", "selected.toml"),
  "environment-other",
);
process.env.AREAL_HARNESS_CONFIG = relative(process.cwd(), otherEnvironmentFile);
const otherEnvironmentOptions = serviceOptions(app);
assert.notEqual(
  await serviceIdentity(otherEnvironmentOptions),
  environmentIdentity,
  "different AREAL_HARNESS_CONFIG files must not attach the same GUI background service",
);
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
    "real GUI service options, CoreBackend/AppHooks and read-only trajectory CLI; two project selections; no Core or worker launch",
};
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest, evidence: scratch }));
