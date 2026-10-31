import { expect, test } from "vite-plus/test";
import {
  isTechnicalErrorMessage,
  recoveredOutcome,
  recoveryMessage,
  sameRecoveryOwner,
  type RecoveryOperation,
} from "../recoveryPresentation.js";

const operation: RecoveryOperation = {
  requestId: "request-1",
  method: "areal/turn/start",
  target: { kind: "thread", threadId: "thread-1" },
};

test("recovery keeps unknown submissions pending until the same operation settles", () => {
  const project = { outcomes: { "request-1": { status: "running", operation } } };
  expect(recoveredOutcome(project, "request-1", "thread-1", operation)).toBeUndefined();
  const completed = { status: "completed", operation };
  expect(
    recoveredOutcome({ outcomes: { "request-1": completed } }, "request-1", "thread-1", operation),
  ).toBe(completed);
  expect(
    recoveredOutcome({ outcomes: { "request-1": completed } }, "request-1", "thread-2", operation),
  ).toBeUndefined();
  expect(
    recoveredOutcome(
      {
        outcomes: {
          "request-1": { ...completed, operation: { ...operation, requestId: "different" } },
        },
      },
      "request-1",
      "thread-1",
      operation,
    ),
  ).toBeUndefined();
});

test("creation receipts may bind the resulting thread while preserving the original request", () => {
  const create: RecoveryOperation = {
    requestId: "create-1",
    method: "areal/thread/start",
    target: { kind: "project" },
  };
  const receipt = {
    status: "completed",
    operation: { ...create, target: { kind: "thread", threadId: "created" } },
  };
  expect(recoveredOutcome({ outcomes: { "create-1": receipt } }, "create-1", "", create)).toBe(
    receipt,
  );
});

test("connection generations belong to recovery identity and unknown results never imply retry", () => {
  const owner = { projectId: "project-1", threadId: "thread-1", connectionGeneration: 2 };
  expect(sameRecoveryOwner({ ...owner }, owner)).toBe(true);
  expect(sameRecoveryOwner({ ...owner, connectionGeneration: 1 }, owner)).toBe(false);
  expect(recoveryMessage({ message: "transport timeout", submissionUnknown: true })).toBe(
    "操作结果待确认。",
  );
  expect(isTechnicalErrorMessage("Error invoking remote method: IPC failed")).toBe(true);
  expect(isTechnicalErrorMessage("请先保存当前文件")).toBe(false);
});

test("an outcome without the original operation cannot release an unknown submission", () => {
  expect(
    recoveredOutcome(
      { outcomes: { "request-1": { status: "completed", operation } } },
      "request-1",
      "thread-1",
    ),
  ).toBeUndefined();
  expect(
    recoveredOutcome(
      {
        outcomes: {
          "request-1": {
            status: "completed",
            operation: { ...operation, method: "areal/thread/configure" },
          },
        },
      },
      "request-1",
      "thread-1",
      operation,
    ),
  ).toBeUndefined();
});
