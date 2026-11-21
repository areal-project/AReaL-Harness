import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/package.json", import.meta.url));
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
