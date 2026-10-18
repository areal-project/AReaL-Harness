import assert from "node:assert/strict";
import test from "node:test";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

test("smoke diagnostics preserve successful results and original failures", async () => {
  assert.equal(await withSmokeDeadline("capture", async () => 42), 42);
  const original = Error("original diagnostic failure");
  await assert.rejects(withSmokeDeadline("capture", async () => { throw original; }), error => error === original);
});

test("an unresponsive diagnostic operation cannot hold failure reporting forever", async () => {
  await assert.rejects(withSmokeDeadline("capture", () => new Promise(() => {}), 20), /capture timed out after 20ms/);
});
