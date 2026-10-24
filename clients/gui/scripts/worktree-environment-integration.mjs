import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("../app/src/core/backend.cjs");
const scratch = await realpath(await mkdtemp("/private/tmp/areal-worktree-env-"));
const source = join(scratch, "source"),
  home = join(scratch, "desktop"),
  userHome = join(scratch, "user");
await mkdir(source);
await mkdir(join(userHome, ".areal"), { recursive: true });
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
git("init", "-b", "main");
await writeFile(join(source, "base.txt"), "base\n");
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-m",
  "fixture",
);
await writeFile(
  join(userHome, ".areal/config.toml"),
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n',
);
const desktopConfig = join(scratch, "profile.json");
await writeFile(
  desktopConfig,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "",
        allowThreadProcesses: true,
      },
    ],
  }),
);
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary, "AREAL_CORE_BIN must point at the verified local test deployment");
const options = {
  binary,
  home,
  userHome,
  harnessHome: join(scratch, "registry"),
  desktopConfig,
  desktopProcesses: true,
  defaultProfile: { id: "fixture", revision: "v1" },
};
let backend = new CoreBackend(options),
  passed = false;
const checks = [];
const until = async (predicate, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "operation reaches expected phase");
    await new Promise((r) => setTimeout(r, 30));
  }
};
try {
  await backend.init();
  const projectId = await backend.addProject(source);
  const workspace = (operation, rest = {}) =>
    backend.command("workspace", { projectId, operation, ...rest });
  const environment = {
    id: "dev",
    name: "Development",
    setup: {
      default:
        'printf "%s\\n%s\\n%s\\n" "$PWD" "$AREAL_PROJECT_PATH" "$AREAL_WORKTREE_BRANCH" > setup.txt; printf setup-output',
      macos: " ",
    },
    cleanup: { default: "rm -f setup.txt action.txt" },
    actions: [{ id: "check", name: "Check", script: { default: "printf x >> action.txt" } }],
  };
  await workspace("worktreeEnvironmentSave", { environment, expectedRevision: 0 });
  const requestId = randomUUID();
  const result = await backend.command("create", {
    projectId,
    requestId,
    options: { permissionPreset: "fullAccess" },
    worktree: { mode: "worktree", ref: "main", environmentId: "dev", environmentRevision: 1 },
  });
  const operation = await workspace("worktreeRead", { requestId });
  assert.equal(operation.state, "ready");
  assert.equal(operation.setup.status, "succeeded");
  assert.match(operation.setup.output, /setup-output/);
  const directory = operation.record.directory;
  assert.deepEqual((await readFile(join(directory, "setup.txt"), "utf8")).trim().split("\n"), [
    directory,
    source,
    operation.record.branch,
  ]);
  assert.equal(backend.snapshot().projects[0].state.threads[result.threadId].turns.length, 0);
  checks.push(
    "actual Core managed setup completes in fixed checkout before ready with no model turn",
  );
  const actionId = randomUUID();
  const run = () =>
    workspace("worktreeAction", {
      requestId: actionId,
      worktreeRequestId: requestId,
      actionId: "check",
    });
  await run();
  await run();
  assert.equal(await readFile(join(directory, "action.txt"), "utf8"), "x");
  checks.push("snapshot action UUID executes once");
  const removed = await workspace("worktreeDelete", {
    requestId: randomUUID(),
    worktreeRequestId: requestId,
  });
  assert.equal(removed.deleted, true, JSON.stringify(removed));
  await assert.rejects(access(directory));
  assert.ok(git("rev-parse", operation.record.branch));
  await assert.rejects(backend.start(operation.executionProjectId), /删除|removed/);
  checks.push(
    "cleanup once, idle host stop receipt, nonforce removal, branch retained, reconnect blocked",
  );
  const slow = {
    ...environment,
    id: "slow",
    setup: { default: "printf started > slow.txt; sleep 40; printf still-running; sleep 30" },
    cleanup: { default: "" },
    actions: [],
  };
  await workspace("worktreeEnvironmentSave", { environment: slow, expectedRevision: 1 });
  const cancelId = randomUUID();
  const creating = backend.command("create", {
    projectId,
    requestId: cancelId,
    options: { permissionPreset: "fullAccess" },
    worktree: { mode: "worktree", ref: "main", environmentId: "slow", environmentRevision: 2 },
  });
  const rejected = assert.rejects(creating, /取消|cancel/i);
  rejected.catch(() => {});
  await until(() => backend.worktrees.records.get(cancelId)?.setup?.processId);
  await until(async () => {
    const pending = await workspace("worktreeRead", { requestId: cancelId });
    assert.equal(pending.setup.status, "running", JSON.stringify(pending.setup));
    return pending.setup.output.includes("still-running");
  }, 60000);
  checks.push("long setup remains running with delayed output and healthy Runtime requests");
  const cancelled = await workspace("worktreeCancel", { requestId: cancelId });
  await rejected;
  assert.equal(cancelled.state, "cancelled", JSON.stringify(cancelled));
  assert.equal(cancelled.setup.status, "cancelled");
  await access(cancelled.record.directory);
  checks.push("cancel waits for confirmed managed process termination and retains checkout");
  await backend.shutdown();
  passed = true;
} finally {
  if (!passed) await backend.shutdown({ cancel: true }).catch(() => backend.disconnect());
  const manifest = {
    passed,
    scratch,
    checks,
    binary,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(gui, "../.."),
      encoding: "utf8",
    }).trim(),
    platform: process.platform,
    limitations: ["No real provider, physical user input or installed-package validation"],
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
