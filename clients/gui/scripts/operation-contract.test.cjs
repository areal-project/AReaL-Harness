"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  commandSemantics,
  validateCommand,
  validateCommandResponse,
} = require("../packages/workbench/client/desktop-contract.cjs");
test("Side model modes reject malformed references and ambiguous default selection", () => {
  const start = {
    projectId: "p",
    operation: "start",
    sourceThreadId: "s",
    requestId: "r",
    text: "question",
    workspaceAccess: "none",
  };
  const reviewComments = [
    {
      id: "comment",
      path: "src/app.ts",
      root: "/workspace",
      scope: "branch",
      ref: "main",
      token: "token",
      head: "head",
      base: "base",
      side: "additions",
      start: 3,
      end: 3,
      snippet: "const value = 1;",
      body: "Please extract this value.",
    },
  ];
  for (const extra of [
    {},
    { resetModel: true },
    { model: { providerId: "p", modelId: "C" } },
    { contextParts: [{ type: "reviewComment", comment: reviewComments[0] }] },
  ])
    assert.doesNotThrow(() => validateCommand("side", { ...start, ...extra }));
  for (const extra of [
    { resetModel: true, model: { providerId: "p", modelId: "C" } },
    { model: {} },
    { workspaceAccess: "write" },
    {
      contextParts: [{ type: "reviewComment", comment: { ...reviewComments[0], side: "invalid" } }],
    },
  ])
    assert.throws(() => validateCommand("side", { ...start, ...extra }));
});
test("critical operation responses fail malformed identity, pages and recovery outcomes", () => {
  for (const [name, params, bad] of [
    ["fork", {}, {}],
    ["configure", {}, {}],
    ["side", { projectId: "p", operation: "recover", requestId: "r" }, { confirmed: true }],
    ["side", { operation: "list" }, { data: null }],
    ["side", { operation: "context" }, { snapshotId: "s", evidence: null }],
  ])
    assert.throws(() => validateCommandResponse(name, params, bad));
  assert.doesNotThrow(() =>
    validateCommandResponse(
      "side",
      { projectId: "p", operation: "recover", requestId: "r" },
      { confirmed: false },
    ),
  );
  assert.doesNotThrow(() =>
    validateCommandResponse(
      "side",
      { projectId: "p", operation: "recover", requestId: "r" },
      { confirmed: true, requestId: "r", threadId: "s" },
    ),
  );
});

test("saved-key reveal accepts only a bounded provider/revision request and key response", () => {
  const request = { operation: "revealKey", id: "provider", expectedRevision: "revision" };
  assert.doesNotThrow(() => validateCommand("providers", request));
  for (const bad of [
    { ...request, id: "" },
    { ...request, expectedRevision: null },
    { ...request, reference: "OTHER_SECRET" },
  ])
    assert.throws(() => validateCommand("providers", bad));
  assert.doesNotThrow(() =>
    validateCommandResponse("providers", request, { apiKey: "synthetic-key" }),
  );
  for (const bad of [{}, { apiKey: "" }, { apiKey: 1 }, { apiKey: "key", snapshot: {} }])
    assert.throws(() => validateCommandResponse("providers", request, bad));
});

test("Cloud reconnect is an explicit identity-bound mutation", () => {
  const request = { operation: "reconnect", projectId: "project", threadId: "thread" };
  assert.doesNotThrow(() => validateCommand("cloudSession", request));
  assert.equal(commandSemantics("cloudSession", request).effect, "mutation");
  for (const invalid of [
    { ...request, threadId: "" },
    { ...request, projectId: "" },
    { ...request, endpoint: "ws://replacement" },
    { ...request, attachments: [] },
  ])
    assert.throws(() => validateCommand("cloudSession", invalid));
});

test("Cloud send requires an authoritative admission receipt", () => {
  const params = { operation: "send", projectId: "project", threadId: "thread", text: "once" };
  assert.throws(() => validateCommandResponse("cloudSession", params, {}));
  assert.throws(() => validateCommandResponse("cloudSession", params, { turn: { id: "turn" } }));
  assert.doesNotThrow(() =>
    validateCommandResponse("cloudSession", params, {
      turn: { id: "turn", status: "inProgress", items: [] },
    }),
  );
});

test("Native directory metadata uses the read command contract without an admission request", () => {
  const request = {
    projectId: "project",
    operation: "localDirectoryReference",
    path: "/external/docs",
  };
  assert.doesNotThrow(() => validateCommand("workspace", request));
  assert.equal(commandSemantics("workspace", request).effect, "read");
  assert.doesNotThrow(() =>
    validateCommandResponse("workspace", request, {
      path: "/external/docs",
      name: "docs",
      type: "directory",
    }),
  );
  for (const result of [
    { path: "/external/docs", name: "docs", type: "file" },
    { path: "/other/docs", name: "docs", type: "directory" },
    { path: "/external/docs", type: "directory" },
  ])
    assert.throws(() => validateCommandResponse("workspace", request, result));
});

test("scheduled scratch keeps its fixed owner without injecting caller submission IDs", () => {
  const request = { operation: "scratch" };
  assert.doesNotThrow(() => validateCommand("projectless", request));
  assert.deepEqual(commandSemantics("projectless", request), { effect: "mutation" });
  for (const extra of [{ requestId: "caller" }, { directory: "/outside" }])
    assert.throws(() => validateCommand("projectless", { ...request, ...extra }));
});
