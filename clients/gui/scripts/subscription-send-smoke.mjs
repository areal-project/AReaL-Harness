import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { makeTempDir } from "./support/temp.mjs";

const mode = process.argv[2];
assert.ok(
  process.argv.length <= 3 && [undefined, "--startup", "--worktree"].includes(mode),
  "Use test:subscription-send with optional --startup or --worktree",
);
const root = resolve(import.meta.dirname, "../../..");
const scratch = await makeTempDir("areal-sub-send-");
const user = join(scratch, "user");
await mkdir(user);
const isolated = { ...process.env };
for (const key of Object.keys(isolated)) {
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key)) delete isolated[key];
}
Object.assign(isolated, {
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: user,
  AREAL_GUI_USER_DATA: join(scratch, "gui"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
});
const run = (program, args, env) => {
  const result = spawnSync(program, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} exited with ${result.signal ?? result.status}`);
};
run(
  "cargo",
  [
    "test",
    "--locked",
    "-p",
    "areal-host",
    "subscription::stream_tests::",
    "--",
    "--test-threads=4",
  ],
  isolated,
);
// 合成目录与推理在原生 Host 测试中验证，桌面入口复用现有工作树和恢复旅程。
const desktop =
  mode === "--startup"
    ? ["lifecycle-smoke.mjs"]
    : mode === "--worktree"
      ? ["worktree-environment-smoke.mjs"]
      : ["lifecycle-smoke.mjs", "worktree-environment-smoke.mjs"];
for (const script of desktop) {
  run(process.execPath, [join(import.meta.dirname, script)], {
    ...isolated,
    AREAL_CORE_BIN: resolve(process.env.AREAL_CORE_BIN || join(root, "target/debug/areal")),
  });
}
