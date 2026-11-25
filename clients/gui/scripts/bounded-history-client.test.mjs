import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  validateCommand,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
const {
  readObservationResult,
  readThreadMetadata,
} = require("../packages/workbench/client/desktop-contract/conversation-history.cjs");

test("CLI naming configuration does not widen desktop create input", () => {
  assert.throws(
    () =>
      validateCommand("create", {
        projectId: "project",
        text: "hello",
        options: { automaticSessionName: false },
      }),
    { code: "INVALID_DESKTOP_REQUEST" },
  );
});

const baseline = (archived = false) => ({
  thread: {
    id: "thread",
    status: { type: "idle" },
    turns: [],
    desktop: {
      archived,
      configuration: { revision: 1 },
      queue: { revision: 1, items: [] },
      interactions: [],
      interactionRevision: 1,
    },
  },
  history: { snapshotId: "snapshot", nextCursor: "older", complete: false },
});

test("history reads accept the Core automatic session name option without accepting malformed options", () => {
  for (const automaticSessionName of [true, false, null]) {
    const response = baseline();
    response.thread.desktop.configuration.options = { automaticSessionName };
    assert.equal(readObservationResult(response), response);
    assert.equal(readThreadMetadata(response).thread, response.thread);
  }
  for (const options of [
    { automaticSessionName: "false" },
    { automaticSessionName: false, unsupported: true },
  ]) {
    const response = baseline();
    response.thread.desktop.configuration.options = options;
    assert.throws(() => readObservationResult(response), { code: "HISTORY_VIEW_UNAVAILABLE" });
    assert.throws(() => readThreadMetadata(response), { code: "HISTORY_VIEW_UNAVAILABLE" });
  }
});

test("history capability is a validated read with an explicit view owner", () => {
  assert.equal(commandSemantics("history", { operation: "loadOlder" }).effect, "read");
  validateCommand("history", { projectId: "p", threadId: "t", viewId: "v", operation: "acquire" });
  for (const extra of [
    { viewId: "" },
    { operation: "execute" },
    { maxBytes: 2 ** 21 },
    { cursor: "unowned-cursor" },
  ])
    assert.throws(() =>
      validateCommand("history", {
        projectId: "p",
        threadId: "t",
        viewId: "v",
        operation: "loadOlder",
        ...extra,
      }),
    );
});
