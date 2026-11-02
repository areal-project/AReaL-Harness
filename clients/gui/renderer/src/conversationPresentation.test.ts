import { createIntl } from "react-intl";
import { catalogs } from "./i18n/messages.js";
import type { Translate } from "./i18n/IntlProvider.js";
import { describe, expect, it } from "vite-plus/test";
import type { Data } from "./services.js";
import {
  activityRunLabel,
  executionSegments,
  progressGroups,
  activityRuns,
  timelineItems,
  statusTarget,
  toolPresentation,
} from "./conversationPresentation.js";

const intl = createIntl({ locale: "zh-CN", messages: catalogs["zh-CN"] });
const t: Translate = (id, values) => intl.formatMessage({ id }, values);

describe("history group identity", () => {
  it("keeps process settlement and all detail handles when command output is deferred", () => {
    const command = (id: string, tool: string, state: string, commandStatus: string) => ({
      id,
      type: "dynamicToolCall",
      tool,
      arguments: { processId: "p" },
      status: "completed",
      success: true,
      contentItems: [
        {
          type: "text",
          text: JSON.stringify({ processId: "p", state, commandStatus, outputReadComplete: true }),
        },
      ],
    });
    const source = [
      command("start", "run_command", "running", "running"),
      command("end", "read_process", "exited", "succeeded"),
    ];
    const deferred = source.map((preview) => ({
      id: preview.id,
      type: "historyDeferred",
      originalType: "dynamicToolCall",
      preview,
    }));
    const grouped = executionSegments(deferred, "completed")[0].items[0];
    expect(grouped.processResult.commandStatus).toBe("succeeded");
    expect(grouped.processRecords.map((item: Data) => item.deferredHistory.id)).toEqual([
      "start",
      "end",
    ]);
    expect(toolPresentation(grouped).running).toBe(false);
  });
  it("keeps deferred tool details inside the same process group after loading", () => {
    const before = [read("a"), read("b")];
    const deferred = before.map((item) => ({
      id: item.id,
      type: "historyDeferred",
      originalType: "dynamicToolCall",
    }));
    const groups = (items: Data[]) => progressGroups(executionSegments(items, "completed"), "t");
    expect(groups(deferred).map((group) => group.id)).toEqual(
      groups(before).map((group) => group.id),
    );
    expect(groups(deferred)[0].progress).toBe(true);
    expect(executionSegments(deferred, "completed")[0].items.map((item: Data) => item.id)).toEqual([
      "a",
      "b",
    ]);
  });
  it("keeps a reasoning disclosure and ordered reload slot across a known page gap", () => {
    const first = { id: "r1", type: "reasoning", summary: ["first"] };
    const last = { id: "r2", type: "reasoning", summary: ["last"] };
    const before = timelineItems([first, last]);
    const gap = { id: "gap", type: "historyPageGap", topologyKnown: true };
    const missing = timelineItems([first, gap, last]);
    expect(missing).toHaveLength(1);
    expect(missing[0].id).toBe(before[0].id);
    expect(missing[0].items.map((item: Data) => item.id)).toEqual(["r1", "gap", "r2"]);
    expect(timelineItems([first, { ...gap, topologyKnown: false }, last])).toHaveLength(3);
  });
  const commentary = (id: string) => ({ id, type: "agentMessage", phase: "commentary", text: id });
  it("missing page slots do not split an established progress group", () => {
    const full = [commentary("a"), commentary("b"), commentary("c")];
    const omitted = [
      full[0],
      { id: "gap", type: "historyPageGap", topologyKnown: true },
      { ...full[1], text: undefined, historyOmitted: true },
      full[2],
    ];
    const groups = (items: Data[]) => progressGroups(executionSegments(items, "completed"), "t");
    expect(groups(omitted).map((group) => group.id)).toEqual(groups(full).map((group) => group.id));
    expect(groups(omitted).filter((group) => group.progress)).toHaveLength(1);
  });
  it.each(["userMessage", "agentMedia", "questionAnswer", "agentMessage"])(
    "omitted %s remains a real semantic boundary",
    (type) => {
      const boundary = {
        id: "boundary",
        type,
        phase: "final_answer",
        text: "answer",
        historyOmitted: true,
      };
      const groups = progressGroups(
        executionSegments([commentary("a"), boundary, commentary("c")], "completed"),
        "t",
      );
      expect(groups.filter((group) => group.progress).map((group) => group.id)).toEqual([
        "progress:t",
        "progress:boundary",
      ]);
    },
  );
  it("omitted first tool keeps execution identity while its body is evicted", () => {
    const full = [read("a"), read("b")];
    const missing = [{ ...full[0], historyOmitted: true }, full[1]];
    expect(executionSegments(missing, "completed")[0].id).toBe(
      executionSegments(full, "completed")[0].id,
    );
  });
});

describe("statusTarget", () => {
  it("keeps a one-line command as is, with collapsed whitespace", () => {
    expect(statusTarget("pnpm   --dir clients/gui\ttypecheck")).toBe(
      "pnpm --dir clients/gui typecheck",
    );
  });

  it("stops a heredoc at its opening marker", () => {
    const command = "python3 - <<'PY'\nimport pathlib,json\nprint('INDEX')\nPY";
    expect(statusTarget(command)).toBe("python3 - <<'PY'");
    expect(statusTarget('cat <<-"EOF" > out.txt\nbody\nEOF')).toBe('cat <<-"EOF"');
    expect(statusTarget("bash <<EOS\necho hi\nEOS")).toBe("bash <<EOS");
  });

  it("marks a multi-line command that is not a heredoc as truncated", () => {
    expect(statusTarget("\n\ncd app &&\n  pnpm test\n")).toBe("cd app && …");
  });

  it("returns undefined for empty targets", () => {
    expect(statusTarget(undefined)).toBeUndefined();
    expect(statusTarget("  \n ")).toBeUndefined();
  });
});

const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "dynamicToolCall",
  tool: name,
  status: "completed",
  success: true,
  arguments: {},
  contentItems: [],
  ...extra,
});
const read = (id: string, status = "completed") =>
  tool(id, "fs_read", {
    status,
    success: status === "completed" ? true : undefined,
    arguments: { path: `${id}.ts` },
  });

describe("activityRuns groups", () => {
  const shape = (runs: { key: string | null; items: Data[] }[]) =>
    runs.map((run) => [run.key, run.items.map((item) => item.id)]);
  it("merges every tool between two messages into one group", () => {
    const rows = [
      read("r1"),
      tool("s1", "search_files", { arguments: { pattern: "login" } }),
      tool("c1", "run_command", { arguments: { command: "ls" } }),
      tool("e1", "fs_write", { arguments: { path: "a.ts" } }),
      tool("x1", "lookup_ticket"),
    ];
    expect(shape(activityRuns(rows))).toEqual([["工具", ["r1", "s1", "c1", "e1", "x1"]]]);
  });
  it("splits at reasoning groups and breaker rows", () => {
    const spawn = tool("a1", "agent_spawn");
    const rows = [read("r1"), { id: "g1", type: "reasoningGroup", items: [] }, read("r2"), spawn];
    expect(shape(activityRuns(rows, (item) => item === spawn))).toEqual([
      ["工具", ["r1"]],
      [null, ["g1"]],
      ["工具", ["r2"]],
      [null, ["a1"]],
    ]);
  });
});

describe("activityRunLabel phrases", () => {
  const run = (...items: Data[]) => ({ key: "工具", items });
  it("orders phrases edit, other tools, explore, command", () => {
    expect(
      activityRunLabel(
        run(
          tool("c1", "run_command"),
          read("r1"),
          tool("w1", "browser_v1"),
          tool("e1", "fs_write", { arguments: { path: "a.ts" } }),
        ),
        t,
      ),
    ).toBe("已修改 1 个文件，已使用浏览器，已探索，已运行命令");
  });
  it("counts only distinct completed edited files", () => {
    const edit = (id: string, path: string, extra = {}) =>
      tool(id, "fs_write", { arguments: { path }, ...extra });
    expect(
      activityRunLabel(
        run(
          edit("e1", "a.ts"),
          edit("e2", "a.ts"),
          edit("e3", "b.ts"),
          edit("e4", "c.ts", { status: "inProgress", success: undefined }),
        ),
        t,
      ),
    ).toBe("已修改 2 个文件");
  });
  it("stays past tense while a child is still running", () => {
    expect(activityRunLabel(run(read("a"), read("b", "inProgress")), t)).toBe("已探索");
  });
  it("states failures after the phrases", () => {
    const failed = tool("c2", "run_command", { success: false, execution: { exitCode: 1 } });
    expect(activityRunLabel(run(read("a"), tool("c1", "run_command"), failed), t)).toBe(
      "已探索，已运行命令 · 1 个失败",
    );
  });
});

describe("toolPresentation targets", () => {
  it("never falls back to the internal tool name", () => {
    expect(toolPresentation(tool("l", "fs_list")).detail).toBe("");
    expect(toolPresentation(tool("l", "fs_list")).label).toBe("列出目录");
    expect(toolPresentation(tool("p", "plan_read")).detail).toBe("");
    expect(toolPresentation(tool("x", "lookup_ticket")).detail).toBe("");
  });
  it("names the skill a skill read opened", () => {
    const skill = tool("k", "skill_read", {
      arguments: { skill: { id: "review", revision: "3" }, resource: "SKILL.md" },
    });
    expect(toolPresentation(skill).detail).toBe("review · SKILL.md");
  });
  it("exposes the exit code of a failed command", () => {
    const failed = tool("c", "run_command", { success: false, execution: { exitCode: 2 } });
    expect(toolPresentation(failed)).toMatchObject({ failed: true, exitCode: 2 });
  });
});
