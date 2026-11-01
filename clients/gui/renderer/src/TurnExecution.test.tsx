import type { Translate } from "./i18n/IntlProvider.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TurnExecution } from "./TurnExecution.js";
import { createRequire } from "node:module";
const { pageTopology } = createRequire(import.meta.url)(
  "../../app/src/core/history-projection.cjs",
);
import type { Data } from "./services.js";
import { rememberDisclosure } from "./conversationReading.js";

vi.mock("./i18n/IntlProvider.js", async () => {
  const { createIntl } = await import("react-intl");
  const { catalogs } = await import("./i18n/messages.js");
  const intl = createIntl({ locale: "zh-CN", messages: catalogs["zh-CN"] });
  const t: Translate = (id, values) => intl.formatMessage({ id }, values);
  return { useI18n: () => ({ t }) };
});

const project = { state: { connected: true, threads: { thread: { executionConnected: true } } } };
const read = (id: string) => ({
  id,
  type: "dynamicToolCall",
  tool: "fs_read",
  status: "completed",
  success: true,
  arguments: { path: `${id}.ts` },
  contentItems: [],
});
const command = (id: string) => ({
  ...read(id),
  tool: "run_command",
  arguments: { command: "pnpm test" },
});
const render = (items: Data[]) =>
  renderToStaticMarkup(
    createElement(TurnExecution, {
      items,
      turn: { id: "turn", status: "inProgress" },
      project,
      threadId: "thread",
      renderItem: (item) => createElement("span", null, item.id),
    }),
  );

const groups = (items: Data[]) => {
  const element = TurnExecution({
    items,
    turn: { id: "turn", status: "completed" },
    project,
    threadId: "thread",
    renderItem: (item) => createElement("span", null, item.id),
  });
  return element?.props.children.filter(Boolean) ?? [];
};

describe("TurnExecution reading identity", () => {
  it("restores ancestor activity and reasoning disclosure choices on remount", () => {
    const readingKey = "remounted-execution";
    rememberDisclosure(JSON.stringify([readingKey, "tools:start", "activity"]), true);
    rememberDisclosure(JSON.stringify([readingKey, "reasoning:r", "activity"]), false);
    rememberDisclosure(JSON.stringify([readingKey, "reasoning:r"]), true);
    const markup = renderToStaticMarkup(
      createElement(TurnExecution, {
        items: [read("a"), read("b"), { id: "r", type: "reasoning", summary: ["retained reason"] }],
        turn: { id: "turn", status: "completed" },
        project,
        threadId: "thread",
        readingKey,
        renderItem: (item) => createElement("span", null, item.id),
      }),
    );
    const activity = markup.match(/<button[^>]*aria-label="已探索"[^>]*>/)?.[0];
    expect(activity).toContain('aria-expanded="true"');
    expect(markup).toContain('title="思考过程 · 1 段" aria-expanded="true"');
    expect(markup).toContain("retained reason");
    expect(markup).not.toContain('reasoning-group-details reasoning-details" hidden');
  });
  it("keeps a reasoning page reload action visible while the reasoning text is collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(TurnExecution, {
        items: [
          { id: "r1", type: "reasoning", summary: ["first reason"] },
          { id: "gap", type: "historyPageGap", topologyKnown: true },
          { id: "r2", type: "reasoning", summary: ["last reason"] },
        ],
        turn: { id: "turn", status: "completed" },
        project,
        threadId: "thread",
        renderItem: (item) => createElement("button", null, `reload:${item.id}`),
      }),
    );
    expect(markup.match(/data-testid="reasoning-group"/g)).toHaveLength(1);
    expect(markup).toContain('title="思考过程 · 2 段" aria-expanded="false"');
    expect(markup).toContain("</div></div><button>reload:gap</button><div");
  });
  it("keeps the inner ActivityGroup key after its first body is evicted", () => {
    const full = [read("a"), read("b"), read("c")];
    const before = groups(full);
    const after = groups([{ ...full[0], historyOmitted: true }, ...full.slice(1)]);
    expect(after[0].key).toBe(before[0].key);
    expect(after[0].props.children.map((row: { key: string }) => row.key)).toEqual(["b", "c"]);
    expect(groups(full.slice(1))[0].key).toBe(before[0].key);
  });
  it("keeps omitted breaker identity without rendering its body", () => {
    const before = groups([
      read("a"),
      { id: "r", type: "reasoning", summary: ["reason"] },
      read("b"),
      read("c"),
    ]);
    const after = groups([
      read("a"),
      { id: "r", type: "reasoning", historyOmitted: true },
      read("b"),
      read("c"),
    ]);
    expect(after).toHaveLength(2);
    expect(after[1].key).toBe(before[2].key);
    expect(after[0].key).not.toBe(after[1].key);
  });
  it("does not infer unfinished work from an omitted body", () => {
    const markup = renderToStaticMarkup(
      createElement(TurnExecution, {
        items: [{ id: "a", type: "dynamicToolCall", historyOmitted: true }, read("b"), read("c")],
        turn: { id: "turn", status: "completed" },
        project,
        threadId: "thread",
        renderItem: (item) => createElement("span", null, item.id),
      }),
    );
    expect(markup).not.toContain('role="status"');
  });
  it("keeps a settled-agent boundary after its body is omitted", () => {
    const settled = {
      ...read("wait"),
      tool: "agent_wait",
      contentItems: [
        {
          type: "text",
          text: JSON.stringify({ threadId: "child", settled: true, status: "completed" }),
        },
      ],
    };
    const before = groups([read("a"), settled, read("b"), read("c")]);
    const after = groups([
      read("a"),
      { id: "wait", type: "dynamicToolCall", historyOmitted: true, historyActivityBreak: true },
      read("b"),
      read("c"),
    ]);
    expect(after).toHaveLength(2);
    expect(after[1].key).toBe(before[2].key);
  });
  it.each([
    ["agent_spawn", { threadId: "child" }],
    ["agent_spawn", { threadId: "workgroup:batch" }],
    ["agent_wait", { threadId: "child", settled: true, status: "completed" }],
    ["agent_wait", { threadId: "child", settled: true, status: "failed" }],
    ["agent_wait", { threadId: "child", settled: false, timedOut: true }],
  ])("keeps %s run identity through topology projection", (tool, receipt) => {
    const activity = {
      ...read("boundary"),
      tool,
      contentItems: [{ type: "text", text: JSON.stringify(receipt) }],
    };
    const [record] = pageTopology([
      {
        sourceThreadId: "thread",
        sourceTurnId: "turn",
        sourceItemId: activity.id,
        sourceTurnStatus: "completed",
        turn: { id: "turn", status: "completed" },
        item: activity,
      },
    ]);
    const before = groups([read("a"), activity, read("b"), read("c")]);
    const after = groups([
      read("a"),
      {
        id: activity.id,
        type: activity.type,
        historyOmitted: true,
        historyActivityBreak: record.activityBreak,
      },
      read("b"),
      read("c"),
    ]);
    expect(after.at(-1).key).toBe(before.at(-1).key);
  });
  it("only known topology can connect tools across a missing page", () => {
    const known = groups([
      read("a"),
      { id: "gap", type: "historyPageGap", topologyKnown: true },
      read("b"),
    ]);
    const unknown = groups([
      read("a"),
      { id: "gap", type: "historyPageGap", topologyKnown: false },
      read("b"),
    ]);
    expect(known).toHaveLength(1);
    expect(known[0].props.children.map((row: { key: string }) => row.key)).toEqual([
      "a",
      "gap",
      "b",
    ]);
    expect(
      unknown.filter((group: { props: { children: { key: string }[] } }) =>
        group.props.children.some((row) => row.key === "a" || row.key === "b"),
      ),
    ).toHaveLength(2);
  });
});

describe("TurnExecution groups", () => {
  it("keeps the title in past tense while the model thinks between calls", () => {
    expect(render([read("a"), read("b")])).toContain("<span>已探索</span>");
  });
  it("puts reads and commands between two messages into one group", () => {
    const markup = render([command("c"), read("a")]);
    expect(markup).toContain("<span>已探索，已运行命令</span>");
    expect(markup).toContain('data-activity-icon="search"');
    expect(markup.match(/areal-activity-group/g)).toHaveLength(1);
  });
});

describe("TurnExecution failures", () => {
  it("keeps a failed step in place instead of hiding it", () => {
    const failed = {
      id: "f",
      type: "dynamicToolCall",
      tool: "run_command",
      status: "completed",
      success: false,
      execution: { exitCode: 1 },
      arguments: { command: "pnpm test" },
      contentItems: [],
    };
    const markup = renderToStaticMarkup(
      createElement(TurnExecution, {
        items: [failed],
        turn: { id: "turn", status: "completed" },
        project,
        threadId: "thread",
        renderItem: (item) => createElement("span", null, `row:${item.id}`),
      }),
    );
    expect(markup).toContain("row:f");
  });
});
