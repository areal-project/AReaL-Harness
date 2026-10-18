import assert from "node:assert/strict";
import test from "node:test";
import { waitForFaultStatus } from "./local-service-wait.mjs";

const waitForServiceState = (query, state, timeoutMs) =>
  waitForFaultStatus(query, state, { timeoutMs });

const refused = () =>
  Object.assign(new Error("status failed"), {
    code: 1,
    stdout: "",
    signal: null,
    killed: false,
    stderr: JSON.stringify({
      error: {
        code: "localServiceError",
        message:
          "error sending request for url (http://127.0.0.1:1234/areal/service): client error (Connect): tcp connect error: Connection refused (os error 61)",
      },
    }),
  });

test("crash polling tolerates probe refusal but requires the exact terminal state", async () => {
  const states = [refused(), { state: "ready" }, { state: "unavailable" }, { state: "stopped" }];
  const result = await waitForServiceState(
    async () => {
      const state = states.shift();
      if (state instanceof Error) throw state;
      return state;
    },
    "stopped",
    1000,
    0,
  );
  assert.deepEqual(result, { state: "stopped" });
  assert.equal(states.length, 0);
});

test("unexpected CLI diagnostics fail immediately", async () => {
  for (const error of [
    new Error("unexpected failure"),
    Object.assign(new Error("invalid JSON"), { stderr: "not JSON" }),
    Object.assign(new Error("auth failed"), {
      stderr: JSON.stringify({
        error: {
          code: "localServiceError",
          message: "unauthorized",
        },
      }),
    }),
    Object.assign(refused(), {
      stderr: refused().stderr.replace("localServiceError", "protocolError"),
    }),
  ]) {
    await assert.rejects(
      waitForServiceState(async () => {
        throw error;
      }, "stopped"),
      (e) => e === error,
    );
  }
});

test("persistent probe refusal and wrong terminal states retain a deadline", async () => {
  await assert.rejects(
    waitForServiceState(
      async () => {
        throw refused();
      },
      "stopped",
      20,
      5,
    ),
    /within 20 ms/,
  );
  await assert.rejects(
    waitForServiceState(async () => ({ state: "unavailable" }), "stopped", 20, 5),
    /within 20 ms/,
  );
});
