import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 真实 CLI 只读管理链路；不初始化适配器、Core、模型或上传进程。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { serviceOptions, serviceIdentity } = require("../app/src/core/service-config.cjs");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const scratch = await mkdtemp(join(tmpdir(), "areal-trajectory-config-"));
const checks = [];
for (const key of Object.keys(process.env)) {
  if (/^AREAL_(CORE|HARNESS)_/.test(key)) delete process.env[key];
}
process.env.HOME = join(scratch, "os-home");
process.env.AREAL_CORE_BIN = binary;
process.env.AREAL_CORE_HOME = join(scratch, "gui-home");
process.env.AREAL_CORE_USER_HOME = join(scratch, "core-user-home");
const app = {
  isPackaged: false,
  getPath: (name) => (name === "home" ? process.env.HOME : join(scratch, name)),
};
async function config(path, label) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `schema_version = 1\n[trajectory]\nenabled = false\nendpoint = "https://${label}.example.test"\nspool_dir = "queue-${label}"\n`,
  );
  return path;
}
async function check(options, expectedPath, label) {
  const backend = new CoreBackend(options);
  assert.equal(backend.hooks.environment().HOME, process.env.AREAL_CORE_USER_HOME);
  assert.equal(backend.hooks.environment().AREAL_HARNESS_HOME, options.harnessHome);
  for (const project of ["project-a", "project-b"]) {
    backend.saved = [{ id: project, root: join(scratch, project) }];
    const status = await backend.trajectory.command({ operation: "status" });
    assert.equal(status.configPath, expectedPath);
    assert.equal(status.spool_dir, join(dirname(expectedPath), `queue-${label}`));
    assert.equal(status.endpoint, `https://${label}.example.test/`);
    assert.equal(status.state, "disabled");
    assert.equal(status.worker_running, false);
    assert.deepEqual(status.records, []);
  }
  checks.push(label);
}
const options = serviceOptions(app);
const defaultFile = await config(join(options.harnessHome, "config.toml"), "gui-default");
await check(options, defaultFile, "gui-default");
process.env.AREAL_HARNESS_HOME = join(scratch, "explicit-home");
const homeOptions = serviceOptions(app);
const homeFile = await config(join(homeOptions.harnessHome, "config.toml"), "explicit-home");
await check(homeOptions, homeFile, "explicit-home");
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
await check(environmentOptions, environmentFile, "environment-file");
await check(otherEnvironmentOptions, otherEnvironmentFile, "environment-other");
const explicitFile = await config(
  join(scratch, "explicit config", "selected.toml"),
  "explicit-file",
);
process.env.AREAL_CORE_CONFIG = relative(process.cwd(), explicitFile);
await check(serviceOptions(app), explicitFile, "explicit-file");
const manifest = {
  passed: true,
  checks,
  scope:
    "real GUI service options, CoreBackend/AppHooks and read-only trajectory CLI; two project selections; no Core or worker launch",
};
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest, evidence: scratch }));
