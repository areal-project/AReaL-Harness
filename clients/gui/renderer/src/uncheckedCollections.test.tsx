import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRequire } from "node:module";
import {
  commandResult,
  executionSegments,
  timelineItems,
  toolActionText,
  agentSettlements,
} from "./conversationPresentation.js";
import { hasUnknownToolOutcome } from "./toolInspection.js";
import { CommandDetails } from "./CommandDetails.js";
import { TurnHookStats } from "./TurnHookStats.js";
import { ToolEvent } from "./ToolEvent.js";
import { verifiedFileReceipts } from "./TurnFileSummary.js";
import { settledRun } from "./ScheduledTasks.js";
import { describeSchedule } from "./scheduleText.js";
import type { Data } from "./services.js";

vi.mock("./components/ui/diff-viewer.js", () => ({ DiffViewer: () => null }));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
const { readObservationResult } = createRequire(import.meta.url)(
  "@areal/workbench/desktop-contract/conversation-history",
);
const tool = (extension: Data) => ({
  id: "tool",
  type: "dynamicToolCall",
  tool: "run_command",
  status: "completed",
  success: true,
  arguments: { command: "echo ok" },
  ...extension,
});
const render = (component: typeof CommandDetails, item: Data) =>
  renderToStaticMarkup(createElement(component, { item }));

describe("opaque tool extensions accepted by the history boundary", () => {
  it.each([{ text: "object" }, "text", [null, 42]])(
    "does not crash command derivation or details for %j",
    (contentItems) => {
      const item = tool({ contentItems });
      expect(
        readObservationResult({ thread: { id: "thread", turns: [{ id: "turn", items: [item] }] } })
          .thread.turns[0].items[0],
      ).toEqual(item);
      expect(commandResult(item)).toEqual({});
      expect(render(CommandDetails, item)).toContain("echo ok");
    },
  );
  it("keeps valid output when malformed parts are mixed in", () => {
    const item = tool({
      contentItems: [
        null,
        { type: "text", text: JSON.stringify({ stdout: "actual-output", exitCode: 0 }) },
      ],
    });
    expect(commandResult(item).stdout).toBe("actual-output");
    expect(render(CommandDetails, item)).toContain("actual-output");
  });
  it("does not crash tool summaries, file receipts or agent settlements", () => {
    const item = tool({ tool: "fs_read", contentItems: { text: "object" } });
    expect(toolActionText(item, "done", (id) => id)).toBeTruthy();
    expect(renderToStaticMarkup(createElement(ToolEvent, { item }))).toContain("tool");
    expect(verifiedFileReceipts([item]).size).toBe(0);
    expect(agentSettlements({ ...item, tool: "agent_wait" })).toEqual([]);
  });
  it("does not crash command details for malformed process collections", () => {
    expect(render(CommandDetails, tool({ processRecords: {}, processObservations: {} }))).toContain(
      "echo ok",
    );
  });
  it("does not crash journal inspection or hook statistics", () => {
    const item = tool({ execution: { hooks: {}, plugin: { operations: {} } } });
    expect(() => hasUnknownToolOutcome(item)).not.toThrow();
    expect(
      renderToStaticMarkup(createElement(TurnHookStats, { turn: { id: "turn", items: [item] } })),
    ).toBe("");
    expect(
      hasUnknownToolOutcome(tool({ execution: { hooks: [null, { outcome: "unknown" }] } })),
    ).toBe(true);
  });
  it("filters non-text reasoning entries before building the timeline", () => {
    expect(
      timelineItems([{ id: "r", type: "reasoning", summary: [null, 42, "valid reasoning"] }]),
    ).toHaveLength(1);
  });
  it("does not synthesize question answers from malformed questions", () => {
    expect(
      executionSegments(
        [
          tool({
            tool: "ask_user_question",
            arguments: { questions: { length: 1 } },
            contentItems: [{ text: '{"answers":{}}' }],
          }),
        ],
        "completed",
      ).some((item) => item.type === "questionAnswer"),
    ).toBe(false);
  });
});

describe("task directory extensions", () => {
  it("keeps malformed workers unsettled rather than claiming completion", () => {
    expect(settledRun({ status: "completed", workers: {} })).toBe(false);
    expect(settledRun({ status: "completed", workers: [null] })).toBe(false);
    expect(settledRun({ status: "completed", workers: [{ settled: true }] })).toBe(true);
  });
  it.each(["weekly", "monthly"])(
    "does not crash a %s schedule label on object-shaped dates",
    (frequency) => {
      expect(() =>
        describeSchedule(
          {
            scheduleV2: {
              rule: {
                kind: "calendar",
                frequency,
                localTime: "09:00",
                weekdays: {},
                monthDays: {},
              },
            },
          },
          (id) => id,
        ),
      ).not.toThrow();
    },
  );
});
