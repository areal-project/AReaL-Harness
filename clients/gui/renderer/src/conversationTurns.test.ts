import { describe, expect, it } from "vite-plus/test";
import { precedingTurnIssues, turnContextStamp, withHistoryTopology } from "./conversationTurns.js";

describe("precedingTurnIssues", () => {
  it("keeps the first unresolved owner without blocking that owner's earlier history", () => {
    expect(precedingTurnIssues(["", "first", "", "second", ""])).toEqual([
      "",
      "",
      "first",
      "first",
      "first",
    ]);
    expect(precedingTurnIssues(["", "", ""])).toEqual(["", "", ""]);
    expect(precedingTurnIssues([])).toEqual([]);
  });
});

const page = () => [{ items: [{ turnId: "t1", itemId: "old", type: "agentMessage" }] }];
const thread = (turns: object[], extra = {}) => ({
  id: "main",
  turns,
  displayHistory: { pageTopology: page(), gaps: [] },
  ...extra,
});

describe("withHistoryTopology", () => {
  it("reuses merged turns until the turn or the topology content changes", () => {
    const settled = { id: "t1", items: [{ id: "a", type: "agentMessage" }] };
    const first = withHistoryTopology(thread([settled, { id: "t2", items: [] }]));
    expect(first[0].items.map((item: { id: string }) => item.id)).toEqual(["a", "old"]);
    // 增量会重建线程头：拓扑数组换了引用但内容相同。
    const next = withHistoryTopology(thread([settled, { id: "t2", items: [{ id: "b" }] }]));
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    const reloaded = withHistoryTopology({
      ...thread([settled]),
      displayHistory: { pageTopology: [], gaps: [] },
    });
    expect(reloaded[0]).not.toBe(first[0]);
  });
});

describe("turnContextStamp", () => {
  it("ignores the streaming thread but follows other threads and heads", () => {
    const other = { id: "agent" };
    const project = (main: object, agent = other, connected = true) => ({
      id: "p",
      state: { connected, threads: { main, agent } },
    });
    const live = { onFile: () => {} };
    const stamp = (p: object, t = thread([])) => turnContextStamp(p, t, [], live);
    const base = stamp(project({ id: "main", turns: [1] }));
    expect(stamp(project({ id: "main", turns: [1, 2] }))).toBe(base);
    expect(stamp(project({ id: "main" }, { id: "agent" }))).not.toBe(base);
    expect(stamp(project({ id: "main" }, other, false))).not.toBe(base);
    expect(stamp(project({ id: "main" }), thread([], { title: "renamed" }))).not.toBe(base);
  });
});
