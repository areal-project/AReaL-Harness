"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { GuiHostProjects } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const { HostClient } = require("node:module").createRequire(
  require("node:path").resolve(__dirname, "../app/package.json"),
)("@areal/client/node");
const {
  LifecycleOperations,
} = require("@areal/workbench-service/desktop/core/lifecycle-operations.cjs");

const owner = () => {
  const host = new GuiHostProjects({
    binary: "/unused",
    home: "/fixture/host",
    source: {
      profile: "/fixture/profile",
      coreHome: "/fixture/core",
      legacyServiceHome: "/fixture/legacy",
    },
    singletonHeld: true,
  });
  host.bindings.set("owner", { projectId: "host-owner" });
  return host;
};
const status = (suppressed, error) => ({
  projects: [
    {
      registration: { projectId: "host-owner" },
      scheduleActivationSuppressed: suppressed,
      ...(error ? { scheduleActivationError: error } : {}),
    },
  ],
});

test("Host scheduling errors and suppression refresh without activating an owner", async () => {
  const host = owner();
  let observed = status(true, "catalogRequiresCore");
  host.client.status = async () => observed;
  host.client.ensureProject = () => assert.fail("schedule projection must not activate a Core");
  assert.equal(await host.refreshScheduling(), true);
  assert.deepEqual(host.scheduling("owner"), {
    suppressed: true,
    activationError: "catalogRequiresCore",
  });
  assert.equal(await host.refreshScheduling(), false);
  observed = status(false);
  assert.equal(await host.refreshScheduling(), true);
  assert.deepEqual(host.scheduling("owner"), { suppressed: false, activationError: null });
});

test("historical Desktop receipts do not override the Host scheduling projection", () => {
  const host = owner();
  const lifecycle = new LifecycleOperations({ home: "/fixture/core", host });
  lifecycle.records.set("legacy", {
    targets: [{ projectId: "owner", scheduleActivationSuppressed: true }],
  });
  host.rememberStatus(status(false));
  assert.equal(lifecycle.schedulingSuppressed("owner"), false);
  host.rememberStatus(status(true));
  assert.equal(lifecycle.schedulingSuppressed("owner"), true);
});
test("ordinary ensure omits resume intent and explicit ensure forwards it", async () => {
  const client = new HostClient();
  client.generation = randomUUID();
  client.capabilities = ["scheduledActivation"];
  const requests = [];
  client.request = async (method, params) => requests.push({ method, params });
  await client.ensureProject(randomUUID(), "owner", undefined);
  await client.ensureProject(randomUUID(), "owner", undefined, undefined, true);
  assert.equal(requests[0].method, "project.ensure");
  assert.equal(Object.hasOwn(requests[0].params, "resumeScheduling"), false);
  assert.equal(requests[1].params.resumeScheduling, true);
});
