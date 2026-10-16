import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { TrajectoryApply } = require("../app/src/core/trajectory-apply.cjs");
const { TrajectoryExport } = require("../app/src/core/trajectory.cjs");
const { validateCommand } = require("@areal/workbench/desktop-contract");
const revision = "a".repeat(64);
const snapshot = (enabled = false, extra = {}) => ({
  revision,
  data: [],
  defaultModel: null,
  effective: { model: { name: "fixture" }, trajectory: { enabled }, ...extra },
});

function fixture(t) {
  const current = snapshot(true),
    calls = [];
  let busy = false,
    safe = true;
  const project = {
    service: {},
    providerRevision: "previous",
    providerSnapshot: snapshot(false),
    client: {
      ready: true,
      request: async (method) => {
        calls.push(method);
        return { restartSafe: safe };
      },
    },
  };
  const backend = {
    starting: new Set(),
    projects: new Map([["p", project]]),
    hasWork: () => busy,
    onChange() {},
    providers: {
      config: { current: async () => current },
      redact: (value) => value,
      command: async (request) => {
        calls.push(request);
        return { pendingApply: false };
      },
    },
  };
  const apply = new TrajectoryApply(backend);
  t.after(() => {
    backend.closing = true;
    clearTimeout(apply.timer);
  });
  return {
    backend,
    apply,
    project,
    current,
    calls,
    busy(value) {
      busy = value;
    },
    safe(value) {
      safe = value;
    },
  };
}

test("toggle IPC permits only a boolean and a configuration revision", () => {
  const valid = { operation: "setEnabled", enabled: true, expectedRevision: revision };
  validateCommand("trajectory", valid, { serviceOnly: true });
  for (const request of [
    { ...valid, enabled: "true" },
    { ...valid, expectedRevision: "missing" },
    { ...valid, expectedRevision: "" },
    { ...valid, endpoint: "https://other.example" },
    { ...valid, config: "/other.toml" },
    { operation: "setEnabled", enabled: false },
  ]) {
    assert.throws(() => validateCommand("trajectory", request), {
      code: "INVALID_DESKTOP_REQUEST",
    });
  }
});

test("capture application waits for task completion and Core restart safety", async (t) => {
  const f = fixture(t);
  f.apply.schedule(revision);
  f.busy(true);
  await f.apply.tryApply();
  assert.deepEqual(f.calls, []);
  assert.equal(f.apply.project({ enabled: true }).capture_apply_pending, true);
  f.busy(false);
  f.safe(false);
  await f.apply.tryApply();
  assert.deepEqual(f.calls, ["areal/server/status"]);
  f.safe(true);
  await f.apply.tryApply();
  assert.deepEqual(f.calls.at(-1), { operation: "apply", expectedRevision: revision });
  f.project.providerSnapshot = f.current;
  assert.deepEqual(f.apply.project({ enabled: true, capture_apply_pending: true }), {
    enabled: true,
  });
});

test("automatic apply refuses unrelated edits and a changed configuration revision", async (t) => {
  for (const change of ["model", "revision"]) {
    const f = fixture(t);
    if (change === "model") f.current.effective.model.name = "different";
    else f.current.revision = "b".repeat(64);
    f.apply.schedule(revision);
    await f.apply.tryApply();
    assert.equal(f.calls.length, 0);
    assert.equal(f.apply.project({}).capture_apply_pending, false);
    assert.ok(f.apply.project({}).capture_apply_error);
  }
});

test("a newer toggle fences an older pending read and shutdown prevents background application", async (t) => {
  const f = fixture(t);
  let release;
  f.backend.providers.config.current = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.apply.schedule(revision);
  const previous = f.apply.tryApply();
  const newer = "b".repeat(64);
  f.apply.schedule(newer);
  release(f.current);
  await previous;
  assert.equal(f.apply.revision, newer);
  assert.equal(f.calls.length, 0);
  f.backend.closing = true;
  await f.apply.tryApply();
  assert.equal(f.calls.length, 0);
});

test("already applied configuration needs no restart and failed apply stays explicit", async (t) => {
  const f = fixture(t);
  f.project.providerRevision = revision;
  f.apply.schedule(revision);
  await f.apply.tryApply();
  assert.equal(f.calls.length, 0);
  f.project.providerRevision = "previous";
  f.backend.providers.command = async () => ({
    pendingApply: true,
    warning: "fixture restart failed",
  });
  f.apply.schedule(revision);
  await f.apply.tryApply();
  assert.equal(f.apply.project({}).capture_apply_error, "fixture restart failed");
  assert.equal(f.apply.project({}).capture_apply_pending, false);
});

test("toggle changes upload control during an active task but defers capture reassembly", async (t) => {
  const f = fixture(t),
    exporter = new TrajectoryExport(f.backend);
  t.after(() => clearTimeout(exporter.apply.timer));
  const requests = [];
  exporter.command = async (request) => {
    requests.push(request);
    return { enabled: true };
  };
  f.busy(true);
  const value = await exporter.setEnabled({
    operation: "setEnabled",
    enabled: true,
    expectedRevision: revision,
  });
  assert.equal(value.capture_apply_pending, true);
  assert.equal(f.backend.providerUpdating, false);
  assert.equal(requests.length, 1);
  assert.equal(f.calls.length, 0);
  f.backend.providerUpdating = true;
  await assert.rejects(exporter.setEnabled(requests[0]), /配置正在应用/);
  assert.equal(requests.length, 1);
});

test("a capture configuration read failure stays visible after successful upload control", async (t) => {
  const f = fixture(t),
    exporter = new TrajectoryExport(f.backend);
  t.after(() => clearTimeout(exporter.apply.timer));
  exporter.command = async () => ({ enabled: true });
  f.backend.providers.config.current = async () => {
    throw new Error("fixture config read failure");
  };
  const value = await exporter.setEnabled({
    operation: "setEnabled",
    enabled: true,
    expectedRevision: revision,
  });
  assert.match(value.capture_apply_error, /fixture config read failure/);
  assert.equal(
    exporter.apply.project({ enabled: true }).capture_apply_error,
    value.capture_apply_error,
  );
  assert.equal(f.calls.length, 0);
});

test("completion of an older safe apply cannot clear a newer scheduled toggle", async (t) => {
  const f = fixture(t);
  let release;
  f.backend.providers.command = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.apply.schedule(revision);
  const applying = f.apply.tryApply();
  await new Promise((resolve) => setImmediate(resolve));
  const newer = "b".repeat(64);
  f.apply.schedule(newer);
  release({ pendingApply: false });
  await applying;
  assert.equal(f.apply.revision, newer);
  assert.equal(f.apply.project({}).capture_apply_pending, true);
});

test("external enablement cannot report ready while an existing Core lacks capture", (t) => {
  const f = fixture(t);
  const value = f.apply.project({ enabled: true, state: "ready" });
  assert.match(value.capture_apply_error, /当前 Core 尚未启用采集/);
  assert.equal(f.calls.length, 0);
  f.project.providerSnapshot = f.current;
  assert.deepEqual(f.apply.project(value), { enabled: true, state: "ready" });
});
