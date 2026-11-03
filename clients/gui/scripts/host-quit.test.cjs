"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  confirmHostQuit,
  confirmHostStop,
  hostActivityLabel,
} = require("../app/src/core/host-quit.cjs");
const { setNativeLocale } = require("../app/src/core/native-i18n.cjs");
const { validateCommandResponse } = require("../packages/workbench/client/desktop-contract.cjs");

const operation = { requestId: "stop-request", kind: "stopHost", phase: "completed", targets: [] };

function fixture(activity, choices = []) {
  const dialogs = [];
  const stops = [];
  return {
    dialogs,
    stops,
    backend: {
      readHostActivity: async () => {
        if (activity instanceof Error) throw activity;
        return activity;
      },
      requestHostStop: async (request) => {
        stops.push(request);
        return { stopped: true, operation, receipt: { private: true } };
      },
    },
    notify: async (options) => {
      dialogs.push(options);
      assert.ok(choices.length, "no unexpected native confirmation");
      return { response: choices.shift() };
    },
  };
}
const idle = {
  complete: true,
  projects: [{ projectId: "cli-only", state: "observed", activeTurns: 0, idleAllowed: true }],
  totalActiveTasks: 0,
};
const active = {
  complete: true,
  projects: [{ projectId: "cli-only", state: "observed", activeTurns: 1, idleAllowed: false }],
  totalActiveTasks: 0,
};

test("idle quit detaches without a dialog or stop", async () => {
  const f = fixture(idle);
  assert.deepEqual(await confirmHostQuit(f.backend, f.notify), { keepBackground: true });
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(f.stops, []);
});
test("CLI-only active Turn defaults to keeping background and Escape cancels", async () => {
  const keep = fixture(active, [0]);
  assert.deepEqual(await confirmHostQuit(keep.backend, keep.notify), { keepBackground: true });
  assert.equal(keep.dialogs[0].defaultId, 0);
  assert.equal(keep.dialogs[0].cancelId, 2);
  assert.deepEqual(keep.stops, []);
  const cancel = fixture(active, [2]);
  assert.deepEqual(await confirmHostQuit(cancel.backend, cancel.notify), { canceled: true });
  assert.deepEqual(cancel.stops, []);
});
test("unknown activity remains explicit and never implies idle", async () => {
  for (const activity of [
    new Error("Host unavailable"),
    { complete: false, projects: [], totalActiveTasks: 0 },
  ]) {
    const f = fixture(activity, [0]);
    assert.deepEqual(await confirmHostQuit(f.backend, f.notify), { keepBackground: true });
    assert.equal(f.dialogs.length, 1);
    assert.match(f.dialogs[0].detail, /无法核查/);
    assert.deepEqual(f.stops, []);
  }
});
test("stop and quit requires a second confirmation before one durable stop", async () => {
  const decline = fixture(active, [1, 0]);
  assert.deepEqual(await confirmHostQuit(decline.backend, decline.notify), { canceled: true });
  assert.deepEqual(decline.stops, []);
  const accept = fixture(active, [1, 1]);
  let stopping = 0;
  const result = await confirmHostQuit(accept.backend, accept.notify, () => stopping++);
  assert.deepEqual(result, { stopped: true, operation });
  validateCommandResponse("serviceLifecycle", { operation: "stopAndQuit" }, result);
  assert.equal(stopping, 1);
  assert.equal(accept.dialogs[1].defaultId, 0);
  assert.deepEqual(accept.stops, [{ strategy: "cancel" }]);
});
test("confirmed menu stop returns a validated public operation", async () => {
  const f = fixture(active, [1]);
  const result = await confirmHostStop(f.backend, f.notify);
  assert.deepEqual(result, { stopped: true, operation });
  validateCommandResponse("stopService", {}, result);
});
test("menu stop uses the same confirmed operation and incomplete cleanup stays visible", async () => {
  const f = fixture(active, [1]);
  f.backend.requestHostStop = async (request) => {
    f.stops.push(request);
    return { stopped: false, operation: { phase: "settlementIncomplete" } };
  };
  await assert.rejects(confirmHostStop(f.backend, f.notify), { code: "LIFECYCLE_INCOMPLETE" });
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.stops.length, 1);
});
test("menu counts tasks and Turns separately and labels partial observations", () => {
  setNativeLocale("en");
  try {
    assert.equal(hostActivityLabel(active), "Background running, 1 conversation turn");
    assert.equal(
      hostActivityLabel({ ...active, totalActiveTasks: 2 }),
      "Background running, 2 tasks",
    );
    assert.equal(
      hostActivityLabel({ ...active, complete: false, totalActiveTasks: 2 }),
      "At least 2 background tasks, some status unknown",
    );
    assert.equal(hostActivityLabel(idle), "Background idle");
  } finally {
    setNativeLocale("zh-CN");
  }
});
