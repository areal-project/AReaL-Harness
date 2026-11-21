import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { validateCommand } = require("@areal/workbench/desktop-contract");
const revision = "a".repeat(64);

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
