import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import fixture from "../../../../../design/spec/fixtures/send-run-stop.json";
import { Composer } from "../Composer.js";
import { ConversationDraftEmptyState } from "../ConversationDraftEmptyState.js";
import { DraftComposer } from "../DraftComposer.js";
import { Messages } from "../Messages.js";
import type { Action, Data } from "../services.js";
import { useAppearance } from "../settings/applicationPreferences.js";
import { SpecNavigation } from "./SpecNavigation.js";
import { pluginAction } from "./specPlugins.js";
import { SideChatPane } from "../SideChatPane.js";
import { settingsAction } from "./specSettings.js";
import { workspaceAction } from "./specWorkspace.js";

// design/spec 的复现入口：?spec&state=<flow 状态>&theme=light|dark。示例数据只在这里翻译成本仓库的数据形状。
type Conversation = (typeof fixture.conversations)[keyof typeof fixture.conversations];
type FixtureTurn = Conversation["turns"][number] & { answer?: string };

const projectId = "spec-project";
const threadId = "spec-thread";
const STATUS: Record<string, string> = {
  running: "inProgress",
  completed: "completed",
  stopped: "interrupted",
};

function turn(source: FixtureTurn, index: number): Data {
  const items: Data[] = [
    {
      id: `user-${index}`,
      type: "userMessage",
      createdAt: 1793692800 + index,
      content: [{ type: "text", text: source.user }],
    },
    ...source.process.map((text, step) => ({
      id: `step-${index}-${step}`,
      type: "agentMessage",
      phase: "commentary",
      text,
    })),
  ];
  if (source.answer)
    items.push({
      id: `answer-${index}`,
      type: "agentMessage",
      phase: "final_answer",
      text: source.answer,
    });
  return {
    id: `turn-${index}`,
    status: STATUS[source.status],
    ...(source.status === "stopped" ? { interruption: "userPause" } : {}),
    items,
  };
}

type Decision = {
  kind: string;
  title: string;
  source?: string;
  target?: string;
  command?: string;
  options?: string[];
};

function interaction(decision: Decision): Data {
  const base = { status: "pending", threadId, requestId: "spec-request" };
  return decision.kind === "approval"
    ? {
        ...base,
        kind: "approval",
        tool: "shell",
        reason: decision.title,
        effectiveArguments: { command: decision.command, cwd: decision.target },
      }
    : {
        ...base,
        kind: "userInput",
        questions: [{ id: "spec-question", title: decision.title, options: decision.options }],
      };
}

function project(turns: Data[], queue: string[], decision?: Decision): Data {
  const thread = { id: threadId, title: "", turns };
  return {
    id: projectId,
    root: `/${fixture.project.name}`,
    name: fixture.project.name,
    core: { instanceId: "spec", connectionGeneration: 1, features: { permissionPresets: true } },
    pending: [],
    outcomes: {},
    profiles: [],
    models: [
      {
        providerId: "spec",
        providerRevision: 1,
        isDefault: true,
        modelId: "model",
        available: true,
        displayName: fixture.project.model,
      },
    ],
    configurations: {
      [threadId]: {
        revision: 0,
        model: { providerId: "spec", modelId: "model" },
        options: {},
        parameters: {},
      },
    },
    state: {
      connected: true,
      threads: { [threadId]: thread },
      interactions: { [threadId]: { data: decision ? [interaction(decision)] : [] } },
      queues: {
        [threadId]: {
          revision: 0,
          items: queue.map((text, index) => ({
            id: `queued-${index}`,
            status: "pending",
            input: [{ type: "text", text }],
          })),
        },
      },
    },
  };
}

const currentTitle = fixture.navigation.projects
  .flatMap((project) => project.threads)
  .find((thread) => thread.id === threadId)?.title;
// 示例状态里“某个浮层已打开”：按读屏名找到触发控件，像用户一样打开。
type Step = { name: string; how: "press" | "hover" | "right" | "type"; text?: string };
const OVERLAYS: Record<string, Step[]> = {
  "task-menu": [{ name: `任务操作 ${currentTitle}`, how: "press" }],
  "organize-menu": [
    { name: "侧栏整理", how: "press" },
    { name: "项目内任务排序", how: "right" },
  ],
  rename: [
    { name: `任务操作 ${currentTitle}`, how: "press" },
    { name: "重命名", how: "press" },
  ],
  "send-tooltip": [{ name: "发送", how: "hover" }],
  "theme-select": [{ name: "界面主题", how: "press" }],
  "panel-add-menu": [{ name: "打开侧边面板标签页", how: "press" }],
  "review-scope-menu": [{ name: "改动范围", how: "press" }],
  "review-files": [{ name: "显示文件", how: "press" }],
  "tasks-new": [{ name: "新建定时任务", how: "press" }],
};

async function openOverlay(steps: Step[], cancelled: () => boolean) {
  for (const step of steps) {
    let target: HTMLElement | undefined;
    for (let attempt = 0; attempt < 100 && !target && !cancelled(); attempt++) {
      target = [...document.querySelectorAll<HTMLElement>("button, input, [role=menuitem]")].find(
        (element) =>
          element.getAttribute("aria-label") === step.name ||
          (element.getAttribute("role") === "menuitem" &&
            element.textContent?.trim() === step.name),
      );
      if (!target) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!target) return;
    const element = target;
    const pointer = (type: string) =>
      element.dispatchEvent(
        new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          pointerType: "mouse",
        } as PointerEventInit),
      );
    if (step.how === "press")
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
        pointer(type);
    if (step.how === "hover")
      for (const type of [
        "pointerover",
        "pointerenter",
        "mouseover",
        "mouseenter",
        "pointermove",
        "mousemove",
      ])
        pointer(type);
    if (step.how === "type" && element instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        element,
        step.text,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (step.how === "right") {
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

// 示例数据只给改前改后全文；这里拼出 Git 风格补丁（共同前缀之后整段替换）。
function patch(file: { path: string; status: string; before: string; after: string }) {
  const before = file.before ? file.before.replace(/\n$/, "").split("\n") : [];
  const after = file.after.replace(/\n$/, "").split("\n");
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same++;
  const removed = before.slice(same);
  const added = after.slice(same);
  const header =
    file.status === "added"
      ? `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n`
      : `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n`;
  const hunk = `@@ -${before.length ? 1 : 0},${before.length} +1,${after.length} @@\n`;
  const body = [
    ...before.slice(0, same).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return {
    text: `${header}${hunk}${body}\n`,
    file: {
      path: file.path,
      additions: added.length,
      deletions: removed.length,
      binary: false,
      beforeText: file.before,
      afterText: file.after,
    },
  };
}

function review(turnId: string) {
  const patches = fixture.review.files.map(patch);
  return {
    turnId,
    token: "spec-review",
    head: "spec-head",
    base: "spec-base",
    root: `/${fixture.project.name}`,
    diff: patches.map((item) => item.text).join(""),
    files: patches.map((item) => item.file),
  };
}

export function SpecFixture() {
  const params = new URLSearchParams(window.location.search);
  const dark = params.get("theme") === "dark";
  const start =
    fixture.states[(params.get("state") ?? "home.empty") as keyof typeof fixture.states] ??
    fixture.states["home.empty"];
  const initial =
    "conversation" in start
      ? fixture.conversations[start.conversation as keyof typeof fixture.conversations]
      : undefined;
  useState(() => {
    if (start.draft) localStorage.setItem(`areal-gui:draft:${projectId}:new`, start.draft);
  });
  const [opened, setOpened] = useState(start.screen !== "home");
  const [turns, setTurns] = useState<Data[]>(() => (initial?.turns ?? []).map(turn));
  const [queue, setQueue] = useState<string[]>(() => ("queue" in start ? start.queue : []));
  const [decision, setDecision] = useState<Decision | undefined>(() =>
    initial && "decision" in initial ? (initial.decision as Decision) : undefined,
  );
  useAppearance(dark);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("theme-areal-light", !dark);
    root.classList.toggle("theme-areal-dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);
  const overlay = useMemo(
    () =>
      "settingsSearch" in start
        ? [{ name: "搜索设置", how: "type" as const, text: start.settingsSearch }]
        : "overlay" in start
          ? OVERLAYS[start.overlay as string]
          : undefined,
    [start],
  );
  // 打开浮层要等真实控件挂载，再像用户一样操作。
  useEffect(() => {
    if (!overlay) return;
    let cancelled = false;
    void openOverlay(overlay, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [overlay]);
  const data = useMemo(() => project(turns, queue, decision), [turns, queue, decision]);
  const thread = data.state.threads[threadId];
  const action = (async (name: string, request: Data) => {
    const reject = (fixture.agent.rejects as Record<string, string>)[request?.text?.trim()];
    if (reject && (name === "send" || name === "create")) throw new Error(reject);
    if (name === "create") return { threadId };
    if (name === "send" && request.enqueue) {
      setQueue((items) => [...items, request.text]);
      return { threadId };
    }
    if (name === "send" || name === "continue") {
      setTurns((items) => [
        ...items,
        turn(
          {
            status: "running",
            user: name === "send" ? request.text : (items.at(-1)?.items[0].content[0].text ?? ""),
            process: [fixture.agent.firstStep],
          },
          items.length,
        ),
      ]);
      return { threadId };
    }
    if (name === "respond") {
      const { allow, deny, answer } = fixture.agent.decisions;
      const text = request.answers
        ? answer.replace("{answer}", String(Object.values(request.answers)[0]))
        : request.decision === "deny"
          ? deny
          : allow;
      setDecision(undefined);
      setTurns((items) =>
        items.map((item) =>
          item.status === "inProgress"
            ? {
                ...item,
                items: [
                  ...item.items,
                  {
                    id: `step-${item.items.length}`,
                    type: "agentMessage",
                    phase: "commentary",
                    text,
                  },
                ],
              }
            : item,
        ),
      );
      return {};
    }
    if (name === "stop") {
      setTurns((items) =>
        items.map((item) =>
          item.status === "inProgress"
            ? { ...item, status: "interrupted", interruption: "userPause" }
            : item,
        ),
      );
      return {};
    }
    if (name === "manage" && request.operation === "context") {
      const { usedTokens, windowTokens } = fixture.project.context;
      const basis = {
        provider: "spec",
        model: "model",
        configurationRevision: 0,
        defaultModelRevision: null,
        turnId: null,
      };
      return {
        threadId,
        contextUsage: {
          kind: "ready",
          basis,
          budget: {
            windowTokens,
            outputReserveTokens: 0,
            inputLimitTokens: windowTokens,
            windowSource: "model",
          },
          scope: { kind: "recordedHistory" },
          estimate: {
            tokens: usedTokens,
            parts: [{ kind: "conversation", name: "对话", estimatedTokens: usedTokens }],
          },
        },
        sessionUsage: {
          usage: null,
          generation: {
            outputTokens: 0,
            durationMs: 0,
            measuredRequests: 0,
            unmeasuredRequests: 0,
            usageRequests: 0,
            missingUsageRequests: 0,
          },
          knownTurns: 0,
          unknownTurns: 0,
          partialTurns: 0,
          scope: "ownTurns",
        },
      };
    }
    if (name === "workspace" && request.operation === "turnReview") return review(request.turnId);
    if (name === "workspace" && request.operation === "review") return review("");
    if (name === "workspace" && request.operation === "reviewCommits")
      return { commits: [], truncated: false };
    if (name === "workspace" && request.operation === "reviewBranches") return { branches: [] };
    if (name === "manage" && pluginAction(request)) return pluginAction(request);
    if (name === "reconcile") return { outcomes: {} };
    if (name === "queue") return data.state.queues[threadId];
    if (name === "tasks")
      return {
        projectId: request.projectId,
        requestId: request.requestId,
        viewEpoch: request.viewEpoch,
        data: fixture.tasks.rows
          .filter((row) => row.projectId === request.projectId || !request.projectId)
          .map((row) => ({ ...row, mode: "scheduled", runs: [], scope: "workspace" })),
        hasMore: false,
        errors: [],
        owners: fixture.tasks.projects.map((project) => ({
          projectId: project.id,
          status: "ready",
          source: "live",
          coverage: { kind: "complete" },
          readAt: 0,
          connectionGeneration: 1,
        })),
      };
    return settingsAction(name, request) ?? workspaceAction(name, request) ?? {};
  }) as Action;
  const column = (
    <div className="conversation-column">
      <section className={`conversation-pane ${opened ? "" : "draft-pane"}`}>
        {opened ? (
          <>
            <Messages
              project={data}
              thread={thread}
              action={action}
              dark={dark}
              decisionShown
              readTurnReview={async () => ({})}
              onLink={() => {}}
              onFile={() => {}}
              onReview={() => {}}
            />
            <div className="active-composer">
              <Composer
                project={data}
                thread={thread}
                action={action}
                readAction={action}
                executionBlocked={false}
                onPanel={() => {}}
                onNew={() => {}}
              />
            </div>
          </>
        ) : (
          <>
            <div className="draft-greeting">
              <ConversationDraftEmptyState projectName={fixture.project.name} />
            </div>
            <div className="draft-composer">
              <DraftComposer
                project={data}
                action={action}
                readAction={action}
                backendReady
                modelCatalogReady
                onOpen={async () => setOpened(true)}
                onPanel={() => {}}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
  return start.screen === "window" ? (
    <SpecNavigation
      collapsed={"collapsed" in start ? start.collapsed : []}
      search={"search" in start ? start.search : undefined}
      rail={"rail" in start ? start.rail : false}
      settings={"settings" in start ? start.settings : undefined}
      panel={"panel" in start ? (start.panel as never) : undefined}
      surface={"surface" in start ? (start.surface as "tasks" | "plugins") : undefined}
      action={action}
      renderPanel={(name, { show }) =>
        name === "旁路讨论" ? (
          <SideChatPane
            project={data}
            source={thread}
            executionBlocked={false}
            action={action}
            dark={dark}
            onPanel={show}
          />
        ) : null
      }
    >
      <div className="workspace-content">{column}</div>
    </SpecNavigation>
  ) : (
    <div className="workspace-content" data-spec-fixture style={{ height: "100dvh" }}>
      {column}
    </div>
  );
}
