import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TurnActivity, TurnExecution } from "./TurnExecution.js";

vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));

const project = { state: { connected: true, threads: { thread: { executionConnected: true } } } };
const command = [
  "python3 - <<'PY'",
  "import pathlib,json",
  "base=pathlib.Path('/example/Library/Application Support/areal-core')",
  "print(json.dumps(json.loads((base/'projects.json').read_text()))[:7000])",
  "PY",
].join("\n");
const turn = {
  id: "turn",
  status: "inProgress",
  items: [
    {
      id: "cmd",
      type: "dynamicToolCall",
      tool: "run_command",
      status: "inProgress",
      arguments: { command },
      contentItems: [],
    },
  ],
};

describe("TurnExecution paused presentation", () => {
  const items = [
    {
      id: "cmd",
      type: "dynamicToolCall",
      tool: "run_command",
      status: "completed",
      execution: { outcome: "unknown" },
      arguments: { command: "ls" },
      contentItems: [],
    },
  ];
  const render = (interruption: string) =>
    renderToStaticMarkup(
      createElement(TurnExecution, {
        items,
        turn: { status: "interrupted", interruption },
        project,
        threadId: "thread",
        renderItem: () => createElement("span", null, "原始工具记录"),
      }),
    );
  it("hides the extra group status after a user pause while retaining tool records", () => {
    const markup = render("userPause");
    expect(markup).not.toContain('role="status"');
    expect(markup).toContain("原始工具记录");
  });
  it("retains the unknown-result status after an unexpected interruption", () => {
    expect(render("coreRecovery")).toContain('role="status"');
  });
});

describe("TurnActivity", () => {
  it("states a running long command in one line with only its summary", () => {
    const markup = renderToStaticMarkup(
      createElement(TurnActivity, { turn, project, threadId: "thread" }),
    );
    expect(markup).toContain('data-lines="single"');
    expect(markup).toContain("正在运行命令… python3 - &lt;&lt;&#x27;PY&#x27;");
    expect(markup).not.toContain("import pathlib");
    expect(markup).not.toContain("projects.json");
  });
});

describe("TurnActivity attention states", () => {
  const render = (overrides: { project?: object; turn?: object }) =>
    renderToStaticMarkup(
      createElement(TurnActivity, {
        turn: { ...turn, ...overrides.turn },
        project: overrides.project ?? project,
        threadId: "thread",
      }),
    );
  it("marks a lost connection as needing attention", () => {
    const markup = render({
      project: { state: { connected: false, threads: { thread: { executionConnected: false } } } },
    });
    expect(markup).toContain('data-tone="attention"');
    expect(markup).toContain("连接已中断");
  });
  it("marks a model retry as needing attention", () => {
    expect(render({ turn: { modelRetry: { retry: 2, purpose: "model" } } })).toContain(
      'data-tone="attention"',
    );
  });
  it("marks an unconfirmed result as unknown", () => {
    const unknown = {
      id: "cmd",
      type: "dynamicToolCall",
      tool: "run_command",
      status: "completed",
      execution: { outcome: "unknown" },
      arguments: { command: "ls" },
      contentItems: [],
    };
    expect(render({ turn: { items: [unknown] } })).toContain('data-tone="unknown"');
  });
  it("keeps ordinary running work without an attention tone", () => {
    expect(render({})).not.toContain("data-tone");
  });
});
