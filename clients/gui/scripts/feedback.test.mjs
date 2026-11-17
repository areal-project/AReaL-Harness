import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { validateCommand } = require("@areal/workbench/desktop-contract");

test("renderer cannot choose endpoint, context, installation or unsupported ratings", () => {
  validateCommand("feedback", {
    operation: "prepare",
    projectId: "p",
    threadId: "t",
    turnId: "turn",
    itemId: "item",
    rating: "up",
  });
  for (const extra of [
    { endpoint: "https://other.test" },
    { context: {} },
    { installation_id: "other" },
    { rating: "maybe" },
  ])
    assert.throws(() =>
      validateCommand("feedback", {
        operation: "prepare",
        projectId: "p",
        threadId: "t",
        turnId: "turn",
        itemId: "item",
        rating: "up",
        ...extra,
      }),
    );
  assert.throws(() =>
    validateCommand("feedback", {
      operation: "submit",
      projectId: "p",
      threadId: "t",
      id: "id",
      reason: "中".repeat(20000),
    }),
  );
});

test("retired Node feedback entry rejects before resolving or starting an execution owner", async () => {
  const backend = new CoreBackend({ binary: "/fixture/areal", home: "/fixture" });
  backend.worktrees.resolveRequest = () => assert.fail("Node must not resolve feedback ownership");
  backend.start = () => assert.fail("Node must not start a feedback Core");
  assert.equal(backend.feedback, undefined);
  await assert.rejects(
    backend.command("feedback", { operation: "status" }),
    /require Host protocol/,
  );
  await assert.rejects(
    backend.command("feedback", {
      operation: "prepare",
      projectId: "project",
      threadId: "thread",
      turnId: "turn",
      itemId: "reply",
      rating: "down",
    }),
    /require Host protocol/,
  );
});
