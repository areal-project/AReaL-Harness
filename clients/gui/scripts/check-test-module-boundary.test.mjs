import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./check-test-module-boundary.mts", import.meta.url));

test("GUI gate grandfathers existing modules and rejects new or renamed business modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-gui-module-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const put = async (path, content = "export {};") => {
    const target = join(root, "clients/gui", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const run = () => spawnSync(process.execPath, [cli, "HEAD", root], { encoding: "utf8" });
  git("init", "-q");
  await put(
    "package.json",
    JSON.stringify({ scripts: { "test:smoke": "node scripts/smoke.mjs" } }),
  );
  await put(
    "scripts/test-manifest.json",
    JSON.stringify([{ script: "test:smoke", testFiles: ["scripts/helper.cjs"] }]),
  );
  await put("renderer/src/existing.mjs");
  await put("renderer/src/page.ts");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "baseline",
  );

  await put("scripts/helper.cjs", "module.exports = {};");
  await put("scripts/smoke.mjs", 'import "./helper.cjs";');
  await put("renderer/src/state.test.mjs");
  await put("renderer/src/existing.mjs", "export const updated = true;");
  assert.equal(run().status, 0);

  await put("renderer/src/page.ts", 'export * from "@/state.test.mjs";');
  const imported = run();
  assert.equal(imported.status, 1);
  assert.match(imported.stderr, /page\.ts:.*state\.test\.mjs/);

  await put("renderer/src/page.ts");
  await rename(
    join(root, "clients/gui/renderer/src/existing.mjs"),
    join(root, "clients/gui/renderer/src/moved.mjs"),
  );
  await put("scripts/shipped.cjs", "module.exports = {};");
  git("add", "-A");
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /renderer\/src\/moved\.mjs: 新增/);
  assert.match(rejected.stderr, /scripts\/shipped\.cjs: 新增/);
});
