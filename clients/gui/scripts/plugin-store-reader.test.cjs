"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const {
  validateCommand,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
const {
  validateManagementResponse,
} = require("../packages/workbench/client/desktop-contract/management.cjs");
const snapshot = {
  revision: 0,
  scope: { kind: "user" },
  observedAt: 1,
  runtimeObserved: false,
  list: { revision: 0, data: [], marketplaces: [], errors: [] },
  detail: null,
};

test("offline requests allow a projectless read and reject caller supplied filesystem roots", () => {
  for (const operation of ["pluginStoreSnapshot", "pluginStoreDoctor"]) {
    const request = { operation };
    assert.doesNotThrow(() => validateCommand("manage", request));
    assert.equal(commandSemantics("manage", request).effect, "read");
    for (const field of ["configHome", "workspace", "root", "credentials"])
      assert.throws(() => validateCommand("manage", { ...request, [field]: "/untrusted" }));
  }
  assert.throws(() => validateCommand("manage", { operation: "plugins" }));
});
test("Main runs only one-shot CLI with trusted roots before any project start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plugin-reader-"));
  const executable = join(directory, "fixture-cli");
  const receipt = join(directory, "args.json");
  await writeFile(
    executable,
    `#!/usr/bin/python3\nimport json,sys\njson.dump(sys.argv[1:],open(${JSON.stringify(receipt)},'w'))\nprint(${JSON.stringify(JSON.stringify(snapshot))})\n`,
    { mode: 0o755 },
  );
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    binary: executable,
    saved: [{ id: "p", root: directory }],
    projects: new Map(),
    hooks: {
      environment: () => ({
        ...process.env,
        HOME: directory,
        AREAL_HARNESS_HOME: join(directory, "config"),
      }),
    },
    start: () => assert.fail("offline read started project Core"),
  });
  try {
    const user = await backend.executeCommand("manage", { operation: "pluginStoreSnapshot" });
    assert.deepEqual(user, snapshot);
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), [
      "plugin",
      "snapshot",
      "--config-home",
      join(directory, "config"),
      "--json",
    ]);
    await backend.executeCommand("manage", {
      operation: "pluginStoreSnapshot",
      projectId: "p",
      id: "example@local",
    });
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")).slice(-4), [
      "--workspace",
      directory,
      "--id",
      "example@local",
    ]);
    await assert.rejects(
      backend.executeCommand("manage", { operation: "pluginStoreSnapshot", projectId: "missing" }),
      /项目不存在/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
test("read failures and unobserved runtime cannot masquerade as an empty healthy result", () => {
  const request = { operation: "pluginStoreSnapshot" };
  assert.doesNotThrow(() => validateManagementResponse(request, snapshot));
  for (const bad of [
    { ...snapshot, runtimeObserved: true },
    { ...snapshot, list: {} },
    { ...snapshot, revision: -1 },
    { ...snapshot, observedAt: null },
    { ...snapshot, detail: {} },
  ])
    assert.throws(() => validateManagementResponse(request, bad));
});
