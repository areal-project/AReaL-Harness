import { describe, expect, test } from "vite-plus/test";
import { showTurnStatus, uninspectedToolCalls } from "./toolInspection.js";

describe("UNKNOWN recovery projection", () => {
  test("only pending tool, hook and plugin outcomes block the next send", () => {
    const tool = { type: "dynamicToolCall", id: "tool", execution: { outcome: "unknown" } };
    const hook = {
      type: "dynamicToolCall",
      id: "hook",
      execution: { hooks: [{ outcome: "unknown" }] },
    };
    const plugin = {
      type: "dynamicToolCall",
      id: "plugin",
      execution: { plugin: { operations: [{ outcome: "unknown" }] } },
    };
    const inspected = {
      ...tool,
      id: "inspected",
      execution: { outcome: "unknown", inspection: "Checked current page" },
    };
    const failed = { ...tool, id: "failed", execution: { outcome: "failed" } };
    expect(
      uninspectedToolCalls({
        turns: [
          { items: [tool, hook] },
          { items: [plugin, inspected, failed, { type: "reasoning" }] },
        ],
      }).map((item) => item.id),
    ).toEqual(["tool", "hook", "plugin"]);
    expect(inspected.execution.outcome).toBe("unknown");
    expect(uninspectedToolCalls({})).toEqual([]);
  });
  test("the inspection card replaces only duplicate UNKNOWN failures", () => {
    const turn = {
      status: "failed",
      error: { message: "tool outcome is UNKNOWN" },
      items: [{ type: "dynamicToolCall", execution: { outcome: "unknown" } }],
    };
    expect(showTurnStatus(turn, false, false)).toBe(false);
    expect(showTurnStatus({ ...turn, items: [] }, false, false)).toBe(true);
    expect(
      showTurnStatus({ ...turn, error: { message: "Other execution failure" } }, false, false),
    ).toBe(true);
    expect(showTurnStatus({ status: "completed" }, false, true)).toBe(false);
    expect(showTurnStatus({ status: "inProgress" }, false, false)).toBe(false);
  });
});
