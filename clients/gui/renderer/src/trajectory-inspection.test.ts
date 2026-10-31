import { expect, test, vi } from "vite-plus/test";
import {
  activityDuration,
  copyTrace,
  type TraceNode,
  loadTraceTree,
  traceCoverage,
  traceDuration,
} from "./trajectory-inspection.js";
import type { Action, Data } from "./services.js";

const response = (turns: Data[], extra: Data = {}) => ({
  threadId: "root",
  title: "task",
  sources: [],
  legacySources: [],
  executions: { data: [], nextOffset: null },
  activeTurn: null,
  readAtMs: 1000,
  page: {
    data: turns.flatMap((turn) =>
      turn.items.map((item: Data) => ({
        turn: { ...turn, items: [] },
        item,
        sourceTurnId: turn.id,
        sourceItemId: item.id,
      })),
    ),
    complete: true,
    nextCursor: null,
  },
  ...extra,
});
const saved = {
  id: "old",
  status: "completed",
  items: [{ id: "old-item", type: "agentMessage", text: "archived evidence" }],
};

test("pagination reaches older evidence and a terminal refresh replaces active items", async () => {
  let settled = false;
  const action = vi.fn(async (_: string, request: Data) =>
    request.cursor === "older"
      ? response([saved])
      : response(
          [
            {
              id: "latest",
              status: settled ? "completed" : "inProgress",
              items: [{ id: "answer", type: "agentMessage", text: settled ? "final" : "partial" }],
            },
          ],
          {
            page: {
              ...response([
                {
                  id: "latest",
                  status: settled ? "completed" : "inProgress",
                  items: [
                    { id: "answer", type: "agentMessage", text: settled ? "final" : "partial" },
                  ],
                },
              ]).page,
              complete: false,
              nextCursor: "older",
            },
          },
        ),
  );
  const tree = await loadTraceTree(
    action as Action,
    "project",
    "root",
    new AbortController().signal,
  );
  expect(tree.turns.flatMap((t) => t.items).some((i) => i.text === "archived evidence")).toBe(true);
  settled = true;
  const final = await loadTraceTree(
    action as Action,
    "project",
    "root",
    new AbortController().signal,
    tree,
  );
  expect(final.turns.find((t) => t.id === "latest")?.items.map((i: Data) => i.text)).toEqual([
    "final",
  ]);
});

test("missing child coverage is retained instead of reporting a complete search", async () => {
  const action = vi.fn(async (_: string, request: Data) => {
    if (request.executionId) throw new Error("worker unavailable");
    return response([saved], {
      executions: { data: [{ executionId: "worker", title: "isolated task" }], nextOffset: null },
    });
  });
  const tree = await loadTraceTree(
    action as Action,
    "project",
    "root",
    new AbortController().signal,
  );
  expect(traceCoverage(tree)).toEqual(["isolated task: worker unavailable"]);
  const incomplete = vi.fn(async () =>
    response([saved], { page: { data: [], complete: false, nextCursor: null } }),
  );
  await expect(
    loadTraceTree(incomplete as Action, "project", "root", new AbortController().signal),
  ).rejects.toThrow("Incomplete history coverage");
});

test("interruption does not keep counting, and overlapping child work is never summed", () => {
  expect(
    traceDuration({ status: "interrupted", trace: { startedAtMs: 1 } }, 1_000_000),
  ).toBeUndefined();
  expect(
    activityDuration({ status: "running", startedAtMs: 1 }, { status: "interrupted" }, 1_000_000),
  ).toBeUndefined();
  expect(
    traceDuration(
      {
        status: "completed",
        durationMs: 40_000,
        trace: { activities: [{ durationMs: 30_000 }, { durationMs: 30_000 }] },
      },
      1_000_000,
    ),
  ).toBe(40_000);
  expect(
    activityDuration({ status: "running", startedAtMs: 1000 }, { status: "inProgress" }, 3000),
  ).toBe(2000);
});

test("trace export retains selected-turn child scope, observation facts and read errors", () => {
  const child = (id: string): TraceNode => ({
    threadId: id,
    title: id,
    turns: [],
    children: [],
    readAtMs: 500,
    stateConfirmed: false,
    errors: ["child read incomplete"],
  });
  const root: TraceNode = {
    threadId: "root",
    title: "task",
    readAtMs: 1000,
    stateConfirmed: true,
    errors: ["root read incomplete"],
    turns: [
      { id: "first", items: [] },
      { id: "second", items: [] },
    ],
    children: [
      { execution: { executionId: "owned", owner: { turnId: "first" } }, nodes: [child("owned")] },
      { execution: { executionId: "other", owner: { turnId: "second" } }, nodes: [child("other")] },
      { execution: { executionId: "unassigned" }, nodes: [child("unassigned")] },
    ],
  };
  const before = structuredClone(root);
  const selected = JSON.parse(
    copyTrace(root, "Title", "first", ["refresh failed", "refresh failed"]),
  );
  expect(selected.scope).toBe("turnIncludingSubagents");
  expect(selected.turns.map((turn: Data) => turn.id)).toEqual(["first"]);
  expect(selected.children.map((entry: Data) => entry.execution.executionId)).toEqual(["owned"]);
  expect(selected.readAtMs).toBe(1000);
  expect(selected.stateConfirmed).toBe(true);
  expect(selected.children[0].sources[0].stateConfirmed).toBe(false);
  expect(selected.coverage).toContain("root read incomplete");
  expect(selected.coverage).toContain("child read incomplete");
  expect(selected.coverage.filter((value: string) => value === "refresh failed")).toHaveLength(1);
  expect(
    selected.coverage.some((value: string) => value.includes("lack a recorded creation turn")),
  ).toBe(true);
  const all = JSON.parse(copyTrace(root, "Title"));
  expect(all.scope).toBe("conversationIncludingSubagents");
  expect(all.children).toHaveLength(3);
  expect(root).toEqual(before);
});
