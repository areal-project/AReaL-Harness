"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { validateCommand } = require("../packages/workbench/client/desktop-contract.cjs");
const reference = {
  pluginId: "example@local",
  componentId: "commands/review.md",
  installedDigest: "fixed",
  arguments: "file with spaces.ts --strict",
};
const requestId = "00000000-0000-4000-a000-000000000111";
function fixture(overrides = {}) {
  const calls = [];
  const thread = { id: "t", turns: [], ...overrides };
  const project = {
    id: "p",
    root: "/workspace",
    pending: [],
    configurations: { t: { revision: 7 } },
    client: {
      ready: true,
      capabilities: {
        methods: ["areal/turn/submit"],
        features: { ordinaryTurnSubmit: true, editLastMessage: true },
      },
    },
    model: { state: { threads: { t: thread } } },
  };
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    binary: "/trusted/areal",
    worktrees: { assertAvailable() {}, records: new Map() },
    worktreeAdmission: { async admit() {} },
    async start() {
      return project;
    },
    requireConnection() {},
    async ensureBrowserTools() {},
    async genUiText(_project, _thread, text) {
      return text;
    },
    textInput(text) {
      return [{ type: "text", text }];
    },
    async submit(_project, method, params, options) {
      calls.push({ method, params, options });
      return {};
    },
  });
  return { backend, calls };
}
test("command references cross the ordinary submission path with arguments and original request identity", async () => {
  const { backend, calls } = fixture();
  await backend.executeCommand("send", {
    projectId: "p",
    threadId: "t",
    text: "",
    command: reference,
    requestId,
  });
  assert.deepEqual(calls, [
    {
      method: "areal/turn/submit",
      params: {
        threadId: "t",
        expectedConfigRevision: 7,
        intent: { type: "message", input: [], command: reference },
      },
      options: { requestId },
    },
  ]);
  await backend.executeCommand("editMessage", {
    projectId: "p",
    threadId: "t",
    text: "",
    expectedTurnId: "turn",
    itemId: "item",
    expectedConfigRevision: 7,
    command: reference,
    requestId,
  });
  assert.equal(calls[1].params.intent.type, "edit");
  assert.deepEqual(calls[1].params.intent.command, reference);
});
test("unsupported task entrypoints reject structured commands rather than silently dropping semantics", async () => {
  for (const thread of [
    { parentThreadId: "parent" },
    { source: "nativeTaskAgent" },
    { goalOwner: "goal" },
  ]) {
    const { backend, calls } = fixture(thread);
    await assert.rejects(
      backend.executeCommand("send", {
        projectId: "p",
        threadId: "t",
        text: "",
        command: reference,
        requestId,
      }),
      /普通任务/,
    );
    assert.equal(calls.length, 0);
  }
  for (const name of ["steer", "queueEdit"])
    assert.throws(() =>
      validateCommand(name, {
        projectId: "p",
        threadId: "t",
        text: "message",
        command: reference,
        requestId,
      }),
    );
});
test("the browser boundary rejects malformed identity, unknown command fields, and oversized raw arguments", () => {
  for (const command of [
    { ...reference, installedDigest: "" },
    { ...reference, arguments: null },
    { ...reference, body: "injected template" },
    { ...reference, arguments: "字".repeat(22000) },
  ])
    assert.throws(() =>
      validateCommand("send", { projectId: "p", threadId: "t", command, requestId }),
    );
  assert.doesNotThrow(() =>
    validateCommand("send", { projectId: "p", threadId: "t", command: reference, requestId }),
  );
});
