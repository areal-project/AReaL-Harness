import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const {
  checkHostPrerequisites,
  requestCommandLineToolsInstallation,
} = require("../app/src/core/host-prerequisites.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");

function fixture(overrides = {}) {
  const executions = [];
  return {
    executions,
    options: {
      platform: "darwin",
      app: { isPackaged: false },
      execute: async (path, args) => {
        executions.push({ path, args });
        return {
          stdout:
            path === "/usr/bin/xcode-select" ? "/Library/Developer/CommandLineTools\n" : "1\n",
        };
      },
      accessible: async () => {},
      ...overrides,
    },
  };
}

test("other platforms do not run macOS tools", async () => {
  const f = fixture({ platform: "linux" });
  await checkHostPrerequisites(f.options);
  assert.deepEqual(f.executions, []);
});

test("missing developer tools return guidance without executing the Python installation stub", async () => {
  const f = fixture({
    execute: async (path) => {
      assert.equal(path, "/usr/bin/xcode-select");
      throw new Error("not installed");
    },
  });
  await assert.rejects(checkHostPrerequisites(f.options), (error) => {
    assert.equal(error.code, "HOST_PREREQUISITE_UNAVAILABLE");
    assert.equal(error.prerequisite.kind, "macos-command-line-tools");
    assert.equal(error.prerequisite.reason, "developer-tools-unavailable");
    assert.equal(
      error.message.includes("not installed"),
      false,
      "raw tool errors stay out of the user message",
    );
    return true;
  });
});

test("a stale selected developer directory does not execute Python", async () => {
  const f = fixture({
    accessible: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  await assert.rejects(checkHostPrerequisites(f.options), {
    code: "HOST_PREREQUISITE_UNAVAILABLE",
  });
  assert.deepEqual(
    f.executions.map((item) => item.path),
    ["/usr/bin/xcode-select"],
  );
});

test("the actual interpreter is checked after developer-tools evidence", async () => {
  const f = fixture();
  await checkHostPrerequisites(f.options);
  assert.deepEqual(
    f.executions.map((item) => item.path),
    ["/usr/bin/xcode-select", "/usr/bin/python3"],
  );
  assert.ok(f.executions[1].args.includes("import subprocess,sys; print(1)"));
});

test("a failed interpreter check has its own reason and never claims a bridge root cause", async () => {
  const f = fixture({
    execute: async (path) => {
      if (path === "/usr/bin/xcode-select")
        return { stdout: "/Library/Developer/CommandLineTools\n" };
      throw Object.assign(new Error("private stderr"), { killed: true });
    },
  });
  await assert.rejects(
    checkHostPrerequisites(f.options),
    (error) =>
      error.prerequisite.reason === "python-unavailable" &&
      error.code === "HOST_PREREQUISITE_UNAVAILABLE" &&
      !error.message.includes("private stderr"),
  );
});

test("packaged launch checks the existing bundle prerequisite declaration", async () => {
  const f = fixture({
    app: { isPackaged: true },
    bundle: () => ({ manifest: { prerequisites: [{ path: "/usr/bin/python3" }] } }),
  });
  await checkHostPrerequisites(f.options);
  const undeclared = fixture({
    app: { isPackaged: true },
    bundle: () => ({ manifest: { prerequisites: [] } }),
  });
  await assert.rejects(checkHostPrerequisites(undeclared.options), {
    code: "HOST_PREREQUISITE_UNDECLARED",
  });
  assert.deepEqual(undeclared.executions, []);
});

test("installation is a separate explicit fixed command and never runs during checking", async () => {
  const f = fixture();
  await checkHostPrerequisites(f.options);
  assert.equal(
    f.executions.some((item) => item.args.includes("--install")),
    false,
  );
  assert.deepEqual(await requestCommandLineToolsInstallation(f.options), { started: true });
  assert.deepEqual(f.executions.at(-1), { path: "/usr/bin/xcode-select", args: ["--install"] });
});

test("dependency failure reaches the connection snapshot before any background or Core start", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "areal-prerequisite-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const f = fixture({
    execute: async () => {
      throw new Error("missing tools");
    },
  });
  const backend = new SharedCoreBackend({
    app: { isPackaged: false, getPath: () => home },
    home,
    binary: join(home, "must-not-execute"),
    prerequisiteCheck: () => checkHostPrerequisites(f.options),
  });
  await assert.rejects(backend.init(), { code: "HOST_PREREQUISITE_UNAVAILABLE" });
  assert.equal(backend.snapshot().connection.state, "unavailable");
  assert.equal(backend.snapshot().connection.prerequisite.reason, "developer-tools-unavailable");
  assert.equal(backend.mainDesktop, undefined);
  await assert.rejects(stat(join(home, "service.log")), { code: "ENOENT" });
  assert.equal(backend.reconnectTimer, null, "dependency failures wait for an explicit retry");
});

test("reattaching an existing backend does not require a new interpreter launch", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "areal-prerequisite-attach-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "service.json"), "{}", { mode: 0o600 });
  let probes = 0;
  let attaches = 0;
  const backend = new SharedCoreBackend({
    app: { isPackaged: false, getPath: () => home },
    home,
    binary: join(home, "absent-core"),
    prerequisiteCheck: async () => {
      probes++;
      throw new Error("must not probe");
    },
  });
  backend.attach = async () => {
    attaches++;
    backend.status.connected = true;
    return true;
  };
  await backend.init();
  assert.equal(attaches, 1);
  assert.equal(probes, 0);
  assert.equal(backend.status.connected, true);
});
