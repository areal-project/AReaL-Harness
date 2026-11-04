"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(__dirname, "../../..");
const client = "clients/gui/packages/workbench/client";
const script = "clients/gui/scripts/check-desktop-ipc-freeze.cjs";
const transport = `${client}/desktop-contract/transport.cjs`;

test("desktop IPC freeze compares the actual base registry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "areal-ipc-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(source, client), path.join(root, client), { recursive: true });
  fs.mkdirSync(path.join(root, "clients/gui/scripts"), { recursive: true });
  fs.copyFileSync(path.join(source, script), path.join(root, script));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "freeze-test@example.invalid");
  git("config", "user.name", "Freeze Test");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const original = fs.readFileSync(path.join(root, transport), "utf8");
  const write = (content) => fs.writeFileSync(path.join(root, transport), content);
  const check = (revision = base) =>
    spawnSync(process.execPath, [script, "--base", revision], { cwd: root, encoding: "utf8" });
  assert.equal(check().status, 0);
  const deleted = original
    .replace('  list: ["service", "project", read],\n', "")
    .replace('"pluginComponents pluginStoreSnapshot', '"pluginStoreSnapshot');
  assert.notEqual(deleted, original);
  write(deleted);
  assert.equal(check().status, 0);
  write(
    original.replace(
      '  list: ["service", "project", read],',
      '  addedCommand: ["service", "project", read],\n  list: ["service", "project", read],',
    ),
  );
  let result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /command addedCommand/);
  console.log("Injected command failure:\n" + result.stderr.trim());
  write(
    original.replace(
      '"pluginComponents pluginStoreSnapshot',
      '"addedOperation pluginComponents pluginStoreSnapshot',
    ),
  );
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operation manage\.addedOperation/);
  console.log("Injected operation failure:\n" + result.stderr.trim());
  write(deleted);
  git("add", transport);
  git("commit", "-qm", "delete");
  const deletedBase = git("rev-parse", "HEAD");
  write(original);
  result = check(deletedBase);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /command list/);
  assert.match(result.stderr, /operation manage\.pluginComponents/);
  console.log("Reintroduced entries failure:\n" + result.stderr.trim());
  assert.equal(spawnSync(process.execPath, [script], { cwd: root }).status, 1);
});
