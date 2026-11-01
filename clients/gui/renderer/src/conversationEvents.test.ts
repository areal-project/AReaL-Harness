import { expect, test } from "vite-plus/test";
import { retryProgress } from "./conversationEvents.js";
import { CoreTaskModel } from "../../packages/workbench/client/core-model.js";

const activity = (id: string, kind: string, status: string, more = {}) => ({
  id,
  logicalId: "request",
  kind,
  status,
  ...more,
});
test("retry states retain the logical request outcome across unrelated failures", () => {
  const failed = activity("first", "model", "failed");
  const waiting = activity("wait", "retryWait", "running", { retryDelayMs: 250 });
  expect(retryProgress({ status: "inProgress", trace: { activities: [failed, waiting] } })).toEqual(
    [{ id: "request", attempts: 1, state: "waiting", delayMs: 250 }],
  );
  const recovered = [
    failed,
    { ...waiting, status: "completed" },
    activity("next", "model", "completed"),
  ];
  expect(
    retryProgress({
      status: "failed",
      trace: {
        activities: [...recovered, activity("other", "model", "failed", { logicalId: "other" })],
      },
    })[0].state,
  ).toBe("recovered");
  const stopped = [
    failed,
    { ...waiting, status: "completed" },
    activity("next", "model", "failed"),
  ];
  expect(retryProgress({ status: "failed", trace: { activities: stopped } })[0].state).toBe(
    "stopped",
  );
  expect(
    retryProgress({
      status: "failed",
      trace: {
        activities: [...stopped.slice(0, -1), { ...stopped.at(-1), retryDisposition: "exhausted" }],
      },
    })[0].state,
  ).toBe("exhausted");
});
test("Core events preserve retry facts, message creation time and consecutive model changes", () => {
  const model = new CoreTaskModel();
  model.replace({
    id: "thread",
    desktop: { configuration: { revision: 1 } },
    turns: [
      {
        id: "turn",
        status: "inProgress",
        items: [{ id: "message", type: "agentMessage", text: "", createdAt: 123 }],
      },
    ],
  });
  const changes = [
    {
      revision: 2,
      occurredAt: 123,
      from: { providerId: null, modelId: "a" },
      to: { providerId: "p", modelId: "b" },
    },
    {
      revision: 3,
      occurredAt: 124,
      from: { providerId: "p", modelId: "b" },
      to: { providerId: "p", modelId: "c" },
    },
  ];
  model.event("areal/thread/configured", {
    threadId: "thread",
    configuration: { revision: 3 },
    modelChanges: changes,
  });
  model.event("areal/thread/configured", {
    threadId: "thread",
    configuration: { revision: 2 },
    modelChanges: changes.slice(0, 1),
  });
  model.event("areal/turn/traceActivity", {
    threadId: "thread",
    turnId: "turn",
    activity: activity("first", "model", "running"),
  });
  model.event("areal/turn/traceActivity", {
    threadId: "thread",
    turnId: "turn",
    activity: activity("first", "model", "failed"),
  });
  model.event("item/agentMessage/delta", {
    threadId: "thread",
    turnId: "turn",
    itemId: "message",
    delta: "answer",
  });
  const thread = model.state.threads.thread;
  expect(thread.desktop?.modelChanges).toEqual(changes);
  expect(thread.turns?.[0].items?.[0].createdAt).toBe(123);
  expect(thread.turns?.[0].trace).toEqual({ activities: [activity("first", "model", "failed")] });
});

test("an inner HTTP retry budget does not announce terminal exhaustion while Core continues", () => {
  expect(
    retryProgress({
      status: "inProgress",
      trace: {
        activities: [activity("last-http", "model", "failed", { retryDisposition: "exhausted" })],
      },
    })[0].state,
  ).toBe("retrying");
});
