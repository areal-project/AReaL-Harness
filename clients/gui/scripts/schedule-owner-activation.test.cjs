"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { HostClient } = require("node:module").createRequire(
  require("node:path").resolve(__dirname, "../app/package.json"),
)("@areal/client/node");

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
