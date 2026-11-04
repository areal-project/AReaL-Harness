"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { GuiHostProjects } = require("../app/src/core/gui-host-projects.cjs");
const { GuiSourceAdapter } = require("../app/src/core/gui-source.cjs");

test("source migration reports safe actionable blockers without exposing source data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-source-blockers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new GuiHostProjects({
    binary: "/unused",
    home: join(root, "host"),
    singletonHeld: true,
    source: {
      profile: join(root, "profile"),
      coreHome: join(root, "core"),
      legacyServiceHome: join(root, "legacy"),
    },
  });
  owner.client.connectOrStart = async () => {};
  owner.client.requireCapability = () => {};
  owner.client.sourceState = async () => null;
  const original = GuiSourceAdapter.prototype.import;
  t.after(() => {
    GuiSourceAdapter.prototype.import = original;
  });
  for (const [code, expected] of [
    ["sourceGuardRequired", /原.*单实例/],
    ["credentialsRequired", /凭据/],
    ["legacyPending", /旧后台/],
    ["unrecognized", /无法确认/],
  ]) {
    GuiSourceAdapter.prototype.import = async () => ({
      kind: "blocked",
      blockers: [{ code, message: "SECRET_FIXTURE" }],
    });
    await assert.rejects(owner.init(), (error) => {
      assert.equal(error.code, "GUI_SOURCE_PENDING");
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /SECRET_FIXTURE|unrecognized/);
      return true;
    });
  }
});
